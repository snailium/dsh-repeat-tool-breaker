# Issue B: are the advisory thresholds (`warnAt` / `summarizeAt`) too low?

Measurement, not opinion. Every number below was produced by
`tools/threshold-sweep.mjs` and validated against the real tool pipeline by
`tools/count-model-check.mjs`.

Date: 2026-09-22 · Plugin under test: 0.4.1 · Corpus: 109 recorded sessions plus one
stuck fixture.

---

## 1. The question

`GUARD-OVERTRIGGER-REPORT.md` §4 observed that a *progressing* run received
advisories, and suggested moving the stages "up into the gap": `warnAt ≈ 8`,
`summarizeAt ≈ 12–16`, keeping the cap where it is. This measures that proposal
against a corpus with known outcomes.

## 2. Method

**Only measures that can escalate are counted.** `site:`, `family:*` and `verb:*` are
`null`-capped, so `limitFor` returns Infinity and 0.4.1 skips them. Counting them (as
the first measurement tool did) reports messages production cannot deliver.

**Messages, not crossings.** `stageAdvisory` emits at most ONE message per call: the
strongest stage among the call's measures wins, ties go to the higher count and then
to the lower `measureRank`. One `curl` carries up to four enabled fingerprints, so the
two counts differ by a large factor.

**Only when not gated.** `guard()` returns the denial *before* it reaches
`stageAdvisory`, so a blocked call carries no advisory.

The replay model (`tools/lib/replay-model.mjs`) mirrors `stageAdvisory`,
`wouldExceed` and `commit`. A mirror can drift, so it is checked against the genuine
`@deepseek-ai/dsh-tools` ToolRuntime with the genuine plugin applied:

| Session | advisories (model / real) | gate calls (model / real) |
| --- | --- | --- |
| `session-bde461ca` (ovms research, 858 calls, caps 9) | 38 / 38 | 698 / 698 |
| `session-bde461ca` (same, candidate caps 16) | 20 / 20 | 476 / 476 |
| `session-7096f262` (Vulkan SDK build, candidate caps 16) | 15 / 15 | 246 / 246 |
| `session-f5b69b6c` (known-good t5) | 2 / 2 | 0 / 0 |
| `session-ad46150a` (the run §4 complains about) | 2 / 2 | 0 / 0 |

Exact match in every case, at both cap settings. The model is trustworthy.

**A harness gotcha worth recording:** `lib/window.js` keys its state by the live Agent
object in a `WeakMap`, not by the agent's id. A replay that hands the plugin a fresh
`{ id }` per call silently gets a fresh window every time and measures nothing — it
reports zero advisories and zero denials on a session that has hundreds of both.

## 3. Corpus

- 109 sessions not known to be stuck: 103 from the workspace history (real agent work,
  outcome unlabelled) plus the 6 labelled `bonsai2` runs.
- 1 known-stuck fixture: `t5-fixation-bash-calls.json`, 30 calls, all on
  `api.weather.gc.ca`.
- Settings throughout: `window: 16`, caps 9, `warnAt: 3`, `summarizeAt: 6`.

## 4. Findings

### 4.1 The scale is clamped by the window

The window is 16 calls, so `host:api.weather.gc.ca` cannot be counted more than 16
times (17 when one call contributes twice). Every session in the corpus that looked
stuck sits at exactly **17 — saturation**, not at 29. The report's "29" is a
*turn-total*, not a windowed count: windowed, the stuck run is indistinguishable from
the ceiling.

Consequences that are not obvious from the defaults:

- **Any threshold above 16 is dead code.** `summarizeAt: 20` can never fire.
- **Any `summarizeAt` at or above a measure's cap is dead code** — the gate fires
  first. With caps at 9 and `summarizeAt: 6` this works today, but the report's
  suggested `summarizeAt: 12–16` would be unreachable unless the caps move with it.
  This is the single most important correction to §4's suggestion.

### 4.2 The observed distribution

Peak of the enabled measures, per session:

| group | n | min | p50 | p90 | max |
| --- | --- | --- | --- | --- | --- |
| known-good (`pass`) | 6 | 0 | 1 | 6 | 6 |
| unlabelled real work | 103 | 0 | 2 | 13 | 17 |
| known-stuck | 1 | 17 | 17 | 17 | 17 |

