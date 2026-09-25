#!/usr/bin/env bash
# Compatibility + behaviour check: boot a REAL dsh of a given version with this
# plugin installed as a profile bundle, drive it with a scripted mock model, and
# assert the resulting trajectory.
#
# No GPU and no real model are needed: test/compat/mock-llm.py speaks enough of
# the OpenAI streaming protocol to script the agent's tool calls.
#
# Two scenarios:
#   1. the same `bash` call repeated REPEATS times — the action-identity cap must
#      deny everything after the first CAP-1 attempts;
#   2. a LOCAL-ADDRESS loop (a different path each turn, so only `site:127.0.0.1`
#      accumulates). There is no answerer in this profile, so the default
#      `localHosts: ask` must degrade to a DENIAL — and must not hang.
#
# Usage:
#   DSH_PREFIX=/tmp/dsh-compat
#   mkdir -p "$DSH_PREFIX" && cd "$DSH_PREFIX" && npm init -y
#   npm install --no-audit --no-fund @deepseek-ai/dsh@<version>
#   DSH_PREFIX=$DSH_PREFIX ./test/compat/run-compat.sh
#
# Environment:
#   DSH_PREFIX   npm prefix holding node_modules/@deepseek-ai/dsh
#                (default: .rtb-compat beside this repo)
#   DSH_BIN      dsh executable (default: $DSH_PREFIX/node_modules/.bin/dsh)
#   COMPAT_HOME  throwaway DSH_HOME (default: $DSH_PREFIX/home)
#   MOCK_PORT    port for the mock model (default: 18999)
#   MOCK_REPEATS identical calls in scenario 1 (default: 4)
#   PLUGIN_SPEC  what to install into the profile (default: this checkout's path)
#
# Exits non-zero on the first failed assertion.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$HERE/../.." && pwd)
# The dsh-under-test install lives in a throwaway prefix BESIDE this repo, so a
# ~300 MB node_modules tree never lands inside the working tree and `git status`
# stays clean. Point DSH_PREFIX somewhere else to reuse or replace it.
DSH_PREFIX=${DSH_PREFIX:-$(cd "$PLUGIN_DIR/.." && pwd)/.rtb-compat}
DSH_BIN=${DSH_BIN:-$DSH_PREFIX/node_modules/.bin/dsh}
COMPAT_HOME=${COMPAT_HOME:-$DSH_PREFIX/home}
MOCK_PORT=${MOCK_PORT:-18999}
# Scenario 1's repeat count is derived from the cap further down, once the plugin's
# own defaults have been read — see `MOCK_REPEATS=${MOCK_REPEATS:-$((CAP - 1))}`.
PLUGIN_SPEC=${PLUGIN_SPEC:-$PLUGIN_DIR}
ENDPOINT="http://127.0.0.1:${MOCK_PORT}/v1"

# Stable path on purpose: a `mktemp -d` log is gone by the time anyone asks why a
# scenario failed, and "the mock died mid-run" is the one failure this file explains.
LOG=${COMPAT_LOG:-$DSH_PREFIX/compat-mock.log}
MOCK_PID=''

