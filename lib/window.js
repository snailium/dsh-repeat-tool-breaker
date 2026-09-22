/**
 * The per-agent sliding window of recent calls, and the prediction step the
 * guard runs before committing the current call.
 *
 * State is keyed by the live `Agent` object in a `WeakMap`, so it is released
 * with the agent and never leaks across agents working in parallel (a subagent
 * gets its own budget).
 *
 * Everything here is scoped to the CURRENT human turn: `reset` is called when a
 * real user message arrives, and it drops the window, the exemptions and the
 * refusals together.
 *
 * ## Two counters, one set of measures
 *
 * The window counts OCCURRENCES; `failStreak` counts consecutive FAILURES of one
 * fingerprint. They are separate tracks with separate thresholds, but they
 * deliberately share the measure set: a fingerprint whose cap is `null` is
 * disabled for both. Letting the failure track see the disabled volume measures
 * (`site:`, `family:*`, `verb:*`) would reintroduce the 0.4.0 bug through a new
 * channel — measured on the corpus, the longest failure streaks in the whole
 * corpus sat on exactly those measures (9 on `family:http-fetch`, 8 on
 * `verb:curl`, 7 on `verb:export`).
 */

import { limitFor } from './fingerprints.js'

/** A shared empty set, so a never-seen agent does not allocate one to read it. */
const EMPTY_SET = new Set()

/**
 * Count occurrences of every fingerprint over the last `window` committed
 * calls.
 * @param calls - committed fingerprint lists, oldest first.
 * @param window - how many trailing calls participate.
 * @returns fingerprint -> count.
 */
function tally(calls, window) {
  const counts = new Map()
  for (const fps of calls.slice(-window)) {
    for (const fp of fps) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }
  return counts
}

/**
 * Whether the given message list contains a message from the human. Plugin
 * notices (`source.kind === 'plugin'`) deliberately do NOT qualify — only a
 * real user turn clears an agent's window.
 * @param messages - the pre-step message list.
 * @returns whether a user-sourced message is present.
 */
export function hasUserMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message?.source?.kind === 'user')
}

/**
 * Build a tracker over one plugin instance.
 * @param cfg - merged configuration.
 * @returns the tracker API.
 */
