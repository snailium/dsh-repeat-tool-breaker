# Convergence guard — design

**Status:** IMPLEMENTED in 0.4.0. This is the design of record; the code, tests and
CHANGELOG are the source of truth for what actually shipped, and §11 records the
decisions that were settled before implementation.
**Target:** `dsh-repeat-tool-breaker` → **0.4.0** (breaking; folds in the `onLimit`
generalization agreed earlier)
**Input:** `PLUGIN-IMPROVEMENT-PROPOSAL.md` (performance-test session), a source-level
review of that proposal, the operator's three-stage mechanism, and the measurement run
in §10.

---

## 1. Problem

The breaker detects **repetition**: calls that normalize to the same identity `limit`
times in a window. It does not make visible a second failure mode:

**Strategy fixation** — high-volume, non-repetitive effort against one target that never
converges. Each individual call is legitimately different, so no repeat fingerprint
fires, and the run dies on an external time limit.

Observed case: an agent computing a snowfall total found `api.weather.gc.ca`, then made
30 `bash`/`curl` calls (40 URLs, every query string different) against that one host for
~60 minutes without an answer. Its own compaction summary named the alternative it should
have tried; it did not try it.

## 2. The mechanism: two escalating tracks

One window (the existing **16-call, same-turn** window), one policy per **measure**:

| Count of the same measure within the window | Stage | Action |
| --- | --- | --- |
| **3** (`warnAt`) | 1 | **Light warning.** Tell the model it is repeating, and suggest changing route. No block, no demand. |
| **6** (`summarizeAt`) | 2 | **Require a summary.** The model must write its progress and enumerate untried alternatives. No block. |
| **9** (the `limits` entry) | 3 | **Gate.** On a web profile, ask the operator for an exemption; unattended (headless) the ask resolves to `unavailable` and the call is denied. |
| after an approved exemption | — | **Stop counting that measure**; every later identical measure is exempt for the rest of the turn. |

> The counts above are the **0.4.0** values, kept because the rationale below is the
> record of that decision. They were retuned in 0.4.2 (`7` / `11` / `12`, with `host` at
> `16`) — see §2.4. `lib/defaults.js` is the ground truth for the current numbers.

Headless is not a separate branch: an unattended approval request already resolves to a
denial, which is how `localHosts: ask` degrades today. One mechanism, two profiles.

At most one prompt per measure per turn; a refusal gates that measure for the remainder
of the turn without re-prompting.

### 2.1 Consequence: the hard cap moves from 5 to 9 (0.4.0)

This is the one structural change that follows from the three-stage design, and it must
be stated explicitly because it alters existing behaviour.

Today `limits.exact = 5` denies at 5. If that stayed, a call would be denied at 5 and
stages 2 and 3 would be unreachable. So:

- `limits` becomes the **stage-3 threshold** (`9`), not a separate earlier break;
- `warnAt` (3) and `summarizeAt` (6) are advisory stages *below* it.

**There is no separate `gateAt`, and it must not be reintroduced.** A gate threshold
distinct from `limits` would be the same number written twice, and two knobs that must
agree will eventually disagree. `limits` *is* the gate. What happens when it is reached is
chosen by `onLimit`: `ask` (the exemption prompt, which degrades to a denial when
unattended) or `deny` (the plain hard break). Earlier revisions of this document called
`limits` the "cap" and named a separate `gateAt`; both are retired — `limits` is an
ordinary, already-configurable setting and needs no new concept wrapped around it.

`warnAt`, `summarizeAt` and `limits` are three **independent** settings, and none of them
is checked against the others. A measure whose `limits` entry sits at or below a stage
simply never reaches that stage: `exact: 5` under `warnAt: 3` blocks at 5 with no warning
at all. That is not a misconfiguration to catch — it is how an operator says "I do not
want an escalation for this measure", and second-guessing it would override a deliberate
choice. The same applies to `warnAt` versus `summarizeAt`: if they are inverted, the
stronger message simply fires first. The rule is exactly "when the count is reached, send
that message" — nothing more.

**A stage with a value of `0` or a negative number is disabled, silently.** `warnAt: 0`
means no light warning; `summarizeAt: -1` means no summary demand. This is a deliberate
off-switch, not a value to reject — same treatment as `null`, which is how `limits`
already expresses "off". The only remaining validation is that an *enabled* stage is an
integer, and each `limits` entry keeps its existing rule.

