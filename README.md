# dsh-repeat-tool-breaker

[![CI](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-repeat-tool-breaker.svg)](https://www.npmjs.com/package/dsh-repeat-tool-breaker)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Escalating repeat detection for an agent's tool calls. A local, dependency-free
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
that registers one synchronous gate on the public `ctx.tools.guard` API. A
measure repeated inside the agent's sliding window is not stopped at the first
threshold: it escalates — a light warning at 7, a written-summary demand at 11,
and the gate at 12 (16 for the coarser `host:` measure), where the operator is
offered a turn-scoped exemption
(`onLimit: ask`, the default) or the call is denied outright. When the gate
denies, the call never executes and the model gets an `isError` result starting
with `REPEAT_TOOL_BLOCKED` that quotes the previous result and says what to do
instead.

In one paragraph, the v1 → v2 → 0.4.x story:

> **v1 lost** because it counted *byte-identical consecutive* calls while the
> model varied a presentation field (`description: '1st'|'2nd'|'3rd'`, churning
> `timeoutMs`) and ping-ponged between host spellings
> (`open-data.canada.ca` ↔ `open.canada.ca`) with a different `--max-time` each
> time — every call looked new, so the counter never advanced.
> **v2 wins** by deleting decoy arguments before any fingerprint is built, then
> counting *semantic* fingerprints (`exact:`, `cmd:`, `net:`, `host:`, `site:`,
> `sink:`, `family:`, `verb:`) over a per-agent window of the last 16 calls, so a
> repeat has to change the actual resource — not its spelling — to pass.
> **0.4.0 adds escalation**: the same measure warns, demands a summary, and only
> then gates — retuned in 0.4.2 to 7 / 11 / 12, with `host:` at 16 — and the gate
> asks the operator rather than blocking silently.

## The three loops, and what catches each

| | Loop | Caught by |
|---|---|---|
| **A** | the same `read`/`write`/`bash` arguments again, verbatim | `exact:` (12) |
| **B** | `description: '1st'/'2nd'/'3rd'`, `command` unchanged | decoy arguments are stripped **before** fingerprinting, so the calls become byte-identical → `exact:` (12) |
| **C** | `curl --max-time 60 open-data.canada.ca` ↔ `curl --max-time 30 open.canada.ca` | `net:` (12) after host-alias folding, plus `sink:` (12) and `cmd:` (12) after volatile-flag stripping |

A fixed strategy is a fourth failure mode that none of those loops catches: a
high-volume but *non-repetitive* run against one target, where every query string
differs so `net:` never collides. On the reference deployment one agent made 30
`bash`/`curl` calls against a single host in one turn and never converged. The
`host:` measure (new in 0.4.0, cap 16) is what makes it visible; see
[How a call is fingerprinted](#how-a-call-is-fingerprinted).

The sibling official plugin `@deepseek-ai/dsh-repeat-tool-reminder` (advisory, at
3/5/8 repeats) may stay on — the two compose, with the reminder as the soft nudge
and this breaker as the escalating gate that asks at 12.

## The three stages

Every measure — one fingerprint identity such as `exact:<tool>:…`,
`net:<host><path>?<query>`, or `host:<host>` — has the same three-stage
structure. A stage fires **once per crossing, on exact equality**: the count
*including* the current call must equal the threshold, so the window sliding does
not re-announce it.

| Count | Setting | Stage | What happens |
|---|---|---|---|
| 7 | `warnAt` | 1 — light warning | The model is told it is repeating and should consider whether a different route would get there faster. Nothing is blocked and nothing is demanded. |
| 11 | `summarizeAt` | 2 — summary demand | The model must write down what it established, what it assumed without verifying, what failed and why, and **at least two approaches it has not tried** — plus an instruction to use a **larger per-batch amount** so there are fewer batches. Nothing is blocked. |
| 12 | the `limits` entry | 3 — the gate | `onLimit: ask` (default) offers the operator a turn-scoped exemption; `onLimit: deny` blocks outright. An unattended ask degrades to a denial. |

The cap is 12 for the action-identity measures (`exact`, `cmd`, `net`, `sink`) and 16
for the coarser `host:` measure — the whole window. See
[Tuning](#tuning-and-how-these-numbers-were-chosen).

`limits` **is** the stage-3 threshold. There is deliberately no separate
`gateAt`: a second gate number would be the same value written twice, and two
knobs that must agree will eventually disagree.

Stages 1 and 2 are advisory. A guard can only return a denial, so the guard
computes the advisory while it still sees the counts and `tools/post-execute`
attaches it as an `additionalContexts` entry — the channel
`@deepseek-ai/dsh-repeat-tool-reminder` uses — stamped `source.kind: 'plugin'`.
It composes with a downstream block rather than replacing it. (An unlabeled
context would render as a user prompt in derived history, which is why the
`source` is mandatory.)

Each stage is an ordinary, independent setting, and **no setting is validated
against another**:

- `0`, a negative number, or `null` disables a stage **silently** — that is the
  documented off-switch, not a value to reject;
- a `limits` entry at or below a stage means "no escalation for this measure":
  `exact: 5` under `warnAt: 7` gates at 5 with no warning at all;
- inverted stages are legal too — the stronger message simply fires first.

When several measures cross a stage on the same call, the strongest stage wins
and ties go to the highest count.

### A stage above a cap can never speak

The gate fires before the advisory, so a `summarizeAt` at or above every cap is
dead code, and no threshold above the window (16) can fire at all. Nothing
validates one setting against another — a `limits` entry below a stage remains a
deliberate way to skip an advisory — but the shipped defaults keep `summarizeAt`
strictly below every cap, which is why the stages and the caps move together. The
measurement behind the 0.4.2 numbers is in
[`docs/issue-b-thresholds.md`](docs/issue-b-thresholds.md).

### `onLimit` — what happens at the gate

| Value | Behaviour |
|---|---|
| `ask` (default) | The operator is offered a turn-scoped exemption, **once per measure per turn**. Approving exempts exactly the fingerprints that hit, stops counting them for the rest of the turn, and lets later identical calls ride along; declining stops the asking for those measures and denies them until the next human message. |
| `deny` | Never ask. The cap-th call is denied outright with `REPEAT_TOOL_BLOCKED`. |

`ask` is the default because it is **fail-closed**. Every unattended outcome of an
approval is a denial — `rejected` (the session policy is `never`), `cancelled`
(the turn was aborted), and `unavailable`, the value the registry falls back to
when no answerer is registered — so a headless profile degrades to `deny` on its
own and nothing stalls. Exemptions are **per fingerprint**: an exemption for
`host:api.weather.gc.ca` says nothing about `exact:` or about a different host.

Asking used to be local-only (`localHosts: ask`). Since 0.4.0 it is what
`onLimit` does for every measure; see [Local addresses](#local-addresses).

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
That is what distinguishes the gate from the official reminder, which only injects
a softer "you repeated X" message after the call already executed. Since 0.4.0 the
breaker also has its own two advisory stages, delivered on the same
`tools/post-execute` channel (see [The three stages](#the-three-stages)).

The guard is deliberately synchronous: no `await`, no DNS, no disk reads.

## How a call is fingerprinted

Each call contributes a *set* of fingerprints. Any one of them reaching its cap
denies the call, so dodging one (a new host spelling) still collides on another
(a new `sink:` or `cmd:`).

| Fingerprint | Built from | Catches |
|---|---|---|
| `exact:<tool>:<json>` | tool name + arguments with decoy fields deleted, keys deep-sorted | A, B |
| `cmd:<verb>:<command>` | verb + command with volatile flags (`--max-time`, `-s`, `--retry`, `timeout N`, `-sSL` clusters…) removed | C, B |
| `net:<host><path>?<query>` | `http(s)` URL with the scheme defaulted, `www.` and default ports dropped, host aliases folded, the fragment discarded, a trailing slash trimmed, and the **query kept** (sorted, tracking parameters removed) — the query is what makes `?page=2` a different resource | C, and it must NOT fire on pagination |
| `host:<host>` | normalized host of each URL, with no path and no query (new in 0.4.0) | a fixed strategy: many *distinct* requests against one target, which `net:` cannot see because every query string differs. Local hosts are excluded by default (`includeLocal`) |
| `site:<last-2-labels>` | registrable-ish site of each URL (IP literals stand alone) — note this merges `api.github.com` into `github.com` | not capped by default: `siteOf()` collapses to two labels, so it merges unrelated services (`api.weather.gc.ca` → `gc.ca`); the `host:` measure is the discriminating one |
| `sink:<path>` | `-o`/`--output`/`-O`/`>`/`>>`/`tee` target of a shell command — except generic destinations (`/dev/null`, `-`, …), which say nothing about *which* resource was fetched | C |
| `family:http-fetch` | every `curl` / `wget` / `http` / `httpie` / URL-taking tool call | nothing by default — a volume budget no setting of which avoided false positives |
| `verb:<cmd>` | the first non-wrapper command word (`sudo`, `timeout 30`, `FOO=1` are transparent) | tool-swapping within one verb |

### Local addresses

`localhost`, loopback, RFC1918 and link-local hosts are what a development loop
talks to — a dev server, a local inference endpoint, a container — and a
target-scoped fingerprint cannot tell them apart from a web crawl. `localHosts`
decides whether local traffic is fingerprinted at all:

| Value | Behaviour |
|---|---|
| `deny` (default) | local calls are counted and blocked like any other host |
| `allow` | local traffic is never fingerprinted: no `net:`, `site:`, `host:`, `sink:`, `family:` or `verb:` is emitted, so only `exact:` and `cmd:` still identify the action |

The `ask` value was **removed in 0.4.0**. Asking is no longer a local-only
concern — it is what the gate does for every measure — so it moved to `onLimit`.
A config still carrying `localHosts: ask` fails loud at load with the migration
hint ``use `onLimit: ask` ``, the same way 0.2.0 handled a removed key; the only
accepted values are `deny` and `allow`.

Local hosts are also excluded from the `host:` measure by default
(`includeLocal: false`). A development loop against localhost is the canonical
legitimate case, and the documented `site:127.0.0.1` false positive came from
exactly this class. `localHosts: allow` still wins — it emits no target
fingerprints at all.

```yaml
- id: repeat-tool-breaker
  config:
    localHosts: deny          # deny | allow
    includeLocal: false       # whether local hosts feed the `host:` measure
```

Because `exact` and `cmd` identify the ACTION rather than a target, `allow` does
not relax them: a byte-identical repeat is a loop whether or not it points at
localhost, and a call that mentions even one public URL is not a local call at
all.

### Counting rules

- State is a **per-agent sliding window** (`window`, default 16 calls) held in a
  `WeakMap` keyed by the live `Agent` object — one agent's loop never trips
  another's, and subagents get their own budget.
- A call is denied when a fingerprint **already appears `limit - 1` times** in the
  window, i.e. when the current call would be the `limit`-th occurrence. The first
  occurrence of anything is therefore always allowed.
- The two advisory stages are computed **before** the commit, so the count they
  report includes the current call, and each fires only when the count equals its
  threshold.
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
- An approved **exemption stops counting**, not merely blocking: the exempted
  fingerprints are dropped at commit time, so they are not incremented and cannot
  escalate again for the rest of the turn. An exemption is per fingerprint and
  says nothing about any other measure.
- A real **user message** (`agent/pre-step` with source `kind: 'user'`) clears that
  agent's window — and with it the exemptions and the refusals. Plugin notices and
  tool results do **not** — otherwise the breaker's own denial would reset the
  budget it is enforcing.
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
        window: 16                  # recent calls per agent that participate
        onLimit: ask                # ask | deny — what happens AT `limits`
        localHosts: deny            # deny | allow — see "Local addresses"
        warnAt: 7                   # stage 1; 0 / negative / null disables it
        summarizeAt: 11             # stage 2; 0 / negative / null disables it
        includeLocal: false         # whether local hosts feed the `host:` measure
        previewChars: 400           # truncation for quoted fingerprints
        resultPreviewChars: 800     # truncation for the quoted previous result
        exclude: [todo_write]       # never counted, never resets (*-wildcards ok)
        include: []                 # non-empty = ONLY these names/patterns count
        ignoreArgs:                 # merged over the defaults
          '*': [description, timeoutMs, run_in_background, justification, reason, title, comment]
          bash: [description, timeoutMs, run_in_background, justification]
        hostAliases:                # merged over the defaults
          open-data.canada.ca: open.canada.ca
        limits:                     # merged over the defaults; null = uncapped
          # `limits` IS the stage-3 threshold — there is no `gateAt`.
          exact: 12
          cmd: 12
          net: 12
          sink: 12
          host: 16                  # new in 0.4.0: one target, many distinct requests
          site: null                # volume budgets: off by default, see "Tuning"
          'family:http-fetch': null
          'verb:curl': null
          'verb:wget': null
```

Merge semantics, which matter when retuning:

- `ignoreArgs`, `hostAliases` and `limits` merge **one level deep** over the
  defaults, so you can add one host alias or retune one cap without restating the
  table.
- Scalars replace; the arrays `exclude` and `include` **replace outright**, so a
  two-entry `exclude:` list is the whole list, not an addition to the default
  `todo_write` entry.
- A patch replaces the targeted row's whole `config`, so `config` keys are not
  inherited from the bundle layer.

Every value is validated fail-loud in `apply`: `window >= 4`; `onLimit` one of
`ask`/`deny`; `localHosts` one of `deny`/`allow`; `includeLocal` a boolean; every
limit either `null` or a finite number `>= 2` (a cap below 2 would deny the
*first* call); `previewChars`/`resultPreviewChars` `>= 1`; and an enabled stage a
positive integer. **No setting is checked against another** — inverted stages
simply fire in the other order and a `limits` entry below a stage means "no
escalation for this measure", both legitimate ways to express intent. Config keys
removed in 0.2.0 (`denyAfter`, `warnAfter`, `registerAdvisory`, `maxSamePath`,
`readTools`, `matchReadBySubstring`) throw with a pointer at their replacement
rather than being ignored, and `localHosts: ask` (removed in 0.4.0) throws with
the `onLimit: ask` migration — so an upgraded profile cannot silently lose its
tuning.

(The `- insert:` list is required to **add** a new plugin; a flat `- id:` entry is
a reconfig of an already-present id and fails with "entry not found" for a plugin
that isn't yet in the composed tree.)

### Tuning, and how these numbers were chosen

The table mixes *precise* caps with *broad* ones, and the difference matters:

- **precise, action-scoped, cap 12**: `exact`, `cmd`, `net`, `sink`. These fire
  only when the same action actually happens again, and they are what catches
  loops. Every lower value was tried against real work and each produced a false
  positive. A cap of 2 leaves no room for the most common *non-loop* repeat: the
  first attempt fails for a reason that has nothing to do with looping — a
  precondition the harness enforces, a DNS failure — and the correct response is
  to retry the same call; at 2 that retry is what gets blocked, and the only way
  forward is to cosmetically change the call, which is exactly what this plugin
  exists to stop. At 3 the retry fits, but dense legitimate work still tripped,
  because `sink:` is path-only **by design** — its whole job is to catch one
  destination rewritten with ever-changing content — so a shell cycle that writes
  the same file several times while iterating looked exactly like a loop. At 5 an
  ordinary edit/test cycle fits. 0.4.0 moved the cap to **9** because two advisory
  stages now sit underneath the gate — 3 warned, 6 demanded a summary, 9 gated —
  so the hard break moved *later* instead of firing at the first threshold. 0.4.2
  retunes the stages and the cap together to **7 / 11 / 12**: measurement over 109
  recorded sessions showed the old stages firing on runs that succeeded (two
  known-good runs peaked at 4 and 6 repeats, both at or above the old
  `warnAt: 3`) and 10% of real sessions reaching a peak of 13, above the old cap
  of 9.
- **the new `host:` measure is active, and it is not a volume budget**: it counts
  one normalized host, with no path and no query, so it fires when an agent keeps
  going back to the same target with genuinely *different* requests. That is a
  failure mode repetition counting cannot see — `net:` keeps the query by design,
  so every page of one API is a different resource, and `site:` merges unrelated
  services. It is reconciled with the disabled volume budgets by the mechanism
  around it: its two lower stages are advisory, and its gate is operator-gated
  (and fail-closed when unattended), rather than an automatic volume cap. Its cap
  is **16** — the whole window — rather than the 12 the action-identity measures
  use, because `host:` is the coarser measure: it discards the path, so
  installing many packages from one mirror and re-fetching one broken URL look
  identical to it, and it accounted for 25 of the 48 `(session, fingerprint)`
  pairs that reached a cap under the old defaults. The measurement is in
  [`docs/issue-b-thresholds.md`](docs/issue-b-thresholds.md).
- **not counter-based at all**: file operations. There is no `readpath` or
  `writepath` limit. A file action is identified by its **position** through
  `exact:` — the same file at the same offset, or the same replacement string, is
  the same action and is denied; a different offset or a different region is a
  different action and is never blocked. 0.2.0 shipped path-only counters for
  these and they both had to be removed after blocking ordinary work on the
  reference deployment.
- **volume budgets, off by default**: `site`, `family:http-fetch`, `verb:curl`,
  `verb:wget`. These counted how MUCH one site or one verb was used. They are all
  `null` now, because a volume budget cannot tell a crawl from a session that is
  simply making progress, and every value tried produced a false positive on a
  real one:

  | Setting | What it blocked |
  |---|---|
  | `family:http-fetch: 4` | a task asking for the status code of **four different URLs** (blocked from the second) |
  | `site: 3` | ordinary development calls that merely *mentioned* a loopback URL |
  | `site: 3` | a session paginating a GitHub commit list — `api.github.com` and `github.com` share one budget, so it tripped after three fetches |

  The last one is the clearest argument: the agent's own comment in that session
  was `# Fetch page 2 of openvino commits using a script file to avoid repeat
  detection` — a volume cap that pushes an agent to *work around the breaker*
  instead of changing approach is worse than no cap at all.

  Repetition is what this plugin detects, and the action-scoped caps do that:
  `exact`, `cmd`, `net`, and `sink` (one destination rewritten with changing
  content). `host:` extends it to a target that is revisited with changing paths
  and queries. If you do want a crawl budget, set one:

```yaml
- id: repeat-tool-breaker
  config:
    limits:
      site: 30                  # at most 30 fetches per site per window
      'family:http-fetch': 60
```

### Deliberate deviations from the v2 specification

All of these came out of running the plugin against a live model on the reference
deployment.

1. **No path-only counter for file tools at all.** The spec folded reads and
   writes of one path into a single `sink:` counter, which denies the second half
   of the ordinary pair `read foo.ts` → `write foo.ts`. 0.2.0 replaced it with
   separate `readpath`/`writepath` counters and 0.2.2 removed both, because a
   path-only counter cannot see POSITION: it blocked re-reading a file that was
   being edited, and blocked the third iteration on a single document. File
   actions are identified by `exact:` alone, which is position-aware by
   construction. `sink:` still means what §3.6 defined it as: where a *shell
   command* writes its bytes.
2. **`pathAliases` is gone (0.2.4).** The spec's list (`path`, `filePath`,
   `file`, `target_file`) had to gain `file_path`, the key dsh's own file tools
   actually use — but that key existed only to feed the path-only `readpath`/
   `writepath` fingerprints, which 0.2.2 removed. 0.2.4 deletes the inert key and
   its `firstPathArg` helper, so the documented configuration is exactly what the
   code reads. A config that still lists `pathAliases` is accepted and ignored.
3. **Generic sinks are not fingerprints.** `curl -s -o /dev/null -w '%{http_code}'`
   is the idiomatic way to ask for a status code, and treating `/dev/null` as
   action identity made four *different* URLs collide on `sink:/dev/null` starting
   with the second.
4. **The volume caps no longer ship at all**, and **a denied call commits only the
   fingerprints that hit.** The first started as a deviation from the spec's `4`
   (it shipped `6`) and 0.3.2 turned it off entirely: no value could tell a crawl
   from progress, and every one tried produced a false positive on a live session
   — see [Tuning](#tuning-and-how-these-numbers-were-chosen). The second was changed
   because a denied `curl` was charging `net:` for a URL it never fetched, locking
   the model out of that URL entirely.

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

50 tests, no model or endpoint required. The suite mirrors the v2 spec's table
(T1 ping-pong, T2/T3 description decoys, T4 unrelated calls, T5 curl↔wget, T6
exclusion, T7 per-agent isolation, T8 volatile flags, T9 normalizer units, T10
read paths, T11 denied calls still spend budget), adds the plugin-level wiring
(T12: the guard denies, quotes the previous result, survives a plugin notice,
resets on a human turn; T12c: the fail-loud config contract), and documents the
shipped defaults (T14: the 0.4.2 table; T14b/T14c: volume is not a loop signal,
`?page=N` stays a new resource while `host:` is the convergence measure that
accumulates across pages).

The 0.4.0 escalation has its own tests:

- `T24` — the three stages fire at `warnAt`, `summarizeAt` and the cap on one
  measure, with the assertions derived from the defaults rather than hard-coded
  (7, 11 and 12), and once per crossing rather than on every later call;
- `T25` — `host:` accumulates on a public host across distinct paths and queries,
  while local hosts are excluded from it by default;
- `T26` — an exemption covers only the measures that hit;
- `T27` — a disabled stage is never delivered;
- `T20`–`T23` — the gate end to end: an approved ask stops counting that measure
  for the turn, any measure can be asked about (not only local targets), a
  declined ask denies without re-prompting, and a human turn clears the exemption
  and the window;
- `T14d`–`T14f` — the silent stage off-switch, no cross-setting validation, and
  the `localHosts: ask` migration error.

Assertions worth singling out, because they are the ones that would have caught
v1 — or that caught v2's own defaults:

- every fingerprint of a `description: '1st'/'2nd'/'3rd'` call is asserted to
  contain neither the decoy text nor the `timeoutMs` value;
- the deny path is asserted to be reached for host-spelling ping-pong whose
  `exact:` fingerprints differ;
- one failed attempt is asserted to leave room for the identical retry (`T2b`),
  while a call that keeps failing is still blocked;
- the local-address matrix and the gate are asserted end to end (`T17`–`T23`):
  `localHosts: allow` emits no local target fingerprint, a mixed call (one local
  plus one public URL) is not a local call, an approval exempts exactly the
  measures that hit and no others, a refusal stops the asking until the next human
  turn, and the gate is not local-only;
- four *different* URLs writing to `/dev/null` are asserted to all be allowed, and
  a denied call is asserted **not** to spend `net:` budget on the URL it never
  fetched.

### Verified on a real model

Beyond the unit suite, the plugin was driven end-to-end through the official
`dsh-container` harness (`ghcr.io/snailium/dsh-container/dsh`) against a local
Qwen3.8-27B on llama.cpp, in a throwaway `DSH_HOME`:

| Scenario | Result |
|---|---|
| `curl -s -o /tmp/od.html https://open-data.canada.ca/` (`description: '1st'`) then the same fetch of `https://open.canada.ca/` (`'2nd'`) | 1st executed; the 2nd **collided** on `net:open.canada.ca/` and `sink:/tmp/od.html` — it was denied then, under the cap in force at the time |
| `echo hello-repeat` twice, `description` `'1st'` / `'2nd'`, `timeoutMs` 60000 / 1000 | 1st executed; the 2nd **collided** on the identical cleaned command |
| four **different** URLs, one `curl` each | all four allowed and returned 200 |

These runs predate 0.4.0, so the counts reflect the cap in force at the time (2,
then 5) and there is no `host:` measure yet. What they establish is the
*collision*: the alias spelling, the churning `--max-time` and the decoy
`description` do not make a new action. Under the 0.4.2 defaults the same calls
still collide, and the break lands at 12 with the two advisory stages before it.

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
make the agent repeat a scripted `bash` call, and `run-compat.sh` reads the
shipped cap out of the plugin's own `DEFAULTS` (so a retune does not break the
harness) and asserts the resulting tool-result trajectory. It also covers a
local-address loop with no answerer, where the fail-closed `onLimit: ask` must
deny rather than stall, and pagination of one endpoint, which must never block.

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
`isError` tool result. Archived reference output, recorded on `@deepseek-ai/dsh`
0.1.5-rc.2 with a shipped cap of 3:

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

The attempt counts follow the cap the script derives from `DEFAULTS`, so the
0.4.2 defaults move the whole trajectory (cap 12, `host` 16) without any change
to the assertion shape.

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

- **Deterministic suite** (`npm test`) — 50 tests covering the full fingerprint
  matrix, decoy stripping, host folding, sink extraction, the `host:` measure and
  the three escalating stages, window arithmetic, per-agent isolation, the
  user-message reset, the gate's ask/deny outcomes, and the fail-loud config
  contract. Runs in CI on Node 20 and 22 with no model or endpoint.
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
- **Driven by a real model in the `dsh-container` harness** (under the pre-0.4.0
  defaults) — the three scenarios in
  [Verified on a real model](#verified-on-a-real-model), plus the real
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
  and quotes the previous result inline (or says the previous result is already
  in the history). It contains no `<tool_call>`-shaped markup.
- **Escalation is advisory first.** Stages 1 and 2 ride `tools/post-execute`
  `additionalContexts` stamped `source.kind: 'plugin'`, because a guard can only
  return a denial — and an unlabeled context would render as a user prompt in
  derived history. The gate itself is split across two hooks: `tools/pre-execute`
  can ask but cannot deny, and `ctx.tools.guard` can deny but cannot ask. A
  rejected ask never reaches the guard, so "the guard saw this execution" is
  exactly the approval signal.
- **State is in-memory only**; a resumed session starts fresh (same tradeoff as
  the official reminder).