export function createTracker(cfg) {
  const byAgent = new WeakMap()

  function slot(agent) {
    let state = byAgent.get(agent)
    if (state === undefined) {
      state = {
        calls: [],
        lastResult: '',
        exempt: new Set(),
        refused: new Set(),
        failStreak: new Map(),
        failDetail: new Map(),
      }
      byAgent.set(agent, state)
    }
    return state
  }

  /** Read an agent's state without creating one for an agent we never saw. */
  function peek(agent) {
    return byAgent.get(agent)
  }

  /**
   * Fingerprint -> count over the last `window` committed calls, before the
   * current call is added. The guard uses this for both the cap prediction and
   * the two advisory stages, so there is exactly one counter.
   * @param agent - the calling agent.
   * @returns the count map.
   */
  function tallyOf(agent) {
    return tally(slot(agent).calls, cfg.window)
  }

  /**
   * Which of this call's fingerprints would reach their cap if the call ran.
   * Called with the call NOT yet committed, so the count it compares is "how
   * many identical ones are already in the window".
   * @param agent - the calling agent.
   * @param fps - the call's fingerprints.
   * @returns the offending `{ fp, next, cap }` entries (empty = allow).
   */
  function wouldExceed(agent, fps) {
    const counts = tallyOf(agent)
    const hits = []
    for (const fp of fps) {
      const next = (counts.get(fp) ?? 0) + 1
      const cap = limitFor(fp, cfg.limits)
      if (next >= cap) hits.push({ fp, next, cap })
    }
    return hits
  }

  /**
   * Record how a settled call turned out, and report the failure-stage crossings.
   *
   * A fingerprint's streak grows while that fingerprint keeps failing and is
   * cleared the moment it succeeds. A success of a DIFFERENT fingerprint does not
   * clear it: a model that fails a build, reads a file, then fails the build again
   * has failed the build twice, and the read is not progress on the build.
   *
   * Only measures with a finite cap participate, and an exempted measure is not
   * counted at all — the same "stop counting" rule the occurrence track obeys.
   *
   * @param agent - the calling agent.
   * @param fps - the settled call's fingerprints.
   * @param failed - whether the call failed (`null` from the classifier = no).
   * @returns the `{ fp, streak }` entries that reached `failWarnAt` exactly.
   */
  function noteOutcome(agent, fps, failed) {
    const state = slot(agent)
    const warned = []
    for (const fp of fps) {
      if (!Number.isFinite(limitFor(fp, cfg.limits))) continue
      if (state.exempt.has(fp)) continue
      if (failed === null) {
        state.failStreak.delete(fp)
        state.failDetail.delete(fp)
        continue
      }
      const streak = (state.failStreak.get(fp) ?? 0) + 1
      state.failStreak.set(fp, streak)
      // Remember the reason: the denial has to say WHY the target is being
      // blocked, and by then the failing result is several calls back.
      state.failDetail.set(fp, failed)
      if (cfg.failWarnAt !== null && streak === cfg.failWarnAt) warned.push({ fp, streak })
    }
    return warned
  }

  /**
   * Which of this call's fingerprints have already failed `failLimit` times in a
   * row. Unlike {@link wouldExceed} this is not a prediction — the failures have
   * already happened, so the count is compared directly.
   * @param agent - the calling agent.
   * @param fps - the pending call's fingerprints.
   * @returns the offending `{ fp, next, cap, kind }` entries (empty = allow).
   */
  function failureHits(agent, fps) {
    if (cfg.failLimit === null) return []
    const state = peek(agent)
    if (state === undefined) return []
    const hits = []
    for (const fp of fps) {
      if (!Number.isFinite(limitFor(fp, cfg.limits))) continue
      const streak = state.failStreak.get(fp)
      if (streak === undefined || streak < cfg.failLimit) continue
      hits.push({
        fp,
        next: streak,
        cap: cfg.failLimit,
        kind: 'failure',
        detail: state.failDetail.get(fp) ?? null,
      })
    }
    return hits
  }

  /**
   * The current consecutive-failure streak of one fingerprint (0 when none).
   * @param agent - the calling agent.
   * @param fp - the fingerprint.
   * @returns the streak length.
   */
  function failStreakOf(agent, fp) {
    return peek(agent)?.failStreak.get(fp) ?? 0
  }

  /**
   * Record a call. It is committed on BOTH paths — an allowed call and a denied
   * one alike — so a model that hammers a denied call cannot reset the counter,
   * and two calls racing in the same step cannot both observe an empty window.
   *
   * What is recorded differs by outcome, and that difference is load-bearing:
   *
   *   - an ALLOWED call commits every fingerprint it carries (the action really
   *     happened, so it owns its share of the budget);
   *   - a DENIED call commits only the fingerprints that HIT their cap. The
   *     action never ran, so it must not spend budget on a resource it never
   *     touched — a measured run showed a denied `curl https://example.org`
   *     poisoning `net:example.org/`, after which the model could not fetch that
   *     URL by ANY tool for the rest of the turn. The hitting fingerprints are
   *     already at their cap, so re-attempting the blocked call stays blocked.
   *
   * Fingerprints the operator has exempted are dropped before recording, which is
   * what "stop counting" means: an exempted measure is not incremented and cannot
   * escalate again this turn.
   * @param agent - the calling agent.
   * @param fps - the call's fingerprints.
   * @param hits - the offending entries from {@link wouldExceed}, empty when allowed.
   */
  function commit(agent, fps, hits = []) {
    const state = slot(agent)
    const record = (hits.length > 0 ? hits.map((entry) => entry.fp) : fps).filter(
      (fp) => !state.exempt.has(fp),
    )
    if (record.length === 0) return
    state.calls.push(record)
    while (state.calls.length > cfg.window) state.calls.shift()
  }

  /** Forget an agent's window, exemptions and refusals (a new human turn). */
  function reset(agent) {
    byAgent.delete(agent)
  }

  /**
   * The fingerprints the operator approved an exemption for, this turn. Empty for
   * an agent we have never seen, without allocating.
   * @param agent - the calling agent.
   * @returns the exempt fingerprint set (do not mutate).
   */
  function exemptSet(agent) {
    return peek(agent)?.exempt ?? EMPTY_SET
  }

  /**
   * Exempt the fingerprints the operator just approved, for the rest of the turn.
   * @param agent - the calling agent.
   * @param fps - fingerprint strings to stop counting.
   */
  function exemptFingerprints(agent, fps) {
    const state = slot(agent)
    for (const fp of fps) state.exempt.add(fp)
  }

  /**
   * Whether this fingerprint was already declined this turn. A declined measure
   * is denied without asking again, so a refusal cannot become a prompt loop.
   * @param agent - the calling agent.
   * @param fp - the fingerprint.
   * @returns whether it was refused.
   */
  function isRefused(agent, fp) {
    return peek(agent)?.refused.has(fp) === true
  }

  /**
   * Record a refusal for the fingerprints that were asked about and declined.
   * @param agent - the calling agent.
   * @param fps - fingerprint strings.
   */
  function refuseFingerprints(agent, fps) {
    const state = slot(agent)
    for (const fp of fps) state.refused.add(fp)
  }

  return {
    wouldExceed,
    failureHits,
    failStreakOf,
    noteOutcome,
    tallyOf,
    commit,
    reset,
    slot,
    exemptSet,
    exemptFingerprints,
    isRefused,
    refuseFingerprints,
  }
}
