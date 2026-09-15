/**
 * The per-agent sliding window of recent calls, and the prediction step the
 * guard runs before committing the current call.
 *
 * State is keyed by the live `Agent` object in a `WeakMap`, so it is released
 * with the agent and never leaks across agents working in parallel (a subagent
 * gets its own budget).
 */

import { limitFor } from './fingerprints.js'

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
      state = { calls: [], lastResult: '' }
      byAgent.set(agent, state)
    }
    return state
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
    const counts = tally(slot(agent).calls, cfg.window)
    const hits = []
    for (const fp of fps) {
      const next = (counts.get(fp) ?? 0) + 1
      const cap = limitFor(fp, cfg.limits)
      if (next >= cap) hits.push({ fp, next, cap })
    }
    return hits
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
   * @param agent - the calling agent.
   * @param fps - the call's fingerprints.
   * @param hits - the offending entries from {@link wouldExceed}, empty when allowed.
   */
  function commit(agent, fps, hits = []) {
    const state = slot(agent)
    state.calls.push(hits.length > 0 ? hits.map((entry) => entry.fp) : fps)
    while (state.calls.length > cfg.window) state.calls.shift()
  }

  /** Forget an agent's window entirely (a new human turn). */
  function reset(agent) {
    byAgent.delete(agent)
  }

  return { wouldExceed, commit, reset, slot }
}
