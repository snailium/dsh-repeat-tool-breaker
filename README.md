# dsh-repeat-tool-breaker

[![CI](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/snailium/dsh-repeat-tool-breaker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-repeat-tool-breaker.svg)](https://www.npmjs.com/package/dsh-repeat-tool-breaker)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Hard break on an agent's repeated **identical** tool calls. A local, dependency-free
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
that registers a single synchronous monotonic gate on the public
`ctx.tools.guard` API. By default the **2nd** identical call (same tool name +
canonically-equal arguments, property order ignored) is **denied before it
executes**; the model then only sees an `isError` result whose text starts with
`REPEAT_TOOL_BLOCKED`, quotes the previous successful result, and tells it to
advance or conclude instead of retrying.

The sibling official plugin `@deepseek-ai/dsh-repeat-tool-reminder` (advisory,
at 3/5/8 repeats) may stay on — this breaker refuses earlier (at 2), so the two
compose: the breaker is the hard gate, the reminder is the soft nudge.

## Requirements

- Node.js **>= 20** (developed and tested on 22).
- A DSH profile that exposes the `tools` service. Built and verified against
  **`@deepseek-ai/dsh` 0.1.2-rc.1**.
- No runtime dependencies — `index.js` imports nothing (no `cordis`, no
  schemastery), so it can be mounted straight from a path.

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
fail-loud defaults really are the defaults. To tune it, reconfigure the row by
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
  → tools/guard()          ← THIS plugin's monotonic gate
  → tools/execute          (the real tool body)
  → tools/post-execute
  → tools/result
```

Returning a `string` from a guard is a **final, monotonic denial**: it cannot be
re-allowed by listener ordering, and — critically — **the tool body never runs**.
That is what distinguishes a hard break from the official reminder, which only
injects a softer "you repeated X" message after the call already executed.

## Interface

- `ctx.tools.guard((execution) => string | undefined)` — synchronous:
  - return `string` → deny (tool does not run; model sees `Error: <string>`),
  - return `undefined` → leave allowed.
- Tracking state (`WeakMap<Agent, chain>`) is per **live Agent instance**, so one
  agent's loop never trips another's, and it is reclaimed when the agent goes away.
- A new **user message** (`agent/pre-step` with a `user` source) clears that
  agent's chain, so a fresh instruction is never treated as a loop.
- Reserved tools (`exclude`, default `todo_write`) are transparent: they neither
  count nor reset other tools' chains.
- Read-like tools (`read`, `read_file`, `file-read`, `fs-read`, `Read`, and any
  name matching `/read/i` by default) additionally get a **same-path cap**
  (`maxSamePath`, default 3) so a model re-reading one file with *varying*
  arguments is still bounded.

## Configuration

Mount via a profile bundle (Option A above — no `config:` in the bundle layer,
defaults apply), a `--patch` overlay, or a profile's `cordis.patch.yml`. The
plugin exports an object form (`{ name, inject: ['tools'], apply }`);
`inject: ['tools']` defers `apply` until the real `ToolRuntime` service is live,
at which point `ctx.tools.guard` is the genuine method.

A hand-written mount row looks like this (`name` is the package specifier once the
plugin is installed into the profile, or an absolute path to `index.js` when
mounting a bare checkout):

```yaml
- insert:
    - id: repeat-tool-breaker
      name: dsh-repeat-tool-breaker
      config:
        denyAfter: 2          # identical (tool + canonical args) call #2 is denied (>=2)
        warnAfter: 2          # advisory tier; inert unless 2 <= warnAfter < denyAfter
        registerAdvisory: true
        exclude: [todo_write] # never count/reset these tools (include/exclude are *-wildcards)
        include: []           # non-empty = ONLY these tools are tracked
        readTools: [read, Read, read_file, read-file, file-read, fs-read]
        matchReadBySubstring: true
        pathAliases: [path, filePath, file, target_file]
        maxSamePath: 3
        previewChars: 400
        resultPreviewChars: 800
```

(The `- insert:` list is required to **add** a new plugin; a flat `- id:` entry is
a reconfig of an already-present id and fails with "entry not found" for a plugin
that isn't yet in the composed tree.)

Here `name` is an absolute POSIX path to this directory's `index.js` (dev/overlay
loop). When the package is installed into a profile it can instead be the package
specifier `dsh-repeat-tool-breaker`.

### About the advisory tier

The `warnAfter` notice is deliberately **inert unless `2 <= warnAfter < denyAfter`**:

- `warnAfter` must be at least 2, because a notice only makes sense once a repeat
  has actually happened;
- it must be below `denyAfter`, because at `denyAfter` the call is blocked and the
  deny reason already explains why.

With the default `denyAfter: 2` the gate blocks on the very first repeat, so there
is no room for a separate pre-block nudge and nothing is emitted. Set
`denyAfter: 3, warnAfter: 2` to get one warning after the first repeat and the
block on the second.

This matters: an advisory keyed only on `count === warnAfter` would fire on every
*ordinary* tool call (every fresh call starts a new run at count 1), attaching a
misleading "you repeated this" message to each one.

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
  deployment that is the `web` profile). Boot a headless test profile instead.
- Step 1 does not import the module, so a syntax or resolution error only surfaces
  in step 2. To confirm the gate really is wired in step 2, add a temporary
  `console.log(typeof ctx.tools.guard)` at the top of `apply` and remove it after
  — the shipped file intentionally logs nothing.

## Acceptance

The deterministic pure-logic suite covers the important cases with no model or
endpoint required:

```bash
npm test          # or: node test/logic.test.mjs
```

It verifies, for a stable live `Agent` object: 1st identical `read` allowed →
2nd denied (`REPEAT_TOOL_BLOCKED`, tool named, previous result quoted);
property-order-insensitive keying; a different path/tool `write` chain allowed,
then its 2nd identical denied; `todo_write` repeated twice never denied and never
resets an unrelated chain; per-agent isolation; user-message reset re-allows a
same call; and the same-path cap bounds varying-argument re-reads of one file.

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

- **Deterministic guard-logic suite** (`npm test`) — 29 assertions over a stable
  live `Agent` object, covering the allow/deny matrix, canonicalization, tool
  exclusion, per-agent isolation, and the user-message reset. Runs in CI on
  Node 20 and 22 with no model or endpoint.
- **Loads and applies on a real DSH boot.** Verified against
  `@deepseek-ai/dsh` 0.1.2-rc.1 through a `--patch` overlay: the loader resolves
  the module and `apply` runs with `ctx.tools.guard` present as a function — which
  is only reachable once `inject: ['tools']` defers activation until the real
  `ToolRuntime` is live.

**Not covered here**

- There is no end-to-end, model-driven trajectory in the suite (a model actually
  issuing two identical `read` calls and receiving the blocked second one). The
  deny behaviour is pinned by the deterministic suite instead; see
  [Development loop](#development-loop-dependency-free) if you want to drive it
  manually against a live profile.

**Intentional limits** — only *exact* repeats are caught (same tool, same
canonical arguments, property order ignored). Two calls differing by one argument
character, or achieving the same effect through different tools, are out of scope:
the gate is a monotonic safety net, not a semantic deduplicator.

## Design notes

- **Counting lives in the guard**, which runs for every tracked attempt (allowed
  and denied) and commits state on allow *and* deny. `tools/post-execute` only
  records the rendered result (for a high-quality deny message) and may emit the
  `warnAfter` advisory through `additionalContexts`; it **never increments**.
  That single counting locus is what prevents the guard/post-execute double count
  the naive design smuggles in when both update the chain. The advisory is
  additionally gated on being reachable — see
  [About the advisory tier](#about-the-advisory-tier).
- **Only consecutive repeats are caught.** The run resets when a call with a
  different signature arrives, so the pattern `A, B, A, B, …` never trips the
  gate. That is intentional (a consecutive-run detector, not a call counter), and
  it is why the deny message says "in a row".
- **Fail loud in `apply`**: no schemastery `Config` export (keeping index.js
  dependency-free is deliberate — `cordis.resolveConfig` passes config through
  unchanged when a plugin exports no `Config`), but every load-bearing invariant
  (`denyAfter >= 2`, non-empty patterns, preview caps) is validated at load and
  throws rather than silently degrading.
- **State is in-memory only**; a resumed session starts fresh (same tradeoff as
  the official reminder).
