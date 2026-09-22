#!/usr/bin/env node
/**
 * Consecutive-failure measurement (development tooling; not published).
 *
 * A second escalation track is under consideration: advisory at N consecutive
 * FAILURES, block at M. Failure is a much stronger signal than mere repetition, so
 * the thresholds could be tighter than the repetition track's 7/11/12 -- but only if
 * "consecutive failure" is defined in a way that separates the two workloads that
 * produce it:
 *
 *   - a model guessing at an endpoint that does not exist (the target of the idea), and
 *   - ordinary debugging, where a test or build legitimately fails several times while
 *     the agent iterates. Blocking that would be a worse over-trigger than the one this
 *     project just spent a release removing.
 *
 * Three candidate definitions are measured side by side:
 *
 *   global     every call in a row failed, whatever it was
 *   per-fp     a given fingerprint failed again with no SUCCESS of that same
 *              fingerprint in between (so an interleaved edit does not reset it)
 *   per-target same as per-fp, but only over target-scoped fingerprints (host:/net:),
 *              which is what merges "different URLs on one nonexistent host"
 *
 * Failure is NOT `result.isError`. That is true only for a thrown/blocked call
 * (~0.6% of bash calls). The real signals, in the order the layers expose them:
 *
 *   data.error                          -> a thrown failure, structured
 *   result text  [exit code: N] N != 0  -> bash's non-zero exit (not an isError)
 *   meta.statusCode / text (HTTP 4xx|5xx)
 *   text markers: timed out, killed by signal, sandbox denial
 *
 * Usage:
 *   node tools/failure-run-measurement.mjs <dir-or-log> [...]
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS } from '../lib/defaults.js'
import { classifyFailure } from '../lib/failure.js'
import { fingerprints } from '../lib/fingerprints.js'

const cfg = { ...DEFAULTS }

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
  const out = []
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* torn tail */
    }
  }
  return out
}

function labelOutcome(path) {
  if (path.includes('budgetB')) return 'timeout'
  if (path.includes('mtp1') || path.includes('mtp2')) return 'pass'
  if (path.includes('suite-v040')) return 'pass'
  return 'unknown'
}

/** The text the model received for one tool result. */
function resultText(data) {
  const blocks = data?.message?.content?.[0]?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.map((b) => b.text ?? '').join('')
}

/**
 * Rebuild a `ToolExecutionResult`-shaped object from a logged event and run the
 * plugin's OWN classifier on it.
 *
 * The log keeps only what the model saw, plus `data.error` and `data.meta`; the
 * structured `result.value` is not persisted. So this reconstruction can supply
 * `statusCode` (from meta) but never `exitCode` — a bash non-zero exit is only
 * recoverable from the `[exit code: N]` marker in the text. That limitation is the
 * reason this measurement cannot be exact, and it is why the classifier is reused
 * rather than reimplemented: the parts that CAN be reconstructed behave identically.
 */
function classify(data) {
  const text = resultText(data)
  const status = data.meta?.statusCode
  const reconstructed = {
    isError: data.error !== undefined,
    error: data.error,
    content: [{ type: 'text', text }],
    value: typeof status === 'number' ? { statusCode: status } : undefined,
  }
  const failure = classifyFailure(reconstructed)
  return failure === null ? null : failure
}

