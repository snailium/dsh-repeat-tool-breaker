#!/usr/bin/env node
/**
 * Threshold sweep for the advisory stages (development tooling; not published).
 *
 * Issue B asked whether `warnAt: 3` / `summarizeAt: 6` sit too low. Answering that
 * needs three things the original `convergence-measurement.mjs` does not do:
 *
 *   1. Count ONLY the measures that actually escalate. `site:`, `family:*` and
 *      `verb:*` are `null`-capped, so `limitFor` returns Infinity and 0.4.1 skips
 *      them entirely. Tallying them (as the first tool did) reports messages that
 *      production can no longer deliver, which is exactly how 0.4.0's over-trigger
 *      was mistaken for a threshold problem.
 *   2. Count MESSAGES, not crossings. `stageAdvisory` emits at most ONE message per
 *      call -- the strongest stage among the call's measures wins, ties go to the
 *      higher count and then to the lower `measureRank`. One `curl` carries four
 *      fingerprints, so crossings and messages differ by a large factor.
 *   3. Report the distribution, not the maximum. A threshold is only defensible if
 *      the peak of a KNOWN-GOOD run stays below it.
 *
 * Usage:
 *   node tools/threshold-sweep.mjs [--detail] <dir-or-log> [...]
 *
 * A directory is searched recursively for `session*.jsonl.zst*`. Outcome labels
 * come from the path (see `labelOutcome`); anything unlabelled is reported as
 * `unknown` and excluded from the good/bad comparison. `--fixture <file>` replays a
 * JSON array of shell command strings as one single-turn session (the t5 fixation
 * fixture; a known-stuck run).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { DEFAULTS } from '../lib/defaults.js'
import { fingerprints } from '../lib/fingerprints.js'
import { isEnabled, replay } from './lib/replay-model.mjs'

const argv = process.argv.slice(2)
const DETAIL = argv.includes('--detail')
const FIXTURES = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--fixture') FIXTURES.push(argv[i + 1])
}
const roots = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--fixture')

function labelOutcome(path) {
  if (path.includes('budgetB')) return 'timeout'
  if (path.includes('mtp1') || path.includes('mtp2')) return 'pass'
  if (path.includes('suite-v040')) return 'pass'
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

/** Turn a fixture (an array of command strings) into synthetic tool/call events. */
function eventsFromFixture(commands) {
  return [
    { type: 'user/message', data: { source: { kind: 'user' }, content: 'fixture' } },
    ...commands.map((command, i) => ({
      type: 'tool/call',
      data: { id: `f${i}`, name: 'bash', arguments: JSON.stringify({ command }) },
    })),
  ]
}

const cfg = { ...DEFAULTS }
const logs = roots.flatMap(collectLogs)

// Sessions are keyed by their parent directory: a migrated log exists twice.
const bySession = new Map()
for (const log of logs) {
  const id = basename(join(log, '..'))
  const prev = bySession.get(id)
  if (prev && prev.log !== log) {
    // Keep the larger file; the v3 rewrite is the complete one.
    const bigger = statSync(log).size > statSync(prev.log).size ? log : prev.log
    bySession.set(id, { id, log: bigger, outcome: prev.outcome })
  } else {
    bySession.set(id, { id, log, outcome: labelOutcome(log) })
  }
}
for (const f of FIXTURES) {
  bySession.set(`fixture:${basename(f)}`, { id: `fixture:${basename(f)}`, fixture: f, outcome: 'stuck' })
}

const sessions = []
for (const s of bySession.values()) {
  let events
  try {
    events = s.fixture ? eventsFromFixture(JSON.parse(readFileSync(s.fixture, 'utf8'))) : readEvents(s.log)
  } catch (err) {
    console.error(`skip ${s.id}: ${err.message}`)
    continue
  }
  sessions.push({ ...s, events })
}

console.log(`replaying ${sessions.length} sessions (window=${cfg.window}, enabled measures only)\n`)

