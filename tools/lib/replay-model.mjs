/**
 * The advisory/gate model used by the measurement tools (development tooling).
 *
 * This mirrors `apply()` in `index.js` -- `stageAdvisory`, `wouldExceed` and
 * `commit` -- closely enough to replay a recorded session offline and count the
 * messages the guard WOULD deliver. It is deliberately separate from the plugin so
 * the model can be validated against the REAL pipeline (`count-model-check.mjs`)
 * rather than trusted.
 *
 * Invariants that were wrong in the first draft of the tool, and are the reason this
 * file exists rather than a throwaway script:
 *
 *   - only measures with a FINITE cap escalate. `site:`, `family:*` and `verb:*` are
 *     `null`-capped, so `limitFor` returns Infinity and 0.4.1 skips them. Counting
 *     them reports messages production cannot deliver.
 *   - at most ONE message per call: the strongest stage wins, ties go to the higher
 *     count and then to the lower `measureRank`.
 *   - a gated call commits ONLY its blocking fingerprints, not all of them.
 */

import { limitFor } from '../../lib/fingerprints.js'

/** Mirrors `MEASURE_PREFERENCE` in index.js. */
export const MEASURE_PREFERENCE = ['host', 'net', 'site', 'sink', 'cmd', 'exact']

/** Rank one fingerprint for the tie-break; unknown kinds sort last. */
export function measureRank(fp) {
  const i = MEASURE_PREFERENCE.indexOf(fp.split(':')[0])
  return i === -1 ? MEASURE_PREFERENCE.length : i
}

/** Whether a measure can escalate at all under `limits`. */
export function isEnabled(fp, limits) {
  return Number.isFinite(limitFor(fp, limits))
}

/**
 * Replay one session's events and record every message the guard would deliver.
 *
 * @param events - session events (`user/message` and `tool/call` are the ones read).
 * @param cfg - the plugin config (its `window`, `limits` and `warnAt`/`summarizeAt`).
 * @param fingerprints - the plugin's real fingerprinter, injected so this model can
 *   never diverge from the plugin's measure set.
 * @param warnAt - the stage-1 threshold, or null to disable.
 * @param summarizeAt - the stage-2 threshold, or null to disable.
 * @returns the counters the sweep aggregates: `advices`, `gateCalls`, `gateAsks`.
 */
export function replay(events, cfg, fingerprints, warnAt, summarizeAt) {
  const limits = cfg.limits
  let window = []
  let calls = 0
  let turnCalls = 0
  let maxTurnCalls = 0
  const advices = [] // { stage, fp, next }
  let gateCalls = 0 // calls the gate blocked (advisory suppressed)
  let gateAsks = 0 // of those, the ones that raised an approval prompt
  const peak = new Map() // fp -> peak count in any window
  let refused = new Set() // per-turn: measures the operator already declined
  let exempt = new Set() // per-turn: measures approved for the rest of the turn

  for (const e of events) {
    if (e.type === 'user/message') {
      // Only a HUMAN message resets. Runtime-context injections and compaction
      // checkpoints also arrive as `user/message` with source.kind 'plugin'.
      if ((e.data?.source?.kind ?? null) === 'user') {
        window = []
        if (turnCalls > maxTurnCalls) maxTurnCalls = turnCalls
        turnCalls = 0
        refused = new Set()
        exempt = new Set()
      }
      continue
    }
    if (e.type !== 'tool/call') continue
    const data = e.data ?? {}
    let args
    try {
      args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
    } catch {
      continue
    }
    let fps
    try {
      fps = fingerprints({ name: data.name, arguments: args }, cfg)?.fps ?? []
    } catch {
      continue
    }

    const counts = new Map()
    for (const callFps of window) {
      for (const fp of callFps) counts.set(fp, (counts.get(fp) ?? 0) + 1)
    }

    // --- the gate: `wouldExceed` is `next >= cap` ---------------------------
    const hits = []
    for (const fp of fps) {
      const cap = limitFor(fp, limits)
      if (!Number.isFinite(cap)) continue
      const next = (counts.get(fp) ?? 0) + 1
      if (next < cap) continue
      hits.push(fp)
    }
    const blocking = hits.filter((fp) => !exempt.has(fp))
    const asked = blocking.filter((fp) => !refused.has(fp))
    if (blocking.length > 0) gateCalls += 1
    if (asked.length > 0) {
      gateAsks += 1
      for (const fp of asked) refused.add(fp) // one ask per measure per turn
    }

    // --- advisory stages: at most ONE message per call, and NONE when gated --
    // `guard()` returns the denial BEFORE it ever reaches `stageAdvisory`, so a
    // blocked call carries no advisory. Computing one for it is how this model
    // first over-counted.
    if (blocking.length === 0) {
      let chosen = null
      for (const fp of fps) {
        if (!isEnabled(fp, limits)) continue
        const next = (counts.get(fp) ?? 0) + 1
        let stage = 0
        if (summarizeAt !== null && next === summarizeAt) stage = 2
        else if (warnAt !== null && next === warnAt) stage = 1
        if (stage === 0) continue
        const rank = measureRank(fp)
        const better =
          chosen === null ||
          stage > chosen.stage ||
          (stage === chosen.stage &&
            (next > chosen.next || (next === chosen.next && rank < chosen.rank)))
        if (better) chosen = { stage, fp, next, rank }
      }
      if (chosen) advices.push(chosen)
    }

    // --- commit -------------------------------------------------------------
    const record = (hits.length > 0 ? hits : fps).filter((fp) => !exempt.has(fp))
    if (record.length > 0) {
      window.push(record)
      while (window.length > cfg.window) window.shift()
    }
    for (const fp of fps) {
      const n = (counts.get(fp) ?? 0) + 1
      if (n > (peak.get(fp) ?? 0)) peak.set(fp, n)
    }
    calls += 1
    turnCalls += 1
  }
  if (turnCalls > maxTurnCalls) maxTurnCalls = turnCalls
  return { calls, maxTurnCalls, advices, gateCalls, gateAsks, peak }
}

/**
 * Parse `tools/call` events into the `{ name, arguments }` shape `fingerprints`
 * takes, skipping the ones whose arguments are unreadable.
 */
export function toolCalls(events) {
  return events
    .filter((e) => e.type === 'tool/call')
    .map((e) => {
      const data = e.data ?? {}
      try {
        const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
        return { name: data.name, arguments: args }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
