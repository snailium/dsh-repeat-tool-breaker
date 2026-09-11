# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/snailium/dsh-repeat-tool-breaker/releases/tag/v0.1.0
