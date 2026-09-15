# dsh-repeat-tool-breaker

[![CI](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-repeat-tool-breaker.svg)](https://www.npmjs.com/package/dsh-repeat-tool-breaker)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Hard break on an agent's repeated tool calls. A local, dependency-free
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
that registers one synchronous gate on the public `ctx.tools.guard` API: when a
call repeats an action already seen inside the agent's sliding window, the call
is **denied before it executes** and the model gets an `isError` result starting
with `REPEAT_TOOL_BLOCKED` that quotes the previous result and says what to do
instead.

In one paragraph, the v1 → v2 story:

> **v1 lost** because it counted *byte-identical consecutive* calls while the
> model varied a presentation field (`description: '1st'|'2nd'|'3rd'`, churning
> `timeoutMs`) and ping-ponged between host spellings
> (`open-data.canada.ca` ↔ `open.canada.ca`) with a different `--max-time` each
> time — every call looked new, so the counter never advanced.
> **v2 wins** by deleting decoy arguments before any fingerprint is built, then
> counting *semantic* fingerprints (`net:`, `site:`, `sink:`, `cmd:`, `exact:`,
> `family:`, `verb:`) over a per-agent window of the last 12 calls, so a repeat
> has to change the actual resource — not its spelling — to pass.

## The three loops, and what catches each

| | Loop | Caught by |
|---|---|---|
| **A** | the same `read`/`write`/`bash` arguments again, verbatim | `exact:` (3) |
| **B** | `description: '1st'/'2nd'/'3rd'`, `command` unchanged | decoy arguments are stripped **before** fingerprinting, so the calls become byte-identical → `exact:` (3) |
| **C** | `curl --max-time 60 open-data.canada.ca` ↔ `curl --max-time 30 open.canada.ca` | `net:` (3) after host-alias folding and query stripping, plus `sink:` (3) and `cmd:` (3) after volatile-flag stripping |

The sibling official plugin `@deepseek-ai/dsh-repeat-tool-reminder` (advisory, at
3/5/8 repeats) may stay on — this breaker refuses earlier, so the two compose:
the breaker is the hard gate, the reminder is the soft nudge.

## Requirements

- Node.js **>= 20** (developed and tested on 22).
- A DSH profile that exposes the `tools` service. Built and verified against
  **`@deepseek-ai/dsh` 0.1.2-rc.1**.
- No runtime dependencies — the plugin imports only its own `lib/` modules (no
  `cordis`, no schemastery), so it can be mounted straight from a path.

## Install

### Option A — list it as a profile bundle (recommended)

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so
it is a first-class profile bundle: no hand-written mount row is needed.

```bash
dsh plugin --profile <name> add dsh-repeat-tool-breaker
```

Then add it to the profile's ordered bundle list
(`$DSH_HOME/profiles/<name>/package.json`):

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-repeat-tool-breaker"
    ]
  }
}
```

The bundle's patch layer mounts the plugin with **no `config:`**, so the
fail-loud `DEFAULTS` really are the defaults. To tune it, reconfigure the row by
id from the *profile's own* `cordis.patch.yml` — remember a patch replaces the
targeted row's whole `config` instead of merging into it, so restate every field
you want (see [Configuration](#configuration)).

Naming a bundle-less package in `dsh.profile.bundles` is a **hard boot error**
(`declares no dsh.bundle in its package.json`), which is why the manifest above
is required for this path.

### Option B — mount from a path (dev loop, no install)

Clone this repo and add an `insert` entry to a profile (see
[Configuration](#configuration) for the full snippet), then boot with the
overlay:

```bash
git clone https://github.com/snailium/dsh-repeat-tool-breaker.git
```

```bash
dsh --profile <name> --patch /path/to/overlay.yml --dump-config   # resolve check, does not boot
dsh --profile <name> --patch /path/to/overlay.yml "reply ok"      # real apply run
```

Here `name` must be an **absolute path** to this checkout's `index.js`, because
the package is not resolvable from the profile directory.

### Option C — install from npm, mount by hand

```bash
dsh plugin --profile <name> add dsh-repeat-tool-breaker
```

`dsh plugin add` forwards to the profile's package manager, so the plugin becomes
a normal profile dependency and its `name` resolves to the package specifier
`dsh-repeat-tool-breaker` from a hand-written `insert` row. The `files`/`exports`
entries in `package.json` control what ships.

## How it stops a loop

Tool dispatch on the DeepSeek Harness runs:

```
tool/call
  → tools/pre-execute      (allow / deny / ask)
  → tools/guard()          ← THIS plugin's gate
  → tools/execute          (the real tool body)
  → tools/post-execute
  → tools/result