cleanup() { [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

start_mock() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
  # shellcheck disable=SC2086
  env "$@" python3 "$HERE/mock-llm.py" "$MOCK_PORT" > "$LOG" 2>&1 &
  MOCK_PID=$!
  sleep 2
  if ! curl -sf -o /dev/null "${ENDPOINT}/models"; then
    echo "FAIL: the mock model did not start on ${ENDPOINT} (see $LOG)" >&2
    cat "$LOG" >&2
    exit 1
  fi
}

# $1 label, $2 expected executed count, $3 expected total; rest: mock env pairs
run_scenario() {
  local label=$1 expected_executed=$2 expected_total=$3
  shift 3
  start_mock "$@"
  echo "=== $label ==="
  rm -rf "$COMPAT_HOME/sessions"
  DSH_HOME="$COMPAT_HOME" MOCK_API_KEY=mock timeout 600 "$DSH_BIN" --profile probe "compat check" 2>&1 | tail -3
  COMPAT_HOME="$COMPAT_HOME" EXPECT_EXECUTED="$expected_executed" EXPECT_TOTAL="$expected_total" \
    LABEL="$label" EXPECT_ADVISORY="${EXPECT_ADVISORY:-}" EXPECT_DENIAL="${EXPECT_DENIAL:-}" \
    MOCK_LOG="$LOG" python3 - <<'PY'
import glob, json, os, subprocess, sys

home = os.environ['COMPAT_HOME']
expected_executed = int(os.environ['EXPECT_EXECUTED'])
expected_total = int(os.environ['EXPECT_TOTAL'])

files = glob.glob(f'{home}/sessions/**/session*.jsonl.zstd', recursive=True)
if not files:
    sys.exit('FAIL: no session was written')

results = []
whole_log = ''
for path in files:
    raw = subprocess.run(['zstd', '-dc', path], capture_output=True, text=True).stdout
    whole_log += raw
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get('type') != 'tool/result':
            continue
        message = event['data']['message']
        # The payload shape MOVED in session format 4 (dsh 0.1.7):
        #   v3  message.content[] -> {type:'tool-result', isError, content:[{type:'text'}]}
        #   v4  the message IS the result: {role:'tool', toolCallId, isError, content:[{type:'text'}]}
        # Accepting only the nested shape silently yielded ZERO results on 0.1.7 while the
        # run itself was fine, and the failure then read as if the plugin had hung.
        blocks = [b for b in message.get('content', []) if b.get('type') == 'tool-result']
        if blocks:
            for block in blocks:
                text = '\n'.join(x.get('text', '') for x in block.get('content', []) if isinstance(x, dict))
                results.append((bool(block.get('isError')), text))
        elif message.get('role') == 'tool':
            text = '\n'.join(x.get('text', '') for x in message.get('content', []) if isinstance(x, dict))
            results.append((bool(message.get('isError')), text))

for i, (is_error, text) in enumerate(results, start=1):
    print(f'  attempt {i}: isError={is_error} | {text.splitlines()[0][:90]}')

if len(results) != expected_total:
    mock_log = os.environ.get('MOCK_LOG', '')
    provider_failures = whole_log.count('"TRANSPORT"') + whole_log.count('"kind":"error"')
    if provider_failures:
        why = (f'{provider_failures} provider failure(s) are recorded in the session, so no tool '
               f'call could ever happen: the model endpoint was unreachable, not the plugin. '
               f'Mock log: {mock_log}')
    else:
        why = f'no provider failure was recorded, so the run died before issuing calls. Mock log: {mock_log}'
    sys.exit(f'FAIL: expected {expected_total} tool results, saw {len(results)}.\n  {why}')
executed = [r for r in results if not r[0]]
denied = [r for r in results if r[0]]
if len(executed) != expected_executed:
    sys.exit(f'FAIL: expected {expected_executed} executed attempts, saw {len(executed)}')
if len(denied) != expected_total - expected_executed:
    sys.exit(f'FAIL: expected {expected_total - expected_executed} denied attempts, saw {len(denied)}')
denial = os.environ.get('EXPECT_DENIAL', '')
if denial:
    if denial not in whole_log:
        sys.exit(f'FAIL: the denial text {denial!r} never reached the model')
    print(f'  -> denial carried: {denial!r}')

advisory = os.environ.get('EXPECT_ADVISORY', '')
if advisory:
    # The advisory is a plugin notice: it reaches the model as its own user-role
    # message (`source.kind: 'plugin'`), not inside the tool result text. Search the
    # whole log rather than the results.
    if advisory not in whole_log:
        sys.exit(f'FAIL: the session never carried the expected advisory {advisory!r}')
    print(f'  -> advisory delivered: {advisory!r}')

# Both markers are the breaker's own: the escalation gate's repeat denial and the
# shell HTTP block's refusal. Either means the model was told WHY it was stopped.
markers = ('REPEAT_TOOL_BLOCKED', 'SHELL_HTTP_BLOCKED')
breaker = [t for _, t in denied if any(m in t for m in markers)]
if denied and not breaker:
    sys.exit('FAIL: no denied attempt carried the breaker\'s own message: '
             + repr([t[:120] for _, t in denied]))
print(f'  -> {len(executed)} executed, {len(denied)} denied, '
      f'{len(breaker)} with the breaker\'s own message')
PY
}

echo "=== dsh under test ==="
"$DSH_BIN" --version 2>&1 | tail -1

rm -rf "$COMPAT_HOME"
mkdir -p "$COMPAT_HOME/profiles/probe"
cat > "$COMPAT_HOME/settings.yaml" <<YAML
llm-pi-ai:
  providers:
    mock:
      apiKeyEnv: MOCK_API_KEY
      api: openai-completions
      baseURL: ${ENDPOINT}
      models:
        - id: mock-model
          contextWindow: 65536
          maxTokens: 4096
          input: [ text ]
agent-default-model: { provider: mock, model: mock-model }
YAML

# The plugin is mounted the way a user would: as a bundle, so its own
# cordis.patch.yml provides the row (this also exercises the dsh.bundle path).
cat > "$COMPAT_HOME/profiles/probe/package.json" <<'JSON'
{
  "name": "dsh-profile-probe",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-repeat-tool-breaker"]
    }
  }
}
JSON

cat > "$COMPAT_HOME/profiles/probe/cordis.patch.yml" <<'YAML'
- id: agent-default-model
  config:
    provider: mock
    model: mock-model
