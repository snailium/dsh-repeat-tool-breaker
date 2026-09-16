# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.3] - 2026-09-15

### Changed

- **The action-identity caps are 5, not 3** — `exact`, `cmd`, `net` and `sink`.
  3 fixed the retry case that 2 broke, but it still tripped on *dense legitimate
  work*. The clearest instance was `sink:`: it is path-only **by design** — its
  whole job is to catch one destination being rewritten with ever-changing
  content — so a shell cycle that writes the same file several times while
  iterating is indistinguishable from a loop at 3. On the reference deployment a
  session building and re-running scaffolding was denied on its third write to the
  same path with three *different* payloads.

  Raising the cap is the right lever here rather than making `sink:`
  content-sensitive: a content hash would make it fire only on a byte-identical
  rewrite, which `exact:` already catches, and would therefore remove the one
  thing `sink:` exists to do. At 5 an ordinary edit/test cycle fits, and a real
  loop is still stopped — it reaches the cap because it never changes what it is
  doing.

  Net effect: two extra attempts per action before the hard break. The suite is
  expressed in terms of the cap (`const CAP = cfg.limits.exact`); six tests that
  had hard-coded the 3-call shape now derive it from `CAP` instead.

### Notes

- The gate is unchanged in kind and still **fail-closed**: an action repeated five
  times inside a 12-call window is denied exactly as before, and every unattended
  `localHosts: ask` outcome is still a denial.

## [0.3.2] - 2026-09-15

### Fixed

- **Pagination is no longer mistaken for repetition.** `net:` discarded the query
  string, so `...commits?per_page=100` and `...commits?per_page=100&page=2` were
  the same resource. The query is now part of the fingerprint — sorted, with
  tracking parameters (`utm_*`, `fbclid`, `gclid`, …) removed, so a page number
  distinguishes one page of results from the next while a cosmetic parameter still
  cannot launder a repeat.
- **`site:` no longer merges unrelated services.** `siteOf()` collapses a host to
  its last two labels, so `api.github.com` and `github.com` shared one budget; a
  session paginating a GitHub commit list tripped `site:github.com 6/3`.

### Changed

- **The volume budgets are off by default**: `site`, `family:http-fetch`,
  `verb:curl`, `verb:wget` are now `null`. A budget on how much one site or one
  verb may be used cannot tell a crawl from a session making progress, and every
  value tried produced a false positive on a real session — four different URLs
  blocked by `family:http-fetch: 4`, a development loop blocked by
  `site:127.0.0.1`, and the commit crawl above. The worst part was the shape of
  the failure: the agent's own comment in that session read
  `# Fetch page 2 of openvino commits using a script file to avoid repeat
  detection` — an agent working *around* the breaker instead of changing
  approach is the opposite of the intent.

  Repetition is what this plugin detects, and `exact`, `cmd`, `net` and `sink`
  still do it. Anyone who wants a crawl budget can set one back:
  `limits: { site: 30, 'family:http-fetch': 60 }`.

### Notes

- The local-address policy is unaffected in principle but changes shape in
  practice: with `site:` gone, a local loop only accumulates when it hits the
  SAME host+path, which is exactly what `localHosts` relaxes.

## [0.3.1] - 2026-09-15

### Changed

- **`localHosts` now defaults to `ask`**, so installing the plugin is enough: no
  profile needs a hand-written patch to get the prompt. This is safe because
  `ask` is **fail-closed** — every unattended outcome of an approval is a denial
  (`rejected` when the session policy is `never`, `cancelled` when the turn is
  aborted, and `unavailable`, the value the registry falls back to when no
  answerer is registered) — so a headless profile degrades to `deny` by itself
  instead of stalling.

  The one visible difference in an unattended profile: the model's *first* blocked
  local call of a turn receives the registry's "requires approval, but no approval
  channel is available" instead of `REPEAT_TOOL_BLOCKED`. From the second one on —
  the refusal is remembered for the turn — the breaker's own message applies
  again. Set `localHosts: deny` to avoid even that.

### Fixed

- The refusal note no longer claims the operator declined: with no approval
  channel the request was never shown to anyone, so it now says the exemption was
  not granted "either because the request was declined, or because no approval
  channel was available to answer it".

## [0.3.0] - 2026-09-15

### Added

