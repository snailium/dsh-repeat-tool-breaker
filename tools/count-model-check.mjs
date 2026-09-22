#!/usr/bin/env node
/**
 * Validate the offline replay model against the REAL pipeline (development tooling).
 *
 * `tools/lib/replay-model.mjs` mirrors `stageAdvisory` / `wouldExceed` / `commit`. A
 * mirror can drift, so every number the sweep reports is only as good as this check.
 * It replays ONE recorded session through the genuine `@deepseek-ai/dsh-tools`
 * ToolRuntime with the genuine plugin applied, counts the results that actually
 * carried an advisory (`additionalContexts`, which `onPost` attaches), and compares
 * that with what the model predicts for the identical event sequence.
 *
 * Both sides see the SAME filtered event list: only `bash` calls, because the
 * harness here registers a single stub `bash` tool. Filtering identically on both
 * sides is what makes the comparison meaningful; it does NOT claim the absolute
 * corpus-wide count.
 *
 * Usage:
 *   DSH_NODE_MODULES=/path/to/@deepseek-ai \
 *     node tools/count-model-check.mjs <session-log-or-dir> [--warn 3] [--summarize 6]
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULTS } from '../lib/defaults.js'
import { fingerprints } from '../lib/fingerprints.js'
import { replay } from './lib/replay-model.mjs'

const PROJECT = new URL('..', import.meta.url).href

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(argv[i + 1])
}
const WARN = flag('warn', DEFAULTS.warnAt)
const SUMMARIZE = flag('summarize', DEFAULTS.summarizeAt)
// A whole-configuration override, so a candidate that also moves the CAPS can be
// validated too. Passing only --warn/--summarize would leave the caps at their
// defaults and say nothing about a candidate like `7/11 cap12/16`.
const configIndex = argv.indexOf('--config')
const OVERRIDE = configIndex === -1 ? {} : JSON.parse(argv[configIndex + 1])
const roots = argv.filter((a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && argv[i - 1]?.startsWith('--') !== true && argv[i - 1] !== '--warn' && argv[i - 1] !== '--summarize')

function findLogs(arg) {
  const st = statSync(arg)
  if (st.isFile()) return [arg]
  const out = []
  for (const e of readdirSync(arg, { withFileTypes: true })) {
    const p = join(arg, e.name)
    if (e.isDirectory()) out.push(...findLogs(p))
    else if (/^session.*\.jsonl\.zst(d)?$/.test(e.name)) out.push(p)
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

async function loadDsh() {
  const root = process.env.DSH_NODE_MODULES
  const candidates = (sub, bare) => [
    ...(root ? [pathToFileURL(join(root, sub)).href] : []),
    bare,
  ]
  const pick = async (specs) => {
    for (const s of specs) {
      try {
        return await import(s)
      } catch {
        /* next */
      }
    }
    return null
  }
  const [cordis, tools, systemPrompt] = await Promise.all([
    pick(candidates('cordis/lib/index.js', '@deepseek-ai/cordis')),
    pick(candidates('dsh-tools/lib/index.js', '@deepseek-ai/dsh-tools')),
    pick(candidates('dsh-system-prompt/lib/index.js', '@deepseek-ai/dsh-system-prompt')),
  ])
  return cordis && tools && systemPrompt ? { cordis, tools, systemPrompt } : null
}

const loaded = await loadDsh()
if (loaded === null) {
  console.log('SKIPPED: dsh packages are not resolvable. Set DSH_NODE_MODULES.')
  process.exit(0)
}
const { Context } = loaded.cordis
const breaker = await import(`${PROJECT}index.js`)

/** A fresh runtime per config, with the genuine plugin applied. */
async function makeRuntime(config) {
  const ctx = new Context()
  ctx.plugin(loaded.systemPrompt.default)
  await new Promise((r) => setTimeout(r, 20))
  ctx.plugin(loaded.tools.ToolRuntime)
  await new Promise((r) => setTimeout(r, 20))
  ctx.plugin(breaker, config)
  await new Promise((r) => setTimeout(r, 50))
  ctx.tools.register(
    loaded.tools.defineTool({
      name: 'bash',
      description: 'run a shell command',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: async (args) => `ran: ${args.command}`,
    }),
  )
  let id = 0
  return (args, agent) =>
    ctx.tools.execute({
      callId: `call-${(id += 1)}`,
      name: 'bash',
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
}

const log = findLogs(roots[0] ?? '.')[0]
const all = readEvents(log)
// Keep the human turns and the bash calls; drop every other tool so both sides see
// exactly the same sequence.
const events = []
let turn = 0
for (const e of all) {
  if (e.type === 'user/message' && (e.data?.source?.kind ?? null) === 'user') {
    turn += 1
    events.push(e)
  } else if (e.type === 'tool/call' && e.data?.name === 'bash') {
    events.push(e)
  }
}

const cfg = { ...DEFAULTS, warnAt: WARN, summarizeAt: SUMMARIZE, ...OVERRIDE, limits: OVERRIDE.limits ?? DEFAULTS.limits }
const model = replay(events, cfg, fingerprints, cfg.warnAt, cfg.summarizeAt)

// --- the real pipeline ------------------------------------------------------
// `lib/window.js` keys its state by the LIVE Agent object in a WeakMap, not by the
// agent's id. Handing it a fresh `{ id }` per call therefore yields a fresh window
// every time -- no advisory and no denial, ever. One stable object per turn, which
// is exactly what the plugin's per-turn reset accomplishes in production.
const call = await makeRuntime(cfg)
const agents = new Map()
const agentFor = (t) => {
  if (!agents.has(t)) agents.set(t, { id: `turn-${t}` })
  return agents.get(t)
}
let realAdvices = 0
let realDenials = 0
let argsBad = 0
let currentTurn = 0
for (const e of events) {
  if (e.type === 'user/message') {
    currentTurn += 1
    continue
  }
  let args
  try {
    args = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments
  } catch {
    argsBad += 1
    continue
  }
  const result = await call(args, agentFor(currentTurn))
  if (Array.isArray(result?.additionalContexts) && result.additionalContexts.length > 0) realAdvices += 1
  if (result?.isError === true) realDenials += 1
}

console.log(`session : ${log}`)
console.log(`events  : ${events.length} (bash calls only, ${currentTurn} human turns)`)
console.log(`config  : warnAt=${cfg.warnAt} summarizeAt=${cfg.summarizeAt} limits=${JSON.stringify(cfg.limits)}`)
console.log('')
console.log(`              model     real`)
console.log(`advisories  ${String(model.advices.length).padStart(6)} ${String(realAdvices).padStart(8)}`)
console.log(`gate calls  ${String(model.gateCalls).padStart(6)} ${String(realDenials).padStart(8)}   (real = isError results)`)
console.log(`unparsable  ${' '.repeat(6)} ${String(argsBad).padStart(8)}`)
const ok = model.advices.length === realAdvices && model.gateCalls === realDenials
console.log(ok ? '\nCOUNT-MODEL-CHECK: MATCH' : '\nCOUNT-MODEL-CHECK: MISMATCH')
process.exit(ok ? 0 : 1)