```

Returning a `string` from a guard is a **final, monotonic denial**: it cannot be
re-allowed by listener ordering, and — critically — **the tool body never runs**.
That is what distinguishes a hard break from the official reminder, which only
injects a softer "you repeated X" message after the call already executed.

The guard is deliberately synchronous: no `await`, no DNS, no disk reads.

## How a call is fingerprinted

Each call contributes a *set* of fingerprints. Any one of them reaching its cap
denies the call, so dodging one (a new host spelling) still collides on another
(a new `sink:` or `cmd:`).

| Fingerprint | Built from | Catches |
|---|---|---|
| `exact:<tool>:<json>` | tool name + arguments with decoy fields deleted, keys deep-sorted | A, B |
| `cmd:<verb>:<command>` | verb + command with volatile flags (`--max-time`, `-s`, `--retry`, `timeout N`, `-sSL` clusters…) removed | C, B |
| `net:<host><path>` | `http(s)` URL with the scheme defaulted, `www.` and default ports dropped, host aliases folded, query/fragment discarded, trailing slash trimmed | C |
| `site:<last-2-labels>` | registrable-ish site of each URL (IP literals stand alone) | C, drive-by crawling |
| `sink:<path>` | `-o`/`--output`/`-O`/`>`/`>>`/`tee` target of a shell command — except generic destinations (`/dev/null`, `-`, …), which say nothing about *which* resource was fetched | C |
| `family:http-fetch` | every `curl` / `wget` / `http` / `httpie` / URL-taking tool call | a fetch loop that keeps changing everything else |
| `verb:<cmd>` | the first non-wrapper command word (`sudo`, `timeout 30`, `FOO=1` are transparent) | tool-swapping within one verb |

### Counting rules

- State is a **per-agent sliding window** (`window`, default 12 calls) held in a
  `WeakMap` keyed by the live `Agent` object — one agent's loop never trips
  another's, and subagents get their own budget.
- A call is denied when a fingerprint **already appears `limit - 1` times** in the
  window, i.e. when the current call would be the `limit`-th occurrence. The first
  occurrence of anything is therefore always allowed.
- The guard **commits on both outcomes**, but *what* it commits differs, and that
  difference is load-bearing:
  - an **allowed** call commits every fingerprint it carries — the action really
    happened, so it owns its share of the budget;
  - a **denied** call commits only the fingerprints that **hit their cap**. The
    action never ran, so it must not spend budget on a resource it never touched.
    A measured run showed the cost of getting this wrong: a denied
    `curl https://example.org` poisoned `net:example.org/`, after which the model
    could not fetch that URL through *any* tool for the rest of the turn. The
    hitting fingerprints are already at their cap, so re-attempting the blocked
    call stays blocked either way.
- A real **user message** (`agent/pre-step` with source `kind: 'user'`) clears that
  agent's window. Plugin notices and tool results do **not** — otherwise the
  breaker's own denial would reset the budget it is enforcing.
- Excluded tools (`exclude`, default `todo_write`; `*`-wildcards supported) are
  fully transparent: they neither count nor reset.

## Configuration