- **`localHosts`: `deny` | `ask` | `allow`** — local addresses (`localhost`,
  loopback, RFC1918, link-local) are now their own class instead of being counted
  as an ordinary web site. The `site:` budget was blocking ordinary development
  loops: on the reference deployment a handful of calls that merely *mentioned* a
  loopback URL tripped `site:127.0.0.1` while nothing was being crawled.

  - `deny` (default) keeps today's behaviour and names the knob in the message.
  - `ask` offers the operator a prompt, **once per turn**; approving exempts local
    targets for the rest of that turn, declining stops the asking until the next
    human message. It belongs in a profile with a UI — a headless profile should
    keep `deny`, where an open question would stall the turn. Hence: configure it
    per profile.
  - `allow` never fingerprints local traffic.

- `fingerprints()` now reports whether a call is **local** (it mentions at least
  one URL and every URL it mentions is local), which is what the policy acts on.

### Notes

- Only the target-scoped fingerprints (`net`, `site`, `sink`, `family`, `verb`)
  are ever relaxed: `exact` and `cmd` identify the ACTION, and a byte-identical
  repeat is a loop whether or not it points at localhost. A call mentioning even
  one public URL is not a local call.
- An ask is only made when local traffic is the *sole* reason for the block, so a
  genuine repeat is a straight denial rather than a prompt.
- `ask` had to be split across two hooks: `tools/pre-execute` can ask but cannot
  deny, and `ctx.tools.guard` can deny but cannot ask. The pipeline hands a
  rejected ask straight to `post-execute` and never runs the guard, so "the guard
  saw this execution" is exactly the approval signal.

## [0.2.4] - 2026-09-15

### Removed

- The `pathAliases` config key, and the `firstPathArg` helper it fed. Both became
  dead in 0.2.2, when the path-only `readpath`/`writepath` fingerprints were
  removed — the key has had no reader since, so the README was documenting a knob
  that did nothing. A config that still lists `pathAliases` is accepted and
  ignored, so no consumer has to change anything.

### Fixed

- The bundle patch's header comment still advertised the **original** v2 cap table
  (`exact`/`cmd`/`net`/`sink` 2, `family`/`verb` 4, plus `readpath`/`writepath`),
  three releases after those values changed. It now states the shipped table.

### Added

- `test/compat/` — a full-boot compatibility harness (scripted mock model + a
  real `dsh` of the version under test). Repository tooling only; `test/` is not
  published, so there is no npm release for it.

## [0.2.3] - 2026-09-15

### Changed

- **The action-identity caps are 3, not 2** — `exact`, `cmd`, `net` and `sink`.
  A cap of 2 has no room for the most common *non-loop* repeat: the first attempt
  fails for a reason unrelated to looping (a precondition the harness enforces, a
  DNS failure) and the correct response is to retry the same call. At 2 that
  retry is precisely what gets blocked, so the only way forward is to change the
  call cosmetically — the behaviour this plugin exists to stop.

  The alternative considered was refunding the budget of a guard-allowed call
  whose body failed. It was rejected: it makes the guard depend on how a failure
  is reported, and a call that fails *every* time would refund itself forever and
  never be blocked. Raising the cap is stateless, depends on nothing, and still
  stops a failing loop on the third attempt.

  Net effect: one extra attempt per action before the hard break. `T2b` pins the
  retry case; the rest of the suite now expresses its expectations in terms of the
  cap (`const CAP = cfg.limits.exact`) instead of hard-coding 2.

## [0.2.2] - 2026-09-15

### Changed

- **File operations are no longer counted by path.** `read`/`write`/`edit` are
  identified by **position** through `exact:` — the same file at the same offset,
  or the same replacement string, is the same action and is denied; a different
  offset or a different region is a different action and is never blocked. The
  `readpath` and `writepath` limits and their fingerprints were removed.

  Both were introduced in 0.2.0 to give a per-file budget, and both had to go
  after live use: `writepath: 3` denied the third consecutive edit of a single
  document (0.2.1 disabled it), and `readpath: 2` denied the *second read of a
  file that was being edited* — a step dsh's own fs-observation policy requires
  before every edit, so the plugin was blocking the workflow it exists to protect.

  Nothing is lost: an identical re-read or re-edit still collides on `exact:`.

### Removed

- Limits `readpath` and `writepath`, and the `readpath:`/`writepath:`
  fingerprints. A config that still lists them is accepted but inert.

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
  (the last two were removed again in 0.2.2 — see below)
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

[Unreleased]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/snailium/dsh-repeat-tool-breaker/releases/tag/v0.1.0
