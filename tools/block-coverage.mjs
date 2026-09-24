/**
 * Block COVERAGE: of the calls that really fetch, how many does the block refuse?
 *
 * This is the acceptance measure for the blacklist. The earlier regime was judged on
 * false POSITIVES (calls refused that fetch nothing), because it had far too many; the
 * blacklist trades a few of those back for coverage, so coverage is what has to be
 * measured now, and a small miss rate is acceptable while the interceptors grow.
 *
 * It is measured INDEPENDENTLY of the configured blacklist, or the number would be
 * circular: a call counts as fetching when one of its unwrapped candidates runs a
 * downloader — a WIDER set than `shellHttpBlock` ships with (`nc`, `socat`, `telnet`,
 * `ftp`, `lftp` are evidence, not policy) — or when a candidate names a request API. A
 * candidate aimed only at the local machine is excluded, because leaving those alone is
 * deliberate.
 *
 * Misses are printed by shape rather than counted and hidden: they are the list of
 * interceptors still to write.
 *
 *   node tools/block-coverage.mjs <sessions-root> [...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { blockShellHttp } from '../lib/block-policy.js'
import { mergeDefaults, validateCfg } from '../lib/defaults.js'
import { FETCH_API, extractUrls, firstVerb, isLocalHost, normUrl, unwrapCommands } from '../lib/normalize.js'

/** Evidence that a call fetches, deliberately wider than the shipped blacklist. */
const DOWNLOADERS = new Set([
  'curl', 'wget', 'http', 'httpie', 'aria2c', 'rclone', 'yt-dlp', 'youtube-dl',
  'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'lftp', 'tftp',
])

function walk(root, depth = 0, out = []) {
  if (depth > 5) return out
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walk(path, depth + 1, out)
    else if (/^session.*\.jsonl(\.zst|\.zstd)?$/.test(entry.name) && statSync(path).size > 0) out.push(path)
  }
  return out
}

const cfg = validateCfg(mergeDefaults({}))
const localOnly = (text) => {
  const urls = extractUrls(text)
    .map((raw) => normUrl(raw, cfg.hostAliases))
    .filter(Boolean)
  return urls.length > 0 && urls.every((url) => isLocalHost(url.host))
}

let calls = 0
let fetching = 0
let blocked = 0
let refusedTotal = 0
let refusedNonFetching = 0
const misses = []

for (const root of process.argv.slice(2)) {
  for (const path of walk(root)) {
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
      calls++

      // Does it fetch? Any candidate that runs a downloader or names a request API, and
      // is not aimed solely at the local machine.
      const fetchingCandidatesPreview = unwrapCommands(command).filter(
        (candidate) =>
          !localOnly(candidate) &&
          (DOWNLOADERS.has(firstVerb(candidate)) || FETCH_API.test(candidate)),
      )
      const refused = blockShellHttp(command, cfg)
      if (refused) {
        refusedTotal++
        if (fetchingCandidatesPreview.length === 0) refusedNonFetching++
      }

      const fetchingCandidates = unwrapCommands(command).filter(
        (candidate) =>
          !localOnly(candidate) &&
          (DOWNLOADERS.has(firstVerb(candidate)) || FETCH_API.test(candidate)),
      )
      if (fetchingCandidates.length === 0) continue
      fetching++

      if (blockShellHttp(command, cfg)) {
        blocked++
      } else if (misses.length < 4000) {
        misses.push(fetchingCandidates[0])
      }
    }
  }
}

const rate = fetching === 0 ? 1 : blocked / fetching
console.log(`shell calls replayed : ${calls}`)
console.log(`calls that really fetch: ${fetching}`)
console.log(`refused                : ${blocked}`)
console.log(`COVERAGE               : ${(rate * 100).toFixed(1)}%`)
console.log(`refused in total        : ${refusedTotal}`)
console.log(`refused that fetch NOTHING (false positives): ${refusedNonFetching}\n`)

const byVerb = new Map()
for (const miss of misses) {
  const verb = firstVerb(miss) || '(none)'
  byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1)
}
console.log('missed by verb (each is an interceptor still to write):')
for (const [verb, count] of [...byVerb.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${verb.padEnd(14)} ${count}`)
}
console.log('\nmissed, by shape (first 8):')
for (const miss of misses.slice(0, 8)) console.log(`  ${miss.replace(/\s+/g, ' ').slice(0, 150)}`)
