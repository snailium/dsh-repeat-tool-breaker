# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-09-22

### Fixed

- **The failure track was blind to the shapes a real spin produces.** Reported from a live
  run: seven calls against one host, five of them failing, and `failWarnAt: 3` never fired.
  Every one of those five had `isError: false` **and exit code 0** — `curl … | python3 … |
  head` exits with `head`'s status, and a script that catches its own `HTTP Error 400` exits
  0 as well — so the structured value said "success" and the text fallback did not recognise
  what was in the text.

  `lib/failure.js` now also recognises, in a shell result's text: `Traceback (most recent
  call last)`, a line-anchored Python exception (`SyntaxError:`, `urllib.error.URLError:`, …),
  `HTTP Error nnn`, and `curl: (n)`. On the reported run the failure streak is now 4 on
  `host:archive-api.open-meteo.com`, so the advisory fires at the third failure. Measured
  across 96 sessions, the markers raise the ≥3 sessions from 9 to 16 and the ≥5 from 5 to 6,
  with zero known-good runs caught.

### Changed

- **A status code is now definitive in both directions.** A fetch reporting `200` is a
  success and its text is never consulted, so a page that happens to contain the words
  "HTTP Error 400" or a traceback is no longer read as a failure. Previously the text
  fallback ran even after a successful status.
- **The text fallback is restricted to shell tools.** A shell's `exitCode: 0` proves
  nothing, so its text is the remaining evidence. Every other tool answers through its
  structured value; guessing from an arbitrary tool's prose is how a `read` of a Python file
  containing `ValueError:` becomes a failure.


## [0.5.0] - 2026-09-22

### Added

- **A second escalation track, on consecutive FAILURES of one fingerprint.** The
  occurrence track is unchanged (7 / 11 / 12, `host` 16). The new track exists because
  failure is a much stronger signal than repetition: repeating a call that WORKS is
  fixation, repeating one that FAILS is not learning. Its thresholds therefore sit well
  below the occurrence ones.

  | setting | default | what it does |
  | --- | --- | --- |
  | `failWarnAt` | 3 | after 3 consecutive failures of one fingerprint, deliver an advisory naming the target and the failure reason |
  | `failLimit` | 5 | after 5, a call carrying that fingerprint is blocked, subject to the existing `onLimit` policy (`ask`, fail-closed) |

- **A failure is not `result.isError`.** `isError` is true only when the CALL failed — a
  thrown error, an unknown tool, a sandbox denial — and is `false` for a non-zero exit
  code and for an HTTP 404, which are the two shapes that matter. Measured over 40
  recorded sessions, the thrown case covers 40 of 6765 bash results (0.6%); counting only
  it would have made the track blind. `lib/failure.js` reads the structured
  `result.value` each tool declares in its `output.schema` — non-zero `exitCode`,
  `statusCode >= 400`, `timedOut`, non-null `signal` — with a text-marker fallback.

### Notes

- **Only the fingerprints that hit are blocked.** A call that does not carry them —
  reading the error log, grepping the code, trying a different endpoint — is allowed.
  Blocking the recovery action is how a guard turns a stuck model into a wedged one.
- **A success clears that fingerprint's streak; a success of something else does not.**
  A read is not progress on the thing that keeps failing.
- **Both tracks share one measure set.** A fingerprint whose cap is `null` is disabled
  for both. This is load-bearing: measured over the corpus, the longest failure streaks
  sat on exactly those measures (9 on `family:http-fetch`, 8 on `verb:curl`, 7 on
  `verb:export`), so counting them would have reintroduced the 0.4.0 bug through a new
  channel.
- **The plugin never counts its own denial as a failure**, which would make the guard
  feed itself: deny a call, the streak grows, the next call is denied a step earlier.
- **The failure gate can only fire on a later call.** `ctx.tools.guard` is synchronous
  and runs before execution; the outcome is known only in `post-execute`. So after 5
  failures, the 6th call carrying that fingerprint is blocked.
- Both tracks feed the SAME gate, the same exemption prompt and the same refusal set. A
  second gate would have needed a second ask, a second refusal set and a second way to
  get stuck.
- Measured support (`tools/failure-run-measurement.mjs`, 107 sessions, enabled measures
  only): 3.6% of calls fail; 9 sessions reach a 3-failure streak, 5 reach 5, and **zero
  known-good runs reach 3**. The clearest real case was a session hitting
  `host:api.github.invalid` — a reserved, permanently nonexistent host — 8 times running.
- The compat suite gained a failure scenario, and its two occurrence scenarios now
  neutralise the exit status (`|| true`). Their commands cannot succeed, so without that
  they would have been testing the failure track instead of the one they name.


## [0.4.2] - 2026-09-22

### Changed

- **The three stages are retuned: `warnAt: 3 → 7`, `summarizeAt: 6 → 11`, and the caps
  `9 → 12` (with `host` at 16).** No behaviour changed and no setting was added or
  removed; only the numbers moved. The measurement is in `docs/issue-b-thresholds.md`.

  0.4.1's note deferred this until a wider corpus existed. That corpus is 109 recorded
  sessions with known or unknown outcomes, replayed through the plugin's own
  fingerprinting and validated against the real tool pipeline: the replay model and the
  genuine `dsh-tools` ToolRuntime agree exactly on every session and cap setting tried,
  including the two worst sessions (38/38 and 698/698 advisories and gate calls at the
  old caps; 15/15 and 246/246 at the new ones).

  What it showed:

  - **The old stages fired on runs that succeeded.** Two known-good runs peaked at 4 and
    6 repeats of one measure, and `warnAt: 3` sits below both. 10% of real sessions
    reach a peak of 13, which was above the old cap of 9.
  - **The old defaults cost a lot.** Over the 109 non-stuck sessions: 629 advisory
    messages, 49 sessions warned, 19 gated, 2296 calls blocked. The new defaults deliver
    158 messages, warn 26 and gate 10 — while still catching the known-stuck run.
  - **`host:` is deliberately looser (16) than action identity (12).** It discards the
    URL path, so installing many packages from one mirror and re-fetching one broken URL
    look identical to it; it accounted for 25 of the 48 (session, fingerprint) pairs
    that reached a cap at 9. 16 is the window itself — the whole window is one host.

### Notes

- **A stage above a cap can never be delivered.** The gate fires first, so a
  `summarizeAt` at or above every cap is dead code — which is why the stages and the caps
  move together. Nothing validates one setting against another (a `limits` entry below a
  stage remains a deliberate way to skip the advisory), but the *defaults* must not ship
  a stage that can never speak. For the same reason a threshold above the window (16) can
  never fire.
- **`tools/convergence-measurement.mjs` is superseded** by `tools/threshold-sweep.mjs`.
  The old tool tallied every fingerprint including the `null`-capped measures 0.4.1
  stopped escalating, and counted crossings rather than messages — which is how 0.4.0's
  over-trigger was first mistaken for a threshold problem.

## [0.4.1] - 2026-09-22

### Fixed

- **A measure with no cap no longer escalates.** The advisory stages were applied to
  EVERY fingerprint, ignoring `limits` — so the volume measures that ship DISABLED
  (`site:`, `family:*`, `verb:*` are all `null`) still warned, and still demanded
  summaries. One `curl` emits four of those measures at once, so a single action could
  produce up to four near-identical messages about one behaviour. Observed in
  production as `verb:cd has come up 3 times` followed by `verb:cd has now come up 6
  times`, and in a test-battery run as **5 messages in 7 tool calls** covering only 3
  distinct behaviours. The stages live BELOW the cap: a measure with no cap has no
  gate, so it must have no escalation either.
  Reported by the backend-test session in `GUARD-OVERTRIGGER-REPORT.md`.

- **The message now names the useful measure.** Identical calls cross `exact:`, `net:`,
  `site:` and `host:` at the same count, and the first in iteration order won — which
  usually meant a truncated command line (`exact:bash:{"command":"curl -s \"…`). A
  target-scoped measure is preferred: `host:` > `net:` > `site:` > `sink:` > `cmd:` >
  `exact:`.

### Notes

- **Thresholds are unchanged in this release.** The same report also argues that
  `warnAt: 3` and `summarizeAt: 6` sit low relative to a known-good run (which reached
  4–8 requests to one host). That needs the wider measurement the report itself asks
  for, and it should be judged only after the bug above is out of the way: the bug
  accounted for most of the observed message volume, because it multiplied one action
  into four measures.

## [0.4.0] - 2026-09-21

The escalation release. Repetition is no longer a wall you hit once: the same
measure now warns, then demands a summary, and only then gates — and the gate asks
the operator instead of silently blocking.

### Added

- **Two advisory stages under the cap.** Repeating one measure inside a turn now
  escalates: `warnAt` (3) says "you are repeating yourself, consider another
  route"; `summarizeAt` (6) demands a written progress summary and at least two
  approaches the model has not tried, plus an instruction to use a **larger
  per-batch amount** so there are fewer batches. Both are delivered as
  `additionalContexts` on `tools/post-execute` — the channel
  `@deepseek-ai/dsh-repeat-tool-reminder` uses — stamped `source.kind: 'plugin'`.
  A stage fires once per crossing, on exact equality, so the window sliding does
  not re-announce it.
  A stage is disabled by `0`, a negative number or `null`, silently: that is the
  documented off-switch, not a value to reject.

- **`onLimit`: what happens at the cap.** `ask` (default) offers the operator a
  turn-scoped exemption; `deny` blocks outright. `ask` is fail-closed — every
  unattended approval outcome is a denial, so a headless profile denies by itself
  and nothing stalls.

- **The `host:` measure.** `net:` keeps the query by design (that is what makes
  `?page=2` a different resource, fixed in 0.3.2), which means an agent grinding
  one API produces entirely distinct `net:` entries and nothing accumulates.
  `site:` collapses to the last two DNS labels, so `api.weather.gc.ca` and every
  other `*.gc.ca` host share one identity. The host is the level at which "the
  same target again" is both true and discriminating, and it is what makes a fixed
  strategy visible. Local hosts are excluded from it by default
  (`includeLocal: false`); `localHosts: allow` still emits no target fingerprints.

- **Per-fingerprint exemptions.** An approved exemption covers exactly the measures
  that hit, stops counting them for the rest of the turn, and says nothing about
  any other measure.

### Changed

- **The cap moves from 5 to 9** — `exact`, `cmd`, `net`, `sink` and the new
  `host`. Two escalations now sit underneath it, so the hard break moves later
  rather than staying at the first threshold.
- **`window` moves from 12 to 16.** Measured against a corpus with known outcomes
  and against the production sessions, the wider window changed no verdict: the
  failing sessions reached a host count of 18 either way, and the one successful
  session that grinds stayed at 5. It admits three more sessions at the gate stage
  in production. Adopted for margin, not because 12 was shown to miss.

### Removed

- **`localHosts: ask`.** Asking is no longer a local-only concern — it is what
  `onLimit` does for every measure — so `localHosts` keeps only `deny` and
  `allow`. A config still carrying `localHosts: ask` fails loud at load with the
  migration (`use `onLimit: ask``), the same way 0.2.0 handled a removed key.

### Fixed

- **The 0.3.2 changelog was wrong about `site:`.** It claimed "`site:` no longer
  merges unrelated services"; `siteOf` has not changed since v2 and still collapses
  to two labels. 0.3.2 turned the `site:` *cap* off — it never fixed the merge. The
  host measure is the fix.

### Notes

- **No setting is validated against another.** A `limits` entry below a stage means
  "no escalation for this measure", and inverted stages simply fire in the other
  order. Both are ways to express intent, and second-guessing them would be worse
  than accepting them.
- **Pagination is handled by the escalation, not by an exemption.** 0.3.2 made
  pagination stop colliding on `net:`; eight distinct pages of one host now reach
  `host: 8`, so the ninth request to that host is the cap-th. That is intended, not
  a leftover: stage 2 at 6 is where a model processing in batches is told to use a
  larger per-batch amount, and one that takes the advice finishes well under the gate
  at 9. The advice is deliberately backend-agnostic — the same shape appears when an
  agent reads a file line by line — and a test pins that it never names HTTP paging.
  `T14c` asserts the shape.

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

[Unreleased]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/snailium/dsh-repeat-tool-breaker/compare/v0.3.3...v0.4.0
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