// ---------------------------------------------------------------------------
// 1. The shape of the problem: peak per session, split by outcome.
// ---------------------------------------------------------------------------
console.log('=== per-session peak of the ENABLED measures (the only ones that escalate) ===')
const rows = []
for (const s of sessions) {
  const r = replay(s.events, cfg, fingerprints, DEFAULTS.warnAt, DEFAULTS.summarizeAt)
  let peak = 0
  let which = ''
  for (const [fp, n] of r.peak) {
    if (isEnabled(fp, cfg.limits) && n > peak) {
      peak = n
      which = fp
    }
  }
  // Peak of the host: family only, which is the measure Issue B is really about.
  let hostPeak = 0
  let hostWhich = ''
  for (const [fp, n] of r.peak) {
    if (fp.startsWith('host:') && n > hostPeak) {
      hostPeak = n
      hostWhich = fp
    }
  }
  rows.push({ ...s, ...r, peak, which, hostPeak, hostWhich })
}
rows.sort((a, b) => b.peak - a.peak)
for (const r of rows) {
  if (!DETAIL && r.outcome === 'unknown' && r.peak < 6) continue
  console.log(
    `${r.outcome.padEnd(8)} calls=${String(r.calls).padStart(4)} busiestTurn=${String(r.maxTurnCalls).padStart(3)} ` +
      `peak=${String(r.peak).padStart(3)} (${r.which || '-'}) hostPeak=${String(r.hostPeak).padStart(3)} ` +
      `advices=${r.advices.length} gateAsks=${r.gateAsks}  ${r.id}`,
  )
}

const byOutcome = new Map()
for (const r of rows) {
  if (!byOutcome.has(r.outcome)) byOutcome.set(r.outcome, [])
  byOutcome.get(r.outcome).push(r)
}
console.log('\n--- peak distribution by outcome ---')
for (const [outcome, rs] of byOutcome) {
  const peaks = rs.map((r) => r.peak).sort((a, b) => a - b)
  const p = (q) => (peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(q * peaks.length))] : 0)
  console.log(
    `  ${outcome.padEnd(8)} n=${String(rs.length).padStart(3)}  peak min=${peaks[0] ?? 0} ` +
      `p50=${p(0.5)} p90=${p(0.9)} max=${peaks[peaks.length - 1] ?? 0}`,
  )
}

// ---------------------------------------------------------------------------
// 2. The sweep: what each (warnAt, summarizeAt) pair would have cost.
// ---------------------------------------------------------------------------
// "Cost" is measured on every session NOT known to be stuck, because a session with
// an unknown outcome is still evidence about false positives: it is real work, and
// these are real messages that would have interrupted it.
console.log(`\n=== threshold sweep === (caps unchanged: ${JSON.stringify(cfg.limits)}; window=${cfg.window})`)
console.log('   warns/summarize | cost group (pass+unknown)                          | stuck')
console.log('     warn summ     | runs warned  total msgs  mean  p95  max | runs gated  gate calls | reachable? | caught')
const cost = rows.filter((r) => r.outcome !== 'stuck' && r.outcome !== 'timeout')
const stuck = rows.filter((r) => r.outcome === 'stuck' || r.outcome === 'timeout')

