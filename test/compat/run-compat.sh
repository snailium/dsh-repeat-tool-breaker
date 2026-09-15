#!/usr/bin/env bash
# Compatibility check: boot a REAL dsh of a given version with this plugin
# installed as a profile bundle, drive it with a scripted mock model, and assert
# that the guard fired in the real pipeline.
#
# No GPU and no real model are needed: test/compat/mock-llm.py speaks enough of
# the OpenAI streaming protocol to make the agent issue the SAME bash call
# MOCK_REPEATS times in a row.
#
# Usage:
#   # 1. install the dsh version under test somewhere isolated
#   DSH_PREFIX=/home/gwang/.rtb-compat
#   mkdir -p "$DSH_PREFIX" && cd "$DSH_PREFIX" && npm init -y
#   npm install --no-audit --no-fund @deepseek-ai/dsh@<version>
#
#   # 2. run the check
#   DSH_PREFIX=$DSH_PREFIX ./test/compat/run-compat.sh
#
# Environment:
#   DSH_PREFIX   npm prefix holding node_modules/@deepseek-ai/dsh (default: /home/gwang/.rtb-compat)
#   DSH_BIN      dsh executable (default: $DSH_PREFIX/node_modules/.bin/dsh)
#   COMPAT_HOME  throwaway DSH_HOME (default: $DSH_PREFIX/home)
#   MOCK_PORT    port for the mock model (default: 18999)
#   MOCK_REPEATS how many identical calls the scripted model issues (default: 4)
#   PLUGIN_SPEC  what to install into the profile (default: this checkout's path)
#
# Exits non-zero if the bundle does not mount or the trajectory is not
# "attempts 1..cap-1 executed, attempts cap.. denied".
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$HERE/../.." && pwd)
DSH_PREFIX=${DSH_PREFIX:-/home/gwang/.rtb-compat}
DSH_BIN=${DSH_BIN:-$DSH_PREFIX/node_modules/.bin/dsh}
COMPAT_HOME=${COMPAT_HOME:-$DSH_PREFIX/home}
MOCK_PORT=${MOCK_PORT:-18999}
MOCK_REPEATS=${MOCK_REPEATS:-4}
PLUGIN_SPEC=${PLUGIN_SPEC:-$PLUGIN_DIR}
ENDPOINT="http://127.0.0.1:${MOCK_PORT}/v1"

LOG=$(mktemp -d)/compat.log

cleanup() { [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

MOCK_REPEATS="$MOCK_REPEATS" python3 "$HERE/mock-llm.py" "$MOCK_PORT" > "$LOG" 2>&1 &
MOCK_PID=$!
sleep 2
if ! curl -sf -o /dev/null "${ENDPOINT}/models"; then
  echo "FAIL: the mock model did not start on ${ENDPOINT} (see $LOG)" >&2
  cat "$LOG" >&2
  exit 1
fi

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
echo "ok"

CAP=$(node --input-type=module -e "
  const m = await import('$COMPAT_HOME/profiles/probe/node_modules/dsh-repeat-tool-breaker/lib/defaults.js')
  process.stdout.write(String(m.DEFAULTS.limits.exact))
")
echo "=== cap for action identity: $CAP (mock issues $MOCK_REPEATS identical calls) ==="

echo "=== real headless run ==="
rm -rf "$COMPAT_HOME/sessions"
DSH_HOME="$COMPAT_HOME" MOCK_API_KEY=mock timeout 600 "$DSH_BIN" --profile probe "compat check" 2>&1 | tail -5

echo "=== trajectory ==="
COMPAT_HOME="$COMPAT_HOME" CAP="$CAP" MOCK_REPEATS="$MOCK_REPEATS" python3 - <<'PY'
import glob, json, os, subprocess, sys

home = os.environ['COMPAT_HOME']
cap = int(os.environ['CAP'])
repeats = int(os.environ['MOCK_REPEATS'])

files = glob.glob(f'{home}/sessions/**/session*.jsonl.zstd', recursive=True)
if not files:
    sys.exit('FAIL: no session was written')

calls, results = [], []
for path in files:
    raw = subprocess.run(['zstd', '-dc', path], capture_output=True, text=True).stdout
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get('type') == 'tool/call':
            calls.append(event['data'].get('name'))
        elif event.get('type') == 'tool/result':
            for block in event['data']['message'].get('content', []):
                if block.get('type') == 'tool-result':
                    text = '\n'.join(x.get('text', '') for x in block.get('content', []) if isinstance(x, dict))
                    results.append((bool(block.get('isError')), text))

for i, (is_error, text) in enumerate(results, start=1):
    print(f'  attempt {i}: isError={is_error} | {text.splitlines()[0][:100]}')

if len(results) != repeats:
    sys.exit(f'FAIL: expected {repeats} tool results, saw {len(results)}')

executed = [r for r in results if not r[0]]
denied = [r for r in results if r[0]]
if len(executed) != cap - 1:
    sys.exit(f'FAIL: expected {cap - 1} executed attempts, saw {len(executed)}')
if len(denied) != repeats - (cap - 1):
    sys.exit(f'FAIL: expected {repeats - cap + 1} denied attempts, saw {len(denied)}')
for _, text in denied:
    if 'REPEAT_TOOL_BLOCKED' not in text:
        sys.exit(f'FAIL: a denied attempt did not carry the denial text: {text[:200]!r}')
print(f'\nCOMPAT: PASS ({cap - 1} executed, {len(denied)} denied, cap={cap})')
PY