Two facts matter. A known-good run reached **6**, which is at `summarizeAt`; and 10% of
real work reaches **≥13**, which is well above the cap of 9. The gap the report hoped
for (4 → 29) is really **6 → 17**, and it is narrow because the window clamps it.

### 4.3 The cost at the shipped defaults

Over the 109 non-stuck sessions: **629 advisory messages**, 49 sessions warned, **19
sessions gated**, and 2296 calls blocked. A single session received 133 advisories.

### 4.4 Attribution: `host:` is the lever, not the thresholds

Messages and gates by measure kind, at the shipped defaults:

| measure | advisory msgs | sessions affected | sessions gated |
| --- | --- | --- | --- |
| `host` | 275 | 39 | 17 |
| `cmd` | 165 | 13 | 5 |
| `exact` | 94 | 7 | 5 |
| `net` | 69 | 23 | 4 |
| `sink` | 26 | 13 | 0 |

48 `(session, fingerprint)` pairs reach a cap; **25 of them are `host:`**. What the
`host:` measure cannot distinguish:

- **genuine fixation** — `host:api.weather.gc.ca` peak 17 with the model re-querying
  the same endpoint (this is the loop we want);
- **legitimate one-host work** — `host:packages.lunarg.com` peak 17 while installing a
  Vulkan SDK, and `host:raw.githubusercontent.com` peak 17 while fetching many
  different files. Same shape, different meaning. The path is what differs, and
  `host:` discards the path by design.

For those two sessions no cap below the window helps: at cap 16 they still produce 246
and 476 blocked calls respectively, because the window genuinely is saturated by one
host. This is a property of the measure, not of the threshold — the report's §3 and §5
direction (a coarser measure needs more evidence, or the path should be kept) is the
right long-term fix.

## 5. Whole-configuration candidates

Stages and caps are one system, so each row is a complete loadable configuration
measured over the same corpus. "Dead stages" means a stage that can never fire.

| candidate | msgs | runs warned | runs gated | gate calls | dead stages | stuck caught |
| --- | --- | --- | --- | --- | --- | --- |
| shipped `3/6`, caps 9 | 629 | 49/109 | 19/109 | 2296 | – | yes |
| B `6/8`, caps 9 | 304 | 33/109 | 19/109 | 2296 | – | yes |
| C `7/8`, caps 9 | 190 | 26/109 | 19/109 | 2296 | – | yes |
| **D `7/11`, caps 12 / host 16** | **158** | **26/109** | **10/109** | **1595** | – | yes |
| E `8/12`, caps 12 / host 16 | 138 | 23/109 | 10/109 | 1595 | summ | yes |
| F `9/13`, caps 14 / host 16 | 533 | 19/109 | 8/109 | 1550 | – | yes |
| G `8/13`, caps 16 | 168 | 23/109 | 8/109 | 1539 | – | yes |

F is not a typo and is rejected for it: raising the caps to 14 lets more calls through,
which gives *other* fingerprints more room to cross a threshold — messages rise while
warnings fall. Non-monotonicity is a reason to prefer a cap of 12 or 16 over 14.

## 6. Recommendation

**Config-only, shippable today — candidate D:**

```yaml
warnAt: 7
summarizeAt: 11
limits:
  exact: 12
  cmd: 12
  net: 12
  sink: 12
  host: 16          # the coarse measure needs the whole window
  site: null
  family:http-fetch: null
  verb:curl: null
  verb:wget: null
```

- advisory messages **629 → 158** (−75%)
- sessions warned **49 → 26**
- sessions gated **19 → 10** (−47%)
- blocked calls **2296 → 1595** (−31%)
- both known-good runs are left alone (their peaks are 4 and 6; the first stage is 7)
- the stuck run is still caught

If a still quieter guard is preferred, **G** (`8/13`, all caps 16) is the looser
alternative at 168 messages and 8 gated sessions, but it demands literal saturation
before it blocks, which is a real loss of sensitivity on transient loops.

**Both are config-only and need no code change.** No setting should be validated
against another — a config that sets `summarizeAt` above a cap is the operator's
business, not an error — but the *default* must not ship a stage that can never fire,
which is why `warnAt`/`summarizeAt` and the caps have to move together.

**What would change this answer:** more labelled stuck runs. The corpus has exactly one
known-stuck session, and it sits at saturation, so it is caught by any cap that is not
absurdly high. A corpus of loops that stall *below* saturation would be the first thing
to test a higher cap against.
