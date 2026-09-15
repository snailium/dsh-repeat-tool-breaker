# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-09-15

### Fixed

- **`writepath` is disabled by default** — `null` instead of `3`. Editing one file
  repeatedly is ordinary work, not a loop: the reference deployment hit the cap of
  3 on the **third consecutive edit of a single document** within minutes of
  installing 0.2.0, while writing a SKILL.md. The loop the cap was meant to catch
  — rewriting a file with the same content — is already covered by `exact`
  (cap 2). Set `limits.writepath` to a number to restore a per-file write budget.

### Notes

- Not a breaking change: `null` was already a valid value for a limit, so this
  only moves a default. Nothing in the configuration schema or public API changed.

## [0.2.0] - 2026-09-13

The semantic-rewrite release. v1 counted *byte-identical consecutive* calls, so a
model could stay in a loop simply by varying a presentation field or the host
spelling; v2 strips decoys first and then counts semantic fingerprints over a
sliding window.

### Fixed

- **`description: '1st'/'2nd'/'3rd'` (plus a churning `timeoutMs`) no longer
  launders a repeat.** Decoy arguments are deleted *before* any fingerprint string
  is built, so those calls become byte-identical and collide on `exact:`. The
  suite asserts that no fingerprint of such a call contains the decoy text or the
  timeout value.
- **Host ping-pong is now caught.** `curl --max-time 60 open-data.canada.ca` ↔
  `curl --max-time 30 open.canada.ca` previously alternated forever: the calls
  were not consecutive-equal and the command was never normalized. `net:` folds
  host aliases and strips the query, and `cmd:` strips volatile flags, so both
  spellings collide — as does the same fetch re-issued through `wget`.
- **A denied call no longer risks a free retry.** The guard commits a call on the
  deny path too, so hammering a blocked call cannot reset its own budget.

### Changed — breaking

- Counting moved from a **consecutive-run counter** to a **per-agent sliding
  window** (`window`, default 12 calls) over a *set* of fingerprints per call:
  `exact:`, `cmd:`, `net:`, `site:`, `sink:`, `readpath:`, `writepath:`,
  `family:http-fetch`, `verb:<cmd>`.
- Configuration is now `{ window, previewChars, resultPreviewChars, exclude,
  include, ignoreArgs, pathAliases, hostAliases, limits }`. The v1 keys
  `denyAfter`, `warnAfter`, `registerAdvisory`, `maxSamePath`, `readTools` and
  `matchReadBySubstring` are **removed**: passing one now throws at load with a
  pointer at its replacement instead of being silently ignored.
- The advisory tier (`warnAfter` / `registerAdvisory` / `additionalContexts`) was
  removed. The guard denies; there is no separate soft-notice path. The official
  `@deepseek-ai/dsh-repeat-tool-reminder` remains the soft tier.
- `limits`, `ignoreArgs` and `hostAliases` merge one level deep over the defaults;
  `exclude`, `include` and `pathAliases` **replace** the default arrays.
- The package is now `index.js` + `lib/` (`defaults`, `normalize`, `fingerprints`,
  `window`, `message`); the test entry point is
  `node --test test/breaker.test.js` (the old `test/logic.test.mjs` was
  superseded).

### Added

- A per-fingerprint **hit list** in the denial message, so the model is told
  exactly which identities collided and how many times, that cosmetic variation
  is not a new action, and what the previous result was.

### Deliberate deviations from the v2 specification

Four, each a consequence of running the plugin against a live model on the
reference deployment (Qwen3.8-27B via the `dsh-container` harness). All are
reversible from config alone.

- File reads and writes get separate counters (`readpath`, `writepath`) instead of
  sharing one `sink:`. The spec's single counter would deny the second half of the
  ordinary `read foo.ts` → `write foo.ts` pair, which is an edit, not a loop.
- `file_path` was added to `pathAliases`; the spec's list omitted the key dsh's own
  `read`/`write`/`edit` tools actually use, which would have left every file read
  ungated.
- **Generic sinks are not fingerprints.** A live run of "get the status code of
  these four URLs" fetched `https://example.com/` and then had every following
  call denied, because all four used `curl -s -o /dev/null` and therefore shared
  `sink:/dev/null`. `/dev/null` (and the other null devices, and `-`) say nothing
  about which resource was fetched.