Mount via a profile bundle (Option A above — no `config:` in the bundle layer,
defaults apply), a `--patch` overlay, or a profile's `cordis.patch.yml`. The
plugin exports an object form (`{ name, inject: ['tools'], apply }`);
`inject: ['tools']` defers `apply` until the real `ToolRuntime` service is live,
at which point `ctx.tools.guard` is the genuine method.

```yaml
- insert:
    - id: repeat-tool-breaker
      name: dsh-repeat-tool-breaker
      config:
        window: 12                  # recent calls per agent that participate
        previewChars: 400           # truncation for quoted fingerprints
        resultPreviewChars: 800     # truncation for the quoted previous result
        exclude: [todo_write]       # never counted, never resets (*-wildcards ok)
        include: []                 # non-empty = ONLY these names/patterns count
        pathAliases: [path, file_path, filePath, file, target_file]
        ignoreArgs:                 # merged over the defaults
          '*': [description, timeoutMs, run_in_background, justification, reason, title, comment]
          bash: [description, timeoutMs, run_in_background, justification]
        hostAliases:                # merged over the defaults
          open-data.canada.ca: open.canada.ca
        limits:                     # merged over the defaults; null = uncapped
          exact: 3
          cmd: 3
          net: 3
          sink: 3
          site: 3
          'family:http-fetch': 6
          'verb:curl': 6
          'verb:wget': 6
```

Merge semantics, which matter when retuning:

- `ignoreArgs`, `hostAliases` and `limits` merge **one level deep** over the
  defaults, so you can add one host alias or retune one cap without restating the
  table.
- Scalars replace; arrays (`exclude`, `include`, `pathAliases`) **replace
  outright** — a `pathAliases:` that omits `file_path` silently disables the
  read/write path guards, because that is the key dsh's own file tools use.
- A patch replaces the targeted row's whole `config`, so `config` keys are not
  inherited from the bundle layer.

Every value is validated fail-loud in `apply`: `window >= 4`, every limit either
`null` or a finite number `>= 2` (a cap below 2 would deny the *first* call), and
preview caps `>= 1`. Config keys removed in 0.2.0 (`denyAfter`, `warnAfter`,
`registerAdvisory`, `maxSamePath`, `readTools`, `matchReadBySubstring`) throw with
a pointer at their replacement rather than being ignored, so an upgraded profile
cannot silently lose its tuning.