YAML

( cd "$COMPAT_HOME/profiles/probe" && npm install --no-audit --no-fund --loglevel=error "$PLUGIN_SPEC" >/dev/null )

echo "=== bundle mounts? ==="
if ! DSH_HOME="$COMPAT_HOME" "$DSH_BIN" --profile probe --dump-config 2>&1 | grep -q "dsh-repeat-tool-breaker"; then
  echo "FAIL: the bundle did not mount" >&2
  exit 1
fi
echo ok

# NB: capture into a variable rather than `read` — the node one-liner writes no
# trailing newline, and `read` reports EOF (non-zero) for an unterminated line,
# which `set -e` turns into an exit.
DEFAULTS=$(node --input-type=module -e "
  const m = await import('$COMPAT_HOME/profiles/probe/node_modules/dsh-repeat-tool-breaker/lib/defaults.js')
  process.stdout.write(String(m.DEFAULTS.limits.exact) + ' ' + m.DEFAULTS.localHosts)
")
CAP=${DEFAULTS% *}
POLICY=${DEFAULTS#* }
# Scenario 1 must make MORE than CAP identical calls, so the cap-th and everything
# after it is actually DENIED. This used to default to CAP-1 — exactly the number of
# allowed attempts — which meant the scenario exercised only the allow path while its
# header comment claimed it denied everything after CAP-1. Deriving both numbers from
# the cap is what makes the harness survive a retune.
MOCK_REPEATS=${MOCK_REPEATS:-$((CAP + 1))}
echo "=== shipped defaults under test: cap=$CAP localHosts=$POLICY ==="

# Scenario 1 — identical repeats: attempts 1..cap-1 run, the rest are denied.
run_scenario "identical repeats (cap $CAP)" "$((CAP - 1))" "$MOCK_REPEATS" \
  MOCK_REPEATS="$MOCK_REPEATS"

# Scenario 2 — a local-address loop with NO answerer. The same path every turn
# with a different command, so `net:` accumulates while `exact:`/`cmd:` do not;
# the cap-th call trips it and, with nobody to ask, `ask` must deny rather than
# stall.
run_scenario "local loop on one path, no answerer (localHosts=$POLICY)" "$((CAP - 1))" "$((CAP + 2))" \
  MOCK_REPEATS="$((CAP + 2))" MOCK_LOCAL_PATH=/health

# Scenario 3 — PAGINATION. Different pages of one endpoint are different
# resources, so nothing may be blocked however many pages are fetched. This is
# the regression test for the 0.3.2 fix: `net:` used to discard the query, which
# merged every page into one resource.
run_scenario "pagination of one endpoint (must never block)" 8 8 \
  MOCK_REPEATS=8 MOCK_PAGE_BASE=http://127.0.0.1:9/repos/o/r/commits

echo

# Scenario 4 — the FAILURE track. The same command fails every turn; the failure
# gate must stop it after `failLimit` consecutive failures, which is well before
# the occurrence cap. `|| true` is deliberately NOT used: here the failure IS the
# subject.
FAIL_WARN=$(node --input-type=module -e "
  const m = await import('$COMPAT_HOME/profiles/probe/node_modules/dsh-repeat-tool-breaker/lib/defaults.js')
  process.stdout.write(String(m.DEFAULTS.failWarnAt))
")
FAIL_LIMIT=$(node --input-type=module -e "
  const m = await import('$COMPAT_HOME/profiles/probe/node_modules/dsh-repeat-tool-breaker/lib/defaults.js')
  process.stdout.write(String(m.DEFAULTS.failLimit))
")
echo "=== failure track: warn at $FAIL_WARN, block after $FAIL_LIMIT ==="
EXPECT_ADVISORY="has failed $FAIL_WARN times in a row" \
  run_scenario "consecutive failures (limit $FAIL_LIMIT)" "$FAIL_LIMIT" "$((FAIL_LIMIT + 3))" \
  MOCK_REPEATS="$((FAIL_LIMIT + 3))" \
  MOCK_COMMAND="curl -s --max-time 3 http://127.0.0.1:9/missing-endpoint"


# Scenario 5 — the SHELL HTTP BLOCK. A remote fetch from the shell is refused on the
# first call, never asks, and the denial tells the model what to use instead. The URL
# is remote on purpose: local addresses are exempt (the fetch tool inherits the SSRF
# guard and cannot reach them).
echo "=== shell HTTP block (remote fetch refused, tool named) ==="
EXPECT_DENIAL="SHELL_HTTP_BLOCKED" \
  run_scenario "remote curl is refused" 0 2 \
  MOCK_REPEATS=2 MOCK_COMMAND="curl -s https://weather.gc.ca/historical_data/search_historic_data_e.html"

echo "COMPAT: PASS"