- **The volume caps ship at 6, not 4**, and **a denied call commits only the
  fingerprints that hit.** The first was changed because the same four-URL run
  also tripped `family:http-fetch: 4` and `verb:curl: 4`; the second because a
  denied `curl https://example.org` was charging `net:example.org/` for a fetch
  that never happened, after which the model could not reach that URL through any
  tool for the rest of the turn. Hammering a denied call stays blocked either way,
  since the hitting fingerprint is already at its cap.

## [0.1.3] - 2026-09-12

### Fixed

- **The package now declares `dsh.bundle`, so the shipped `cordis.patch.yml` is
  actually reachable.** The file was already in `files`, but with no
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` manifest, listing
  `dsh-repeat-tool-breaker` in a profile's `dsh.profile.bundles` failed the boot
  with `dsh: profile bundle "dsh-repeat-tool-breaker" declares no dsh.bundle in
  its package.json` — an unhandled throw from `loadProfile`, not a soft warning.
  The bundled patch was dead weight: unreachable through the bundle path and
  usable only as a copy-paste `--patch` overlay.

### Changed

- `cordis.patch.yml` is now a real bundle layer: it mounts the plugin row by its
  **package specifier** (`name: 'dsh-repeat-tool-breaker'`) instead of the
  `/ABS/PATH/index.js` placeholder, and it carries **no `config:`** — so the
  plugin's own fail-loud `DEFAULTS` apply and a profile that wants different
  values restates them in its own patch layer. The previous `warnAfter: 1` in the
  snippet was inert anyway (the advisory needs `2 <= warnAfter < denyAfter`), so
  behaviour for anyone who copy-pasted it is unchanged.
- `cordis.patch.yml` comments document both install paths (list as a bundle vs.
  mount by hand / `--patch`), including the fact that a patch *replaces* a row's
  whole `config` rather than merging, and that an absolute path is still the way
  to mount a checkout that is not installed into the profile.
- README: bundle-install path documented alongside the manual mount row.

## [0.1.2] - 2026-09-11

### Changed

- Publishing runs through the `Publish to npm` GitHub Actions workflow using
  **npm Trusted Publishing (OIDC)** — no long-lived npm token is required. The
  workflow upgrades the npm CLI first, because Trusted Publishing needs npm
  >= 11.5.1 while Node 22 bundles an older one. A repository `NPM_TOKEN` secret is
  still honoured as a fallback when trusted publishing is not configured.
- README: npm badge, install instructions for the published package, and the
  corrected advisory-tier documentation.

## [0.1.1] - 2026-09-11

### Fixed

- **The advisory no longer fires on ordinary calls.** The `warnAfter` notice was
  keyed only on `count === warnAfter`, and because every fresh tool call starts a
  new run at count 1, the default `warnAfter: 1` attached a misleading "you just
  ran X with identical arguments 1 time(s)" message to *every* tool call —
  polluting context for no reason. The advisory is now inert unless
  `2 <= warnAfter < denyAfter` (a repeat must have happened, and the block must
  not have happened yet), default `warnAfter` is raised from 1 to 2, and the
  wording now describes a real repeat ("N times in a row").
- Caller-provided config arrays (`exclude`, `include`, `readTools`, `pathAliases`)
  are copied before being frozen, so the plugin no longer freezes an array the
  caller still owns.
- Removed a dead `denyAfter` overflow check that `Number.isInteger` already made
  unreachable.

### Changed

- `tools/post-execute` computes the call signature once instead of twice.
- Test suite grown from 20 to 29 assertions (advisory reachability, no-advisory
  regressions, fail-loud config, caller-array ownership).

## [0.1.0] - 2026-09-11

### Added

- Initial release: a dependency-free DSH plugin that hard-blocks identical repeated
  tool calls through the synchronous monotonic `ctx.tools.guard` gate.
- Denies the **2nd** identical (tool name + canonical arguments, property order
  ignored) call per agent by default; the denied call never executes and the model
  receives a `REPEAT_TOOL_BLOCKED` result quoting the previous successful result.
- Same-path read cap (`maxSamePath`) bounding read-like tools called repeatedly on
  one file with *varying* arguments.
- Per-agent `WeakMap` state; user-message chain reset via `agent/pre-step`;
  transparent tool exclusion (default `todo_write`).
- Advisory `warnAfter` notice delivered through `tools/post-execute` — never a
  deny, and it never increments the chain.
- Deterministic guard-logic acceptance suite (`test/logic.test.mjs`) and GitHub
  Actions CI on Node 20 and 22.

[Unreleased]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/snailium/dsh-repeat-tool-breaker/releases/tag/v0.1.0