// ---------------------------------------------------------------------------
// 1b. Who is speaking: attribute every message and every gate to its measure kind.
// ---------------------------------------------------------------------------
// This is what turns "the thresholds are too low" into a targeted change. A measure
// that dominates the traffic is the lever; one that never appears is not.
console.log('\n=== attribution at the SHIPPED defaults ===')
const kindOf = (fp) => (fp.startsWith('host:') ? 'host' : fp.split(':')[0])
const attribution = new Map()
const gateAttribution = new Map()
const bump = (map, kind, field) => {
  const k = map.get(kind) ?? { msgs: 0, runs: new Set(), calls: 0 }
  k[field] += 1
  map.set(kind, k)
}
for (const r of cost) {
  const rr = replay(r.events, cfg, fingerprints, DEFAULTS.warnAt, DEFAULTS.summarizeAt)
  const seen = new Set()
  for (const a of rr.advices) {
    bump(attribution, kindOf(a.fp), 'msgs')
    if (!seen.has(kindOf(a.fp))) {
      seen.add(kindOf(a.fp))
      attribution.get(kindOf(a.fp)).runs.add(r.id)
    }
  }
  if (rr.gateCalls > 0) {
    const kinds = new Set()
    for (const [fp, n] of rr.peak) {
      if (!isEnabled(fp, cfg.limits)) continue
      const cap = cfg.limits[kindOf(fp)] ?? cfg.limits[fp]
      if (typeof cap === 'number' && n >= cap) kinds.add(kindOf(fp))
    }
    for (const k of kinds) bump(gateAttribution, k, 'calls')
  }
}
console.log('  measure     advisory msgs   sessions affected (of ' + cost.length + ')   sessions gated')
const allKinds = new Set([...attribution.keys(), ...gateAttribution.keys()])
for (const kind of [...allKinds].sort((a, b) => (attribution.get(b)?.msgs ?? 0) - (attribution.get(a)?.msgs ?? 0))) {
  const a = attribution.get(kind)
  const g = gateAttribution.get(kind)
  console.log(
    `  ${kind.padEnd(11)} ${String(a?.msgs ?? 0).padStart(8)}   ${String(a?.runs.size ?? 0).padStart(6)}` +
      `                     ${String(g?.calls ?? 0).padStart(6)}`,
  )
}