/** Longest run of consecutive `true` values. */
function longestRun(flags) {
  let best = 0
  let cur = 0
  for (const f of flags) {
    cur = f ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

const logs = process.argv.slice(2).flatMap(collectLogs)
const seen = new Set()
const rows = []

for (const log of logs) {
  const id = log.split('/').filter((x) => x.startsWith('session-') || x === 't5_session_partial').pop() ?? log
  if (seen.has(id)) continue
  seen.add(id)

  let events
  try {
    events = readEvents(log)
  } catch {
    continue
  }

  // Join calls to results on the toolCallId.
  const calls = new Map() // callId -> { name, args }
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    let args
    try {
      args = typeof e.data?.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments
    } catch {
      continue
    }
    calls.set(e.data?.id ?? e.data?.callId, { name: e.data?.name, args })
  }

  const sequence = [] // ordered { fp[], failed }
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const data = e.data ?? {}
    const callId = data.message?.content?.[0]?.toolCallId
    const call = calls.get(callId)
    if (!call) continue
    let fps = []
    try {
      fps = fingerprints({ name: call.name, arguments: call.args }, cfg)?.fps ?? []
    } catch {
      fps = []
    }
    const failure = classify(data)
    sequence.push({ fps, failed: failure !== null })
  }
  if (sequence.length === 0) continue

  // --- global: every call in a row failed ---------------------------------
  const globalRun = longestRun(sequence.map((s) => s.failed))

  // --- per-fingerprint: that fingerprint failed again, no success of it in
  //     between. A success of a DIFFERENT fingerprint does not reset it.
  const perFp = new Map()
  const perFpRuns = []
  for (const step of sequence) {
    const inThisCall = new Set(step.fps)
    for (const fp of step.fps) {
      const cur = (perFp.get(fp) ?? 0) + (step.failed ? 1 : 0)
      if (step.failed) {
        perFp.set(fp, cur)
        perFpRuns.push(cur)
      } else {
        perFp.set(fp, 0)
      }
    }
    // A fingerprint absent from this call keeps its streak (it was not retried).
    void inThisCall
  }
  const perFpRun = perFpRuns.length ? Math.max(...perFpRuns) : 0

  // --- per-target: only host:/net: ----------------------------------------
  const target = new Map()
  const targetRuns = []
  for (const step of sequence) {
    for (const fp of step.fps) {
      if (!fp.startsWith('host:') && !fp.startsWith('net:')) continue
      const cur = (target.get(fp) ?? 0) + (step.failed ? 1 : 0)
      if (step.failed) {
        target.set(fp, cur)
        targetRuns.push(cur)
      } else {
        target.set(fp, 0)
      }
    }
  }
  const targetRun = targetRuns.length ? Math.max(...targetRuns) : 0

  rows.push({
    id,
    outcome: labelOutcome(log),
    calls: sequence.length,
    failures: sequence.filter((s) => s.failed).length,
    globalRun,
    perFpRun,
    targetRun,
  })
}

rows.sort((a, b) => b.perFpRun - a.perFpRun)
console.log(`=== ${rows.length} sessions ===`)
console.log('outcome  calls  fails | global perFp perTarget   session')
for (const r of rows.slice(0, 18)) {
  console.log(
    `${r.outcome.padEnd(8)} ${String(r.calls).padStart(5)} ${String(r.failures).padStart(6)} | ` +
      `${String(r.globalRun).padStart(6)} ${String(r.perFpRun).padStart(5)} ${String(r.targetRun).padStart(9)}   ${r.id.slice(0, 22)}`,
  )
}

console.log('\n--- sessions whose longest failure run reaches each threshold ---')
for (const [name, key] of [
  ['global', 'globalRun'],
  ['per-fingerprint', 'perFpRun'],
  ['per-target', 'targetRun'],
]) {
  const at = (n) => rows.filter((r) => r[key] >= n).length
  const at3pass = rows.filter((r) => r.outcome === 'pass' && r[key] >= 3).length
  console.log(
    `  ${name.padEnd(16)} >=3: ${String(at(3)).padStart(3)}/${rows.length}   ` +
      `>=5: ${String(at(5)).padStart(3)}/${rows.length}   ` +
      `(of the known-good runs, >=3: ${at3pass})`,
  )
}

const totalFail = rows.reduce((a, r) => a + r.failures, 0)
const totalCalls = rows.reduce((a, r) => a + r.calls, 0)
console.log(
  `\nfailure rate: ${totalFail}/${totalCalls} calls (${((100 * totalFail) / totalCalls).toFixed(1)}%)`,
)
