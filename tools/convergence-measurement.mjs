#!/usr/bin/env node
/**
 * Convergence-guard measurement (development tooling; not published).
 *
 * SUPERSEDED by `threshold-sweep.mjs`. Kept for provenance: this is the tool that
 * produced the measurement which set the original thresholds, so its output is the
 * record of that decision. Two things make its numbers unsafe to reuse:
 *
 *   - it tallies EVERY fingerprint, including the `null`-capped `site:`, `family:*`
 *     and `verb:*` measures that 0.4.1 no longer escalates at all. Its per-kind
 *     tables therefore report advisories production cannot deliver -- which is
 *     exactly how 0.4.0's over-trigger was mistaken for a threshold problem;
 *   - it counts crossings, not messages, and `stageAdvisory` emits at most one
 *     message per call.
 *
 * `threshold-sweep.mjs` fixes both and is validated against the real tool pipeline
 * by `count-model-check.mjs`. Use it for any new threshold decision.
 *
 * Replays recorded session logs through the plugin's OWN `lib/fingerprints.js`, so
 * the measurement reflects real fingerprint behaviour rather than a reimplementation.
 *
 * For every session it reports, per measure kind, the peak count inside a 12-call
 * same-turn window and how often each count crossed 3 and 5 — i.e. how often the
 * proposed CONVERGENCE warning and gate would have fired.
 *
 * Usage:
 *   node tools/convergence-measurement.mjs <dir-or-log> [...]
 *
 * A directory argument is searched recursively for `session*.jsonl.zst*`.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { DEFAULTS } from '../lib/defaults.js'
import { fingerprints } from '../lib/fingerprints.js'

const WINDOW = Number(process.env.WINDOW ?? DEFAULTS.window) // 12 by default
const WARN_AT = 3
const SUMMARIZE_AT = 6
const GATE_AT = 9

/** Outcome labels for the corpora we know. Anything else is reported as unknown. */
function labelOutcome(dir) {
  const d = dir
  if (d.includes('budgetB2')) return 'timeout'
  if (d.includes('budgetB')) return 'timeout'
  if (d.includes('mtp1')) return 'pass'
  if (d.includes('mtp2')) return 'pass'
  return 'unknown'
}

function collectLogs(arg) {
  const st = statSync(arg)
  if (st.isFile()) return [arg]
  const out = []
  for (const entry of readdirSync(arg, { withFileTypes: true })) {
    const p = join(arg, entry.name)
    if (entry.isDirectory()) out.push(...collectLogs(p))
    else if (/^session.*\.jsonl\.zst(d)?$/.test(entry.name)) out.push(p)
  }
  return out
}

function readEvents(path) {
  const buf = execFileSync('zstd', ['-dc', '--', path], { maxBuffer: 1 << 30 })
  const events = []
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* torn tail line */
    }
  }
  return events
}

/** The host part of a `net:` fingerprint value, or null. */
function hostOfNet(fp) {
  const rest = fp.slice('net:'.length)
  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  return host || null
}

/**
 * Replay one session. Returns per-kind stats.
 *
 * Turn boundaries follow the plugin: a real human message resets the window. The
 * session header's `user/message` events carry that; tool results do not.
 */
