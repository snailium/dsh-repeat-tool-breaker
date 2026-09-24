/**
 * Would allowlisting `grep` (and its neighbours) be safe?
 *
 * The block is destination-based, so a grep whose PATTERN is a remote URL is refused
 * even though grep fetches nothing. That is a false positive by construction. The
 * question is whether exempting grep fixes a false positive or opens a bypass: the
 * exemption is per command, so a call that greps a URL and then pipes it into a real
 * downloader would flip from refused to allowed.
 *
 * Runs over the local session corpus; makes no network requests.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, mergeDefaults, validateCfg } from '../lib/defaults.js'
import { remoteFetchVerbs } from '../lib/normalize.js'

const DOWNLOADER = /\b(curl|wget)\b|urllib|\brequests\.|fetch\(|Invoke-WebRequest|\biwr\b|http\.client/
const CANDIDATES = ['grep', 'rg', 'ag', 'sed', 'awk', 'echo', 'cat', 'head', 'tail', 'sort', 'uniq', 'jq', 'python3']

function logsUnder(root, depth = 0, out = []) {
  if (depth > 5) return out
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) logsUnder(path, depth + 1, out)
    else if (/^session.*\.jsonl(\.zst|\.zstd)?$/.test(entry.name) && statSync(path).size > 0) out.push(path)
  }
  return out
}

const roots = process.argv.slice(2)
const cfg = validateCfg(mergeDefaults({}))
const allow = new Set(cfg.shellHttpAllow)

const tally = new Map()
const examples = { clean: [], downloader: [] }
const grepShapes = new Map()
let refusedCalls = 0
let grepCalls = 0

for (const root of roots) {
  for (const path of logsUnder(root)) {
    const text = /\.zst(d)?$/.test(path)
      ? execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
      : readFileSync(path, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'bash' && event.data?.name !== 'pwsh') continue
      let args = event.data.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          continue
        }
      }
      const command = args?.command
      if (typeof command !== 'string') continue

      const verbs = remoteFetchVerbs(command, cfg.hostAliases)
      if (verbs.length === 0) continue
      const refusedVerbs = verbs.filter((verb) => !allow.has(verb))
      if (refusedVerbs.length === 0) continue
      refusedCalls++

      // How does grep actually appear? If it is never the sole refused verb, exempting
      // it cannot change any decision.
      if (verbs.includes('grep')) {
        grepCalls++
        const key = refusedVerbs.filter((verb) => verb !== 'grep').join(',') || '(grep alone)'
        grepShapes.set(key, (grepShapes.get(key) ?? 0) + 1)
      }

      for (const candidate of CANDIDATES) {
        if (!verbs.includes(candidate)) continue
        const stillRefused = refusedVerbs.filter((verb) => verb !== candidate)
        if (stillRefused.length > 0) continue
        const bucket = tally.get(candidate) ?? { flips: 0, withDownloader: 0 }
        bucket.flips++
        if (DOWNLOADER.test(command)) {
          bucket.withDownloader++
          if (examples.downloader.length < 6) examples.downloader.push([candidate, command])
        } else if (examples.clean.length < 6) {
          examples.clean.push([candidate, command])
        }
        tally.set(candidate, bucket)
      }
    }
  }
}

console.log(`refused calls in corpus: ${refusedCalls}`)
console.log(`of which carry a grep segment with a remote URL: ${grepCalls}\n`)

console.log('When grep is present, what ELSE is refused in the same command?')
for (const [shape, count] of [...grepShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(count).padStart(4)}  also refused: ${shape}`)
}

console.log('\nverb        would flip to ALLOWED   of which name a downloader')
for (const [verb, bucket] of [...tally.entries()].sort((a, b) => b[1].flips - a[1].flips)) {
  console.log(`${verb.padEnd(10)}  ${String(bucket.flips).padStart(16)}  ${String(bucket.withDownloader).padStart(28)}`)
}

const show = (label, rows) => {
  console.log(`\n--- ${label}`)
  for (const [verb, command] of rows) {
    console.log(`  [${verb}] ${command.split('\n').slice(0, 2).join(' / ').slice(0, 200)}`)
  }
}
show('flip candidates that fetch NOTHING (the false positives)', examples.clean)
show('flip candidates that ALSO name a downloader (BYPASS RISK)', examples.downloader)