Net effect of the 0.4.0 defaults: the hard break moved later (5 → 9), and two escalations
were inserted before it. On a headless profile, which is where the hard guarantee matters
most, a byte-identical loop is still stopped — at 9 instead of 5. (The cap has since moved
again, to 12; see §2.4.)

### 2.2 No latch is needed

The advisory stages can only fire once each before the gate takes over, so a latch would
only suppress the second of at most two escalations. (At the 0.4.0 numbers: 3 and 6, with
the gate at 9.)

### 2.3 Exemption stops counting

The operator's rule is *stop counting*, not merely "stop blocking": an exempted measure
is dropped at commit time, so it is not incremented and cannot escalate again until the
turn ends.

### 2.4 The 0.4.2 retune: 7 / 11 / 12 (host 16)

The 0.4.0 numbers were chosen from a 72-session corpus and a narrower measure set. A
later corpus — 109 sessions, replayed through the plugin's own fingerprinting and
validated against the real tool pipeline — showed the stages firing on runs that
succeeded, so 0.4.2 moved them. The full measurement is in
[issue-b-thresholds.md](issue-b-thresholds.md); the short version:

| | 0.4.0 | 0.4.2 |
| --- | --- | --- |
| `warnAt` | 3 | **7** |
| `summarizeAt` | 6 | **11** |
| `limits.exact` / `cmd` / `net` / `sink` | 9 | **12** |
| `limits.host` | 9 | **16** |

Three findings drove it, and the third is a constraint rather than a preference:

1. **The old stages fired on known-good runs.** Two runs that completed the task peaked
   at 4 and 6 repeats of one measure; `warnAt: 3` sits below both. 10% of real sessions
   reach a peak of 13, which was above the old cap of 9.
2. **`host:` needs more evidence than action identity.** It discards the URL path, so
   installing many packages from one mirror and re-fetching one broken URL are the same
   shape to it. It accounted for 25 of the 48 `(session, fingerprint)` pairs that reached
   a cap at 9. 16 is the window itself: the whole window is one host.
3. **A stage at or above a cap can never be delivered.** The gate fires first, so a
   `summarizeAt` at or above every cap is dead code, and so is any threshold above the
   window (16). This is why the stages and the caps move together — and why nothing
   *validates* one against another: an operator may still put a cap below a stage to skip
   an advisory, but the defaults must not ship a stage that can never speak.

Measured over the 109 non-stuck sessions, the change takes advisory messages from 629 to
158, warned sessions from 49 to 26, gated sessions from 19 to 10, and blocked calls from
2296 to 1595 — while still catching the known-stuck run.

## 2.5 The failure track (0.5.0)

A second escalation track counts **consecutive failures of one measure** instead of
occurrences, on its own two settings:

| Count of consecutive failures of one measure | Stage | Action |
| --- | --- | --- |
| **3** (`failWarnAt`) | 1 | **Friendly advisory.** Name the target and the failure reason; ask the model to read the error, check the target exists, and fix the cause instead of re-running. |
| **5** (`failLimit`) | 2 | **Gate**, subject to the same `onLimit` policy as the occurrence gate. |

### Why a second track rather than moving the first one's thresholds

The occurrence track cannot distinguish the two workloads that produce repetition:

- **fixation on something that works** — an agent re-querying a working endpoint with
  slightly different parameters, which is normal multi-step work and sometimes succeeds;
- **guessing at something that does not** — an agent rephrasing a request against an
  endpoint that keeps returning 404.

The measured corpus showed both, and the ambiguity is why the occurrence thresholds had
to be raised to 7 / 11 / 12 in 0.4.2: the tighter values could not be justified against a
*successful* run that legitimately repeated a target six times. Failure removes the
ambiguity, so its thresholds can be much tighter — and the two tracks coexist rather than
one replacing the other.

### `isError` is not a failure

This is the trap the whole feature rests on. `result.isError` is true only when the CALL
failed — thrown, unknown tool, sandbox denial, abort. It is `false` for a non-zero exit
code and `false` for an HTTP 404. Measured over 40 recorded sessions, the thrown case
covers 40 of 6765 bash results, **0.6%**; a track built on it would be blind.

The reliable channel is the structured `result.value`, which every tool declares in its
`output.schema`:

| tool | structured value | failure condition |
| --- | --- | --- |
| `bash` | `{ kind, exitCode, signal, timedOut, aborted, … }` | `exitCode !== 0`, `timedOut`, non-null `signal` |
| web fetch | `{ url, statusCode, truncated, … }` | `statusCode >= 400` |