function analyse(events, cfg) {
  const kinds = new Map() // kind -> { peak, warnCrossings, gateCrossings }
  const bump = (kind, field) => {
    let k = kinds.get(kind)
    if (!k) kinds.set(kind, (k = { peak: 0, warnCrossings: 0, gateCrossings: 0 }))
    return k
  }

  // The plugin's window is 12 CALLS, each holding its own fingerprint array
  // (`lib/window.js`: `state.calls.push(...)` + `while (length > cfg.window) shift()`).
  // Truncating a flat list of fingerprints instead would under-count badly, because a
  // single `bash` call with several URLs contributes many fingerprints at once.
  let window = [] // the last WINDOW calls, each an array of that call's fingerprints
  let calls = 0
  let turns = 0
  // Calls within the current human turn. The window resets per turn, so a measure can
  // only ever accumulate up to this value — a stage above it is unreachable no matter
  // how large the window is.
  let turnCalls = 0
  let maxTurnCalls = 0

  for (const e of events) {
    if (e.type === 'user/message') {
      // Only a HUMAN message resets the window — the plugin's `hasUserMessage`
      // trusts the human source alone. Runtime-context injections and compaction
      // checkpoints also arrive as `user/message` with source.kind 'plugin' and
      // must NOT reset it.
      if ((e.data?.source?.kind ?? null) === 'user') {
        window = []
        turns += 1
        if (turnCalls > maxTurnCalls) maxTurnCalls = turnCalls
        turnCalls = 0
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
    let result
    try {
      result = fingerprints({ name: data.name, arguments: args }, cfg)
    } catch {
      continue
    }
    const fps = result?.fps ?? []
    window.push(fps)
    while (window.length > WINDOW) window.shift()
    calls += 1
    turnCalls += 1

    // Tally by FULL fingerprint identity. The plugin counts `counts.get(fp)` — the
    // whole string — never per kind: `lib/window.js` does `tally(calls)` over the
    // fingerprint strings. Counting per kind makes every kind equal the window size
    // and reports a loop that does not exist.
    const counts = new Map()
    for (const callFps of window) {
      for (const fp of callFps) counts.set(fp, (counts.get(fp) ?? 0) + 1)
    }
    // Derived host identity: one measure per host, any path or query.
    for (const [fp, n] of [...counts]) {
      if (!fp.startsWith('net:')) continue
      const h = hostOfNet(fp)
      if (h) counts.set(`host:${h}`, (counts.get(`host:${h}`) ?? 0) + n)
    }
    for (const [fp, n] of counts) {
      const key = fp.startsWith('host:') ? `host(${fp.slice(5)})` : fp.split(':')[0]
      const k = bump(key)
      if (n > k.peak) k.peak = n
      if (n === WARN_AT) k.warnCrossings += 1
      if (n === GATE_AT) k.gateCrossings += 1
    }
  }
  if (turnCalls > maxTurnCalls) maxTurnCalls = turnCalls
  return { kinds, calls, turns, maxTurnCalls }
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node tools/convergence-measurement.mjs <dir-or-log> [...]')
  process.exit(2)
}

const cfg = { ...DEFAULTS }
const logs = args.flatMap(collectLogs)
const rows = []

for (const log of logs) {
  let events
  try {
    events = readEvents(log)
  } catch (err) {
    console.error(`skip ${log}: ${err.message}`)
    continue
  }
  const { kinds, calls, turns, maxTurnCalls } = analyse(events, cfg)
  const outcome = labelOutcome(log)
  // Peak host/site separately, because those are the convergence candidates.
  let hostPeak = 0
  let sitePeak = 0
  for (const [kind, k] of kinds) {
    if (kind.startsWith('host(') && k.peak > hostPeak) hostPeak = k.peak
    if (kind === 'site' && k.peak > sitePeak) sitePeak = k.peak
  }
  const warns = [...kinds.entries()].reduce((a, [, k]) => a + k.warnCrossings, 0)
  // Which measures would reach the gate, and how far they got.
  const gating = [...kinds.entries()]
    .filter(([, k]) => k.peak >= GATE_AT)
    .map(([kind, k]) => `${kind}=${k.peak}`)
    .sort()
  rows.push({ log, id: basename(join(log, '..')), outcome, turns, calls, maxTurnCalls, hostPeak, sitePeak, warns, kinds, gating })
}

// A migrated session exists twice on disk (v0 `session.jsonl.zstd` + v3
// `session.v3.jsonl.zstd`). Keep one row per session id — the one with more calls.
const byId = new Map()
for (const r of rows) {
  const prev = byId.get(r.id)
  if (!prev || r.calls > prev.calls) byId.set(r.id, r)
}
const unique = [...byId.values()]
if (unique.length !== rows.length) {
  console.log(`(deduped ${rows.length} logs -> ${unique.length} sessions)\n`)
}
unique.sort((a, b) => b.calls - a.calls)

for (const r of unique) {
  console.log(
    `${r.outcome.padEnd(8)} calls=${String(r.calls).padStart(4)} turns=${String(r.turns).padStart(3)} ` +
      `hostPeak=${String(r.hostPeak).padStart(3)} sitePeak=${String(r.sitePeak).padStart(3)}  ${r.id}`,
  )
  if (process.env.DETAIL) {
    const top = [...r.kinds.entries()]
      .filter(([, k]) => k.peak >= WARN_AT)
      .sort((x, y) => y[1].peak - x[1].peak)
      .map(([kind, k]) => `${kind}=${k.peak}${k.peak >= GATE_AT ? '[gate]' : k.peak >= SUMMARIZE_AT ? '[summ]' : '[warn]'}`)
    console.log(`         tripping: ${top.join('  ') || '(none)'}`)
  }
}

console.log(
  `\n--- per measure: sessions whose peak reaches each stage (of ${unique.length} sessions) ---`,
)
const agg = new Map()
for (const r of unique) {
  for (const [kind, k] of r.kinds) {
    const a = agg.get(kind) ?? { peak: 0, s3: 0, s6: 0, s9: 0 }
    a.peak = Math.max(a.peak, k.peak)
    if (k.peak >= WARN_AT) a.s3 += 1
    if (k.peak >= SUMMARIZE_AT) a.s6 += 1
    if (k.peak >= GATE_AT) a.s9 += 1
    agg.set(kind, a)
  }
}
// Union over a candidate measure set (set A: the capped measures + the new host).
const inSetA = (kind) => ['exact', 'cmd', 'net', 'sink'].includes(kind) || kind.startsWith('host(')
const unionCounts = (set) => {
  let s3 = 0
  let s6 = 0
  let s9 = 0
  for (const r of unique) {
    const peaks = [...r.kinds.entries()].filter(([kind]) => set(kind)).map(([, k]) => k.peak)
    if (peaks.some((p) => p >= WARN_AT)) s3 += 1
    if (peaks.some((p) => p >= SUMMARIZE_AT)) s6 += 1
    if (peaks.some((p) => p >= GATE_AT)) s9 += 1
  }
  return { s3, s6, s9 }
}

for (const [kind, a] of [...agg.entries()].sort((x, y) => y[1].s9 - x[1].s9 || y[1].s3 - x[1].s3)) {
  console.log(
    `  ${kind.padEnd(34)} maxPeak=${String(a.peak).padStart(3)}  >=3:${String(a.s3).padStart(3)}  >=6:${String(a.s6).padStart(3)}  >=9:${String(a.s9).padStart(3)}`,
  )
}

const a = unionCounts(inSetA)
const hostOnly = unionCounts((k) => k.startsWith('host('))
const hostNet = unionCounts((k) => k.startsWith('host(') || k === 'net')
console.log('\n--- union over candidate measure sets (sessions reaching each stage) ---')
console.log(`  set A  exact/cmd/net/sink/host : >=3:${a.s3}  >=6:${a.s6}  >=9:${a.s9}`)
console.log(`  host + net                     : >=3:${hostNet.s3}  >=6:${hostNet.s6}  >=9:${hostNet.s9}`)
console.log(`  host only                      : >=3:${hostOnly.s3}  >=6:${hostOnly.s6}  >=9:${hostOnly.s9}`)

// The per-turn reset caps what any measure can reach: a stage above the busiest turn's
// call count is unreachable no matter how large WINDOW is.
const mt = unique.map((r) => r.maxTurnCalls ?? 0)
const dist = new Map()
for (const n of mt) dist.set(n, (dist.get(n) ?? 0) + 1)
console.log('\n--- calls in the busiest human turn per session (the ceiling on any measure) ---')
for (const n of [...dist.keys()].sort((a, b) => a - b)) {
  console.log(`  busiest turn = ${String(n).padStart(3)} calls : ${dist.get(n)} sessions`)
}
console.log(`  sessions whose busiest turn is < 3 calls: ${mt.filter((n) => n < 3).length}`)
console.log(`  ... < 6 (stages 2-3 unreachable): ${mt.filter((n) => n < 6).length}`)
console.log(`  ... < 9 (stage 3 unreachable whatever the window): ${mt.filter((n) => n < 9).length}`)