(The `- insert:` list is required to **add** a new plugin; a flat `- id:` entry is
a reconfig of an already-present id and fails with "entry not found" for a plugin
that isn't yet in the composed tree.)

### Tuning, and how these numbers were chosen

The table mixes *precise* caps with *broad* ones, and the difference matters:

- **precise, resource-scoped, cap 3**: `exact`, `cmd`, `net`, `sink`. These fire
  only when the same action actually happens again, and they are what catches
  loops. They are 3 rather than 2 because a cap of 2 leaves no room for the most
  common *non-loop* repeat: the first attempt fails for a reason that has nothing
  to do with looping — a precondition the harness enforces, a DNS failure — and
  the correct response is to retry the same call. At 2 that retry is what gets
  blocked, and the only way forward is to cosmetically change the call, which is
  exactly what this plugin exists to stop. At 3 the retry fits, while a call that
  keeps failing is still stopped on its third attempt.
- **not counter-based at all**: file operations. There is no `readpath` or
  `writepath` limit. A file action is identified by its **position** through
  `exact:` — the same file at the same offset, or the same replacement string, is
  the same action and is denied; a different offset or a different region is a
  different action and is never blocked. 0.2.0 shipped path-only counters for
  these and they both had to be removed after blocking ordinary work on the
  reference deployment (see [File operations](#file-operations)).
- **broad, budget-scoped, per window**: `site: 3`, `family:http-fetch: 6`,
  `verb:curl: 6`, `verb:wget: 6`. These fire on **volume**, not on
  repetition, so they are backstops for a runaway crawl — not loop detectors.

The broad caps were originally 4, and a live run on the reference deployment
showed exactly why that was wrong: an agent asked for the status codes of **four
different URLs** was blocked from the second one onwards. Raising the volume caps
fixed that; a follow-up run of the same task returned all four.

If you run research-heavy sessions, raise them further or set them to `null` for
uncapped, and keep the precise caps at 2:

```yaml
- id: repeat-tool-breaker
  config:
    limits:
      site: null
      'family:http-fetch': null
      'verb:curl': null
```

If instead you want the original, more aggressive table back, restate it:

```yaml
- id: repeat-tool-breaker
  config:
    limits:
      'family:http-fetch': 4
      'verb:curl': 4
      'verb:wget': 4
```

### Deliberate deviations from the v2 specification

All four are consequences of running the plugin against a live model on the
reference deployment; each is reversible from config alone.

1. **No path-only counter for file tools at all.** The spec folded reads and
   writes of one path into a single `sink:` counter, which denies the second half
   of the ordinary pair `read foo.ts` → `write foo.ts`. 0.2.0 replaced it with
   separate `readpath`/`writepath` counters and 0.2.2 removed both, because a
   path-only counter cannot see POSITION: it blocked re-reading a file that was
   being edited, and blocked the third iteration on a single document. File
   actions are identified by `exact:` alone, which is position-aware by
   construction. `sink:` still means what §3.6 defined it as: where a *shell
   command* writes its bytes.
2. **`file_path` added to `pathAliases`.** The spec's list (`path`, `filePath`,
   `file`, `target_file`) does not include the key dsh's own `read`/`write`/`edit`
   tools actually use, which would have left every file read ungated.
3. **Generic sinks are not fingerprints.** `curl -s -o /dev/null -w '%{http_code}'`
   is the idiomatic way to ask for a status code, and treating `/dev/null` as
   action identity made four *different* URLs collide on `sink:/dev/null` starting
   with the second.
4. **The volume caps ship at 6, not 4**, and **a denied call commits only the
   fingerprints that hit.** Both were changed after live runs: the first because a
   four-URL batch was blocked, the second because a denied `curl` was charging
   `net:` for a URL it never fetched, locking the model out of that URL entirely.

## Development loop (dependency-free)

`cordis.patch.yml` in this repo is a ready-made overlay — point its `name:` at the
absolute path of this checkout, then:

```bash
# 1) prove the overlay + module resolve (prints the composed tree; does NOT boot)
dsh --profile <name> --patch ./cordis.patch.yml --dump-config | grep repeat-tool-breaker

# 2) real apply run on a SAFE profile
dsh --profile <name> --patch ./cordis.patch.yml "reply ok"
```

Two things worth knowing:

- **Never point this at a profile that serves a live UI** (in the reference
  deployment that is the `web` profile). Boot a headless test profile, or an
  isolated `DSH_HOME`, instead.
- Step 1 does not import the module, so a syntax or resolution error only surfaces
  in step 2. To confirm the gate really is wired in step 2, add a temporary
  `console.log(typeof ctx.tools.guard)` at the top of `apply` and remove it after
  — the shipped file intentionally logs nothing.

## Acceptance

```bash
npm test          # node --test test/breaker.test.js
```

30 tests, no model or endpoint required. The suite mirrors the v2 spec's table
(T1 ping-pong, T2/T3 description decoys, T4 unrelated calls, T5 curl↔wget, T6
exclusion, T7 per-agent isolation, T8 volatile flags, T9 normalizer units, T10
read paths, T11 denied calls still spend budget) and adds the plugin-level wiring
(T12: the guard denies, quotes the previous result, survives a plugin notice,
resets on a human turn; T12c: the fail-loud config contract) and the documented
shape of the shipped defaults (T14/T14b).

Three assertions worth singling out, because they are the ones that would have
caught v1 — or that caught v2's own defaults:

- every fingerprint of a `description: '1st'/'2nd'/'3rd'` call is asserted to
  contain neither the decoy text nor the `timeoutMs` value;
- the deny path is asserted to be reached for host-spelling ping-pong whose
  `exact:` fingerprints differ;
- one failed attempt is asserted to leave room for the identical retry (`T2b`),
  while a call that keeps failing is still blocked;
- four *different* URLs writing to `/dev/null` are asserted to all be allowed, and
  a denied call is asserted **not** to spend `net:` budget on the URL it never
  fetched.

### Verified on a real model

Beyond the unit suite, the plugin was driven end-to-end through the official
`dsh-container` harness (`ghcr.io/snailium/dsh-container/dsh`) against a local
Qwen3.8-27B on llama.cpp, in a throwaway `DSH_HOME`:

| Scenario | Result |
|---|---|
| `curl -s -o /tmp/od.html https://open-data.canada.ca/` (`description: '1st'`) then the same fetch of `https://open.canada.ca/` (`'2nd'`) | 1st executed; 2nd **blocked before execution**, hits `net:open.canada.ca/ 2/2` and `sink:/tmp/od.html 2/2` |
| `echo hello-repeat` twice, `description` `'1st'` / `'2nd'`, `timeoutMs` 60000 / 1000 | 1st executed; 2nd **blocked**, hits the identical cleaned command |
| four **different** URLs, one `curl` each | all four allowed and returned 200 |

### Real-pipeline check (no model needed)

`test/pipeline.e2e.mjs` drives the genuine `ToolRuntime` with a stub `bash` body,
which proves the denied call's body is never entered — offline and deterministically.
It needs the dsh packages resolvable, so it is not part of CI:

```bash
DSH_NODE_MODULES=/path/to/dsh/node_modules/@deepseek-ai npm run test:pipeline
```

### Full-boot compatibility check (any dsh version)

`test/compat/` boots a **real** `dsh` of the version under test with this plugin
mounted as a profile bundle, and drives it with a scripted mock model — no GPU,
no real endpoint. `mock-llm.py` speaks enough of the OpenAI streaming protocol to
make the agent issue the *same* `bash` call four times in a row, and
`run-compat.sh` asserts the trajectory: attempts `1..cap-1` executed, the rest
denied with `REPEAT_TOOL_BLOCKED`.

```bash
DSH_PREFIX=/tmp/dsh-compat
mkdir -p "$DSH_PREFIX" && cd "$DSH_PREFIX" && npm init -y
npm install --no-audit --no-fund @deepseek-ai/dsh@<version>

cd <this repo>
DSH_PREFIX=$DSH_PREFIX ./test/compat/run-compat.sh
```

It checks what unit tests cannot: that the loader accepts the `dsh.bundle`
manifest, that the bundle's patch layer mounts the row, that `apply()` runs with
`inject: ['tools']` satisfied, and that a denial reaches the model as an
`isError` tool result. Reference output on `@deepseek-ai/dsh` 0.1.5-rc.2:

```
=== dsh under test ===
0.1.5-rc.2
=== bundle mounts? ===
ok
=== cap for action identity: 3 (mock issues 4 identical calls) ===
=== real headless run ===
compat run complete
=== trajectory ===
  attempt 1: isError=False | compat-check
  attempt 2: isError=False | compat-check
  attempt 3: isError=True | Error: REPEAT_TOOL_BLOCKED: ...
  attempt 4: isError=True | Error: REPEAT_TOOL_BLOCKED: ...

COMPAT: PASS (2 executed, 2 denied, cap=3)
```

## Releasing

Publishing runs through `.github/workflows/publish.yml`, which is
`workflow_dispatch`-only — nothing is published as a side effect of a push or a
release, and the job refuses to republish a version that already exists.

```bash
# 1. bump the version and update CHANGELOG.md, commit, push
# 2. trigger the release
gh workflow run publish.yml -f dry-run=false
```

Authentication uses **npm Trusted Publishing (OIDC)**: the workflow needs
`id-token: write` (already set) and a matching trusted-publisher connection on the
npm package page — repository `snailium/dsh-repeat-tool-breaker`, workflow
filename `publish.yml`, environment empty. No long-lived token is required, and
provenance is generated automatically.

Two things that will save you time:

- **Allow the right action.** A trusted-publisher connection created after
  2026-09-03 defaults to allowing only `npm stage publish`. If direct
  `npm publish` is not selected under "Allowed actions", the registry answers
  `403 ... OIDC permission denied for this action`. Connections cannot be edited:
  delete and recreate.
- **Debugging a 403.** Run `gh workflow run publish.yml -f dry-run=true -f debug-oidc=true`
  to print the OIDC claims npm authorises against (`repository`,
  `job_workflow_ref`, `aud`, …) and compare them with the connection's fields.

The npm CLI must be >= 11.5.1 and Node >= 22.14.0 for OIDC; the workflow upgrades
the npm CLI explicitly because Node 22 bundles an older one.

## Scope and verification status

**Verified**

- **Deterministic suite** (`npm test`) — 30 tests covering the full fingerprint
  matrix, decoy stripping, host folding, sink extraction, window arithmetic,
  per-agent isolation, the user-message reset, and the fail-loud config contract.
  Runs in CI on Node 20 and 22 with no model or endpoint.
- **Loads and applies on a real DSH boot**, including as a profile bundle (the
  `dsh.bundle` layer mounts the row by package specifier). Verified on
  `@deepseek-ai/dsh` **0.1.2-rc.1** (the reference deployment) and
  **0.1.5-rc.2** (via `test/compat/`, which boots the real CLI and asserts the
  denial in the trajectory).
- **API surface is unchanged between those two versions**: `ToolGuard`,
  `guard()`, the `tools/pre-execute` / `tools/post-execute` signatures,
  `ToolExecutionInput`/`ToolExecution`, the decision unions and the
  `agent/pre-step` payload all diff clean, and the tool names the plugin keys on
  (`bash`/`pwsh`, `read`/`write`/`edit`, `web_fetch`/`web_search`) are stable.
- **Driven by a real model in the `dsh-container` harness** — the three scenarios
  in [Verified on a real model](#verified-on-a-real-model), plus the real
  `ToolRuntime` pipeline driven in-process with a stub tool body (which proves the
  denied call's body is never entered).

**Not covered here**

- The live-model runs are manual, not part of CI: they need a local inference
  backend and the `dsh-container` image. `npm test` is the CI gate.

**Intentional limits**

- The breaker is a safety net, not a semantic deduplicator. Two genuinely
  different commands that happen to write the same non-generic file collide on
  `sink:`, and that is by design — the denial message tells the model to work from
  what it has.
- Fingerprints are computed from the *arguments*, never from the tool's output, so
  a loop that varies only the working directory (`cd a && curl X` vs
  `cd b && curl X`) still collides on `net:` but not on `cmd:`.

## Design notes

- **Counting lives in the guard and nowhere else.** That single locus is what
  prevents the guard/post-execute double count, the reset-your-own-budget hole,
  and the "denied call charges a resource it never fetched" hole.
- **Windows, not consecutive runs.** v1's run counter reset as soon as a different
  signature arrived, which is exactly the `A, B, A, B` pattern class C exploited.
- **Fail loud in `apply`**: no schemastery `Config` export (keeping the plugin
  dependency-free is deliberate — `cordis.resolveConfig` passes config through
  unchanged when a plugin exports no `Config`), but every load-bearing invariant
  is validated at load and throws rather than silently degrading.
- **The denial text is the model's only new information**, so it names the
  fingerprints that hit with their counts, states explicitly that changing the
  description / `timeoutMs` / `--max-time` / host spelling is not a new action,
  and quotes the previous result inline. It contains no `<tool_call>`-shaped
  markup.
- **State is in-memory only**; a resumed session starts fresh (same tradeoff as
  the official reminder).