const cap = Math.max(...Object.values(cfg.limits).filter((v) => Number.isFinite(v)))
const sweep = []
for (const warn of [3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
  for (const summ of [4, 6, 8, 10, 12, 14, 16, 20]) {
    if (summ <= warn) continue
    const runs = cost.map((r) => replay(r.events, cfg, fingerprints, warn, summ))
    const msgs = runs.map((r) => r.advices.length)
    const warned = msgs.filter((n) => n > 0).length
    const total = msgs.reduce((a, b) => a + b, 0)
    const sorted = [...msgs].sort((a, b) => a - b)
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0
    const maxMsg = sorted[sorted.length - 1] ?? 0
    const mean = msgs.length ? total / msgs.length : 0
    const gates = runs.map((r) => r.gateCalls)
    const gatedRuns = gates.filter((n) => n > 0).length
    const totalGates = gates.reduce((a, b) => a + b, 0)
    const stage2 = runs.filter((r) => r.advices.some((a) => a.stage === 2)).length
    const stuckCaught = stuck.filter((r) => {
      const rr = replay(r.events, cfg, fingerprints, warn, summ)
      return rr.advices.length > 0 || rr.gateCalls > 0
    }).length
    // A threshold above the window is dead: the window can never hold that many of
    // one fingerprint, so the stage is unreachable whatever the workload does.
    // Likewise stage 2 is unreachable when the cap fires first.
    const reach = summ >= cfg.window ? 'dead' : summ >= cap ? `stage2>=cap${cap}` : 'yes'
    sweep.push({ warn, summ, warned, total, mean, p95, maxMsg, stage2, gatedRuns, totalGates, stuckCaught, reach })
    console.log(
      `     ${String(warn).padStart(4)} ${String(summ).padStart(4)}     | ` +
        `${String(warned).padStart(4)}/${String(cost.length).padEnd(3)}  ${String(total).padStart(7)}  ` +
        `${mean.toFixed(2).padStart(5)} ${String(p95).padStart(3)} ${String(maxMsg).padStart(4)} | ` +
        `${String(gatedRuns).padStart(4)}/${String(cost.length).padEnd(4)} ${String(totalGates).padStart(9)} | ` +
        `${reach.padEnd(10)} | ${stuckCaught}/${stuck.length}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Recommendation.
// ---------------------------------------------------------------------------
const viable = sweep.filter((s) => s.stuckCaught === stuck.length && s.reach === 'yes')
console.log('\n--- viable pairs (every stuck run still caught; both stages reachable) ---')
if (viable.length === 0) {
  console.log('  (none -- every pair either misses a stuck run or has a dead stage)')
} else {
  console.log('  warn summ | warned/cost  total msgs   mean   p95  max')
  for (const v of viable) {
    console.log(
      `  ${String(v.warn).padStart(4)} ${String(v.summ).padStart(4)} | ` +
        `${String(v.warned).padStart(4)}/${String(cost.length).padEnd(4)} ${String(v.total).padStart(9)}  ` +
        `${v.mean.toFixed(2).padStart(6)} ${String(v.p95).padStart(4)} ${String(v.maxMsg).padStart(4)}`,
    )
  }
  const quiet = viable.filter((v) => v.warned === 0)
  console.log(
    quiet.length
      ? `  lowest-cost pair with no false positive: warnAt=${quiet[0].warn} summarizeAt=${quiet[0].summ}`
      : `  cheapest pair: warnAt=${viable[0].warn} summarizeAt=${viable[0].summ} (${viable[0].warned} runs warned)`,
  )
}

// ---------------------------------------------------------------------------
// 4. Whole-configuration candidates.
// ---------------------------------------------------------------------------
// The stages and the caps are one system: a `summarizeAt` at or above a measure's
// cap is dead code, because the gate fires first. So the report's suggestion of
// `summarizeAt: 12-16` is only meaningful together with raised caps. Each row below
// is a complete, loadable configuration, measured over the same corpus.
console.log('\n=== whole-configuration candidates ===')
const CANDIDATES = [
  ['shipped 3/6 cap9', { warnAt: 3, summarizeAt: 6, limits: DEFAULTS.limits }],
  ['B  6/8 cap9', { warnAt: 6, summarizeAt: 8, limits: DEFAULTS.limits }],
  ['C  7/8 cap9', { warnAt: 7, summarizeAt: 8, limits: DEFAULTS.limits }],
  ['D  7/11 cap12/16', { warnAt: 7, summarizeAt: 11, limits: { exact: 12, cmd: 12, net: 12, sink: 12, host: 16 } }],
  ['E  8/12 cap12/16', { warnAt: 8, summarizeAt: 12, limits: { exact: 12, cmd: 12, net: 12, sink: 12, host: 16 } }],
  ['F  9/13 cap14/16', { warnAt: 9, summarizeAt: 13, limits: { exact: 14, cmd: 14, net: 14, sink: 14, host: 16 } }],
  ['G  8/13 cap16', { warnAt: 8, summarizeAt: 13, limits: { exact: 16, cmd: 16, net: 16, sink: 16, host: 16 } }],
]
console.log('  candidate          | msgs  runs warned | runs gated  gate calls | dead stages | stuck caught')
for (const [label, over] of CANDIDATES) {
  const c = { ...DEFAULTS, ...over }
  const caps = Object.values(c.limits).filter((v) => Number.isFinite(v))
  let msgs = 0
  let warned = 0
  let gated = 0
  let gateCalls = 0
  const dead = []
  if (c.summarizeAt !== null && c.summarizeAt >= Math.min(...caps)) dead.push('summ')
  if (c.warnAt !== null && c.warnAt >= c.summarizeAt) dead.push('warn')
  for (const r of cost) {
    const rr = replay(r.events, c, fingerprints, c.warnAt, c.summarizeAt)
    msgs += rr.advices.length
    if (rr.advices.length > 0) warned += 1
    if (rr.gateCalls > 0) gated += 1
    gateCalls += rr.gateCalls
  }
  const stuckCaught = stuck.filter((r) => {
    const rr = replay(r.events, c, fingerprints, c.warnAt, c.summarizeAt)
    return rr.advices.length > 0 || rr.gateCalls > 0
  }).length
  console.log(
    `  ${label.padEnd(18)} | ${String(msgs).padStart(4)}  ${String(warned).padStart(4)}/${String(cost.length).padEnd(4)}    | ` +
      `${String(gated).padStart(4)}/${String(cost.length).padEnd(4)} ${String(gateCalls).padStart(9)} | ` +
      `${(dead.join(',') || '-').padEnd(11)} | ${stuckCaught}/${stuck.length}`,
  )
}