`lib/failure.js` reads those first and falls back to the text markers the renderers emit
(`[exit code: N]`, `(HTTP nnn)`, `[timed out after Nms]`, `[killed by signal: X]`,
`[sandbox: file access denied…]`). Two things are deliberately NOT failures: `aborted`
(external to the model's choice) and a background job that started.

### The rules that keep it safe

- **Only the fingerprints that hit are blocked.** A call that does not carry them —
  reading the error log, grepping the code, trying another endpoint — is allowed.
  Blocking the recovery action is how a guard turns a stuck model into a wedged one.
- **A success clears that fingerprint's streak.** A success of a DIFFERENT fingerprint
  does not: a read is not progress on the thing that keeps failing.
- **The measure set is shared.** A `null`-capped measure is disabled for both tracks.
  This is load-bearing rather than tidy: on the corpus the longest failure streaks sat on
  exactly the disabled volume measures — 9 on `family:http-fetch`, 8 on `verb:curl`, 7 on
  `verb:export` — so a failure track with its own measure set would have reintroduced the
  0.4.0 bug through a new channel.
- **The plugin never counts its own denial as a failure.** Doing so would make the guard
  feed itself: deny a call, the streak grows, the next call is denied a step earlier.
- **The gate can only fire on a later call.** `ctx.tools.guard` is synchronous and runs
  before execution; the outcome is known only in `post-execute`. After 5 failures, the 6th
  call carrying that fingerprint is blocked.
- **The tie-break is shared.** When several measures cross together the message names the
  most actionable one by `measureRank`, never a truncated `exact:` command line.

### Measured support

`tools/failure-run-measurement.mjs`, 107 recorded sessions, enabled measures only:

| longest failure streak | ≥2 | ≥3 | ≥4 | ≥5 | ≥8 |
| --- | --- | --- | --- | --- | --- |
| sessions | 17 | **9** | 6 | **5** | 4 |
| of the known-good runs | — | **0** | — | **0** | — |

The failure rate is 3.6% of calls. The clearest real case was a session hitting
`host:api.github.invalid` — a reserved, permanently nonexistent host — 8 times in a row;
the weather-API fixation shows up as 9 on one `net:`. The corpus contains only 12
`http:404` events, so the direct evidence for the 404 shape specifically is thin: the
dominant real failures are non-zero bash exits (269 `exit:1`) and thrown filesystem errors
(164 `FsError`).

## 3. The measure set: **A — all capped measures, uniformly**

`exact`, `cmd`, `net`, `sink`, plus a **new `host:`** measure.

The new measure is what makes the observed failure visible at all: its 40 `net:`
fingerprints are all distinct, and in a 12-call window nothing else accumulates. Keyed on
the normalized host with no path or query, so `.../items?STN_ID=13849` and
`.../forecast?site_id=1` on one host are one measure.

### 3.1 Measured cost of option A (0.4.0 corpus, superseded)

From §10, over 72 unique production sessions, set A versus narrower sets are nearly
identical at the blocking stage — `host` alone accounts for almost everything. These are
the **0.4.0** figures, before the retune; the 109-session measurement that replaced them
is in §2.4. The stage columns are the 0.4.0 thresholds (3 / 6 / 9):

| Measure set | ≥3 | ≥6 | ≥9 |
| --- | --- | --- | --- |
| **A** (exact/cmd/net/sink/host) | 41 | 28 | 16 |
| host + net | 39 | 27 | 15 |
| host only | 39 | 27 | 15 |

So the choice costs one extra session at each stage. `exact` alone reaches ≥3 in 12/72
sessions and ≥9 in 3/72 — noticeably quieter than the first, buggy measurement suggested.

### 3.2 Host rather than `site:`

`siteOf()` is `parts.slice(-2).join('.')` (`lib/normalize.js:169`), mapping
`api.weather.gc.ca` to `gc.ca` and merging every `*.gc.ca` host into one identity. It
also discriminates worse: on the bonsai2 corpus the successful run peaks at **5** on host
versus **8** on site, while the failing runs reach **18** on host versus 12 on site
(3.6x separation versus 1.5x). The `site:` volume cap stays disabled.

**Documentation bug to fix in the same commit.** The 0.3.2 changelog claims "`site:` no
longer merges unrelated services". That is not true — `git log -S` shows `siteOf` has not
changed since v2. 0.3.2 turned the `site:` *cap* off; it never fixed the merge.

### 3.3 Local hosts

Excluded from the new `host` measure by default (`includeLocal: false`), reusing
`isLocalHost`: the documented `site:127.0.0.1` false positive came from exactly this
class. `localHosts: allow` continues to mean "never fingerprint local traffic at all".

## 4. Message construction

### 4.1 Stage 1 at 3 — light warning

Delivered as advisory context, not as a block: `tools/post-execute` returns
`additionalContexts`, which composes with a downstream block rather than replacing it.
The pattern is `@deepseek-ai/dsh-repeat-tool-reminder`'s; `source.kind` **must** be
`'plugin'` — an unlabeled context renders as a user prompt in derived history.

The existing `onPost` returns `next()` directly and must be restructured to
`const downstream = await next()` and merge, preserving the current `pendingAsk`
semantics (a rejected ask never reaches the guard, so `post-execute` is where a refusal
is recorded).

Stage 1 is deliberately **light**: state the repeat, name the measure and count, suggest
changing route. It does not demand a document.

```
CONVERGENCE_CHECK: you are repeating yourself — <measure> has come up <N> times this
turn. Consider whether the current route is working, and whether a different approach
would get there faster.
```

### 4.2 Stage 2 at 6 — require a summary

Same channel, harder content. The operator's requirement: *summarize the progress and
find an alternative way*. The observed model had already written the correct alternative
in its own compaction summary and did not act on it, so the demand must be immediate and
explicit — enumerate untried options, then commit to one.

```
CONVERGENCE_CHECK: <measure> has now come up <N> times this turn without producing a
result.

Stop and summarise your progress:

  1. What you have established, and how you know it.
  2. What you have assumed without verifying.
  3. What you have tried that failed, and why it appears to have failed.
  4. At least two approaches you have NOT yet tried, and which you will try next.

Do not repeat an approach you have already listed as failed. Summarise the progress
and find an alternative way forward.

If you are fetching data piece by piece, fetch the same amount in fewer requests —
batch several small calls into one — and reduce the total number of calls.
```

The batching paragraph targets the observed failure directly: 30 small `curl` calls
against one host instead of a few larger ones.

### 4.3 Stage 3 at the `limits` entry — the gate

An operator prompt carrying the reason: the measure, the count, what approval buys (the
rest of the turn for that measure) and what declining leaves (gated until the next human
message). Approved → stop counting that measure for the turn. Declined or unattended →
the measure is denied for the rest of the turn, without re-prompting.

No task content in any stage — no source names, no URLs, no numbers beyond the count. No
budget percentage: the plugin has no budget source, and the templates say so, so nobody
later "completes" one with an invented number.

## 5. Configuration (0.4.0, breaking)

```yaml
- id: repeat-tool-breaker
  config:
    warnAt: 7             # occurrence stage 1; 0 or negative (or null) disables it silently
    summarizeAt: 11       # occurrence stage 2; 0 or negative (or null) disables it silently
    failWarnAt: 3         # FAILURE track stage 1 (0.5.0); same on/off rule
    failLimit: 5          # FAILURE track gate (0.5.0); null keeps the advisory, drops the gate
    onLimit: ask          # what happens AT either gate — ask (unattended -> deny) | deny
    localHosts: deny      # allow | deny  (the `ask` value is removed; see §6)
    includeLocal: false   # NEW: whether local hosts count toward the host measure
    window: 16            # the whole scale is clamped by this
    # `limits` IS the stage-3 threshold. There is deliberately no `gateAt` — see §2.1.
    limits:
      exact: 12           # 5 -> 9 in 0.4.0, -> 12 in 0.4.2; see §2.4
      cmd: 12
      net: 12
      sink: 12
      host: 16            # NEW measure, and looser: it discards the URL path
      site: null          # volume budgets stay off
      'family:http-fetch': null
      'verb:curl': null
      'verb:wget': null
```

Each setting is validated on its own and nothing more, matching the plugin's existing
commitment (`apply` throws rather than falling back to defaults). A stage is *on* when
its value is a positive integer; `0`, a negative number, or `null` turns it **off without
an error** — a deliberate off-switch, the same way `limits: null` already means "off".
**No setting is checked against another**, for the reason in §2.1.

## 6. The breaking change: `onLimit` absorbs `localHosts: ask`

The gate **is** the "generalize the ask" change agreed earlier, so this is one
feature:

- `limits` cap → `onLimit: deny` gives a hard denial; `onLimit: ask` gives the gate.
- `localHosts` keeps only `allow` (never fingerprint local traffic) and `deny`. The `ask`
  value is removed, because "ask on this class of target" is now the general gate. A
  config still carrying `localHosts: ask` fails loud at load with a migration hint —
  consistent with how 0.2.0 handled removed keys.
- An operator exemption is **per measure** and does not silence any other measure.

## 7. What this deliberately does not do

- No fuzzy matching; measures are exact identities.
- No content inspection — counts and identities only, never the task or the result.
- No task-specific knowledge; no site allow/deny list by default.
- No separate long window (the first revision's 64-call window, withdrawn).

## 8. Where it lives

In place, in this plugin. The proposal's §5 weighed a standalone plugin partly on "it is
a third-party package, changes require forking" — that does not apply: this repo *is* the
package and it lives in this workspace. Single responsibility is better served by a named
config block and a corrected `limits` comment than by a second plugin watching every tool
call.

The `limits` comment must be updated in the same commit: it currently states that every
volume threshold attempt produced a false positive, and that must be reconciled with a
now-active `host` measure (the reconciliation: the gate is operator-gated and the lower
stages are advisory, rather than an automatic volume cap).

## 9. Test plan

- Unit: counting eligibility (denied calls excluded, multi-URL calls credited per
  measure, local hosts excluded when configured); the occurrence stages fire at exactly
  `warnAt`, `summarizeAt` and the cap (7 / 11 / 12 since 0.4.2); an exemption stops
  counting only its own measure.
- Unit, failure track (T30-T37): the advisory fires once at `failWarnAt` on a
  non-`isError` failure (`exitCode: 1`); the gate blocks the failing fingerprint while a
  recovery call and a different target pass; a success clears the streak but a success of
  another fingerprint does not; the plugin never counts its own denial; disabled measures
  never join the track; `failLimit: null` and `failWarnAt: 0` are independent switches;
  and `failLimit` is validated fail-loud.
- Fixture: the failing sessions replay to a peak of 18 on one host and reach all three
  stages.
- Regression: existing `exact`/`cmd`/`net`/`sink` behaviour is unchanged when the
  advisory stages are disabled; the suite's guarantee (no fingerprint string contains an
  `omitIgnored` value) holds.
- Composition: the injected `additionalContexts` messages are not swallowed by
  `dsh-command-context-trim`, and they compose with a downstream block.
- Real pipeline: `test/pipeline.e2e.mjs` drives the genuine `dsh-tools` ToolRuntime, with
  a stub whose `bash` returns the structured `{ kind, exitCode, timedOut }` the real tool
  declares — a stub returning a plain string would prove nothing about the failure track.
  It asserts the advisory at 3, the denial at 6, and that the recovery call runs.
- Real boot: the compat harness in an isolated `DSH_HOME` (see `no-production-dsh`),
  including a scenario that fails the same command every turn and asserts the trajectory
  executed ×5, `ask`-with-no-answerer denied, then hard-denied. Its two occurrence
  scenarios neutralise the exit status (`|| true`), because their commands cannot succeed
  and they would otherwise be testing the failure track instead of the one they name.

## 10. Measurement results

Tooling: `tools/convergence-measurement.mjs` replays recorded logs through the plugin's
own `lib/fingerprints.js`, so the numbers reflect real fingerprint behaviour. It counts
by full fingerprint identity over the plugin's own 12-**call** window, and resets only on
a human `user/message` (runtime-context injections and compaction checkpoints arrive as
`user/message` with `source.kind: 'plugin'` and must not reset it).

### 10.1 bonsai2 corpus — 8 sessions, known outcomes

| Outcome | host peak | stage 1 (≥3) | stage 2 (≥6) | stage 3 (≥9) |
| --- | ---: | --- | --- | --- |
| timeout | 18 | yes | yes | yes |
| timeout (the report's) | 18 | yes | yes | yes |
| **pass** | **5** | yes | no | no |
| pass, pass, timeout, timeout | 0 | no | no | no |

**Separation is clean:** both failures reach all three stages; the single successful run
that touches one host enough to matter reaches only the light warning, and is not asked
to summarize nor interrupted.

### 10.2 Production corpus — 72 unique sessions, outcomes unknown

Sessions reaching each stage, per measure:

| Measure | ≥3 | ≥6 | ≥9 |
| --- | ---: | ---: | ---: |
| `verb` (disabled) | 48 | 38 | 32 |
| `site` (disabled) | 38 | 24 | 7 |
| `family` (disabled) | 31 | 20 | 10 |
| `net` | 27 | 9 | 2 |
| `sink` | 13 | 6 | 0 |
| `exact` | 12 | 5 | 3 |
| `cmd` | 10 | 4 | 3 |

Union over measure sets: **set A → 41 / 28 / 16**; host+net → 39 / 27 / 15; host only →
39 / 27 / 15. So ≈57% of sessions get at least a light warning, ≈39% reach the summary
demand, and **≈22% reach the exemption prompt**.

Caveats, stated so the numbers are not over-read: outcomes are unknown for this corpus,
so a stage firing cannot be classified as false or true positive; and the corpus is
biased — it includes many of this machine's own bash-heavy plugin-development sessions.

### 10.3 Three analyzer bugs, recorded so the method is trusted

The first two runs produced wrong numbers and the errors are worth stating:

1. the log filename filter missed `.zstd` (no session was read at all);
2. the window was truncated by *fingerprint count* instead of by *call* — the plugin's
   window is 12 calls, each contributing its own fingerprints — which under-reported
   peaks by roughly 3x;
3. counts were tallied per *kind* instead of per *full fingerprint* (`lib/window.js`
   counts `counts.get(fp)`), which reported loops that did not exist and made `exact`
   look like the noisiest measure when it is in fact among the quietest.

### 10.4 Correction to the source proposal

The proposal's §9.5 states that thresholds above 12 are unreachable in a 12-call window.
That holds only for action-identity fingerprints (`exact`, `cmd`), where one call
contributes one fingerprint. URL-derived measures (`net`, `host`, `site`) can carry many
URLs in a single call, so the failing sessions reach a host count of **18** inside a
12-call window. Thresholds above 12 are reachable.

### 10.5 Window 12 versus 16

Measured on both corpora (`WINDOW=12` / `WINDOW=16`):

| Corpus | window | sessions reaching ≥3 | ≥6 | ≥9 |
| --- | ---: | ---: | ---: | ---: |
| production (72) | 12 | 41 | 28 | 16 |
| production (72) | 16 | 41 | 28 | 19 |
| bonsai2 (8, known outcomes) | 12 | failures gate, success warns | same | same |
| bonsai2 (8, known outcomes) | 16 | failures gate, success warns | same | same |

**No verdict changes on the known-outcome corpus.** Host peaks move only where they are
already decisive (18 → 19 and 18 → 23), and the successful run stays at **5** in both
windows — still a light warning only. In production, 16 adds three sessions at the gate
stage and changes nothing at the first two stages. 16 is therefore adopted as the safer,
slightly more sensitive value, not because 12 demonstrably missed anything.

### 10.6 The binding constraint is the turn boundary, not the window

The window resets at each human user message, which is the operator's definition of a
turn ("from a user message until the agent finishes, reset at the next user message"),
and the measurement segments sessions exactly that way. Verified on real sessions:

```
session-494bc095 (Broadcom research): 4 human messages -> [37, 21, 0, 20] calls per turn
session-c16a8522 (t5, the failure):   1 human message  -> [33] calls in one turn
```

Because of that reset, no measure can ever exceed the call count of the busiest turn, so
**a stage above that count is unreachable regardless of window size**:

| Production sessions (72) | Count |
| --- | ---: |
| busiest turn < 3 calls → no stage reachable | 6 |
| busiest turn < 6 calls → stages 2-3 unreachable | 15 |
| busiest turn < 9 calls → stage 3 unreachable whatever the window | **21 (29%)** |

Those are chat-shaped sessions where the agent makes a few tool calls per user message.
Under per-turn counting they can never escalate; raising the window does not help them.
This is an inherent property of the chosen design, not a defect, and it is recorded so
the limitation is known rather than discovered later. The lever, if this ever needs to
change, is the reset policy (accumulate across turns) — not the window.

## 11. Status of the open questions

1. **Measure set — decided: A** (§3.1 quantifies the cost against narrower sets).
2. **Host as the key — decided** (§3.2), now supported by the measurement.
3. **Landing together in one 0.4.0 — decided: yes** (§6).
4. **Stage 3 semantics — decided: ask on web, auto-deny headless** (§4.3).
5. **Window — decided: 16** (§10.5; no verdict changes, adopted for margin).
6. **No `gateAt` — settled** (§2.1): `limits` *is* the stage-3 threshold and `onLimit`
   selects ask versus deny. The name is retired.
7. **The hard cap moves 5 → 9 — accepted** as a consequence of §2.1: the break moves
   later, with two escalations inserted before it.
8. **Turn boundary — confirmed** to be the human user message (§10.6), with the
   consequence that short-turn sessions never reach stage 3.
