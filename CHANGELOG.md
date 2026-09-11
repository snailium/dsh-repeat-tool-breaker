# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/snailium/dsh-repeat-tool-breaker/releases/tag/v0.1.0
