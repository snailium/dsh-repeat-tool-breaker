/**
 * What the shell-HTTP block costs, measured over the recorded session corpus.
 *
 * `shellHttpAllow` defaults to `['git', 'docker']`, and that default is a claim about what
 * agents actually do: which shell verbs carry a REMOTE URL, and how often. A claim like
 * that should be reproducible rather than asserted, so this tool replays the corpus through
 * the plugin's own detector and prints the verbs that would be refused.
 *
 * It is the evidence behind the default, and the way to re-derive it after the corpus
 * grows — the narrow list is only defensible while the numbers say the other verbs are
 * noise.
 *
 * Usage:
 *
 *   node tools/shell-http-allowlist-scan.mjs <session-root> [<session-root> ...]
 *   node tools/shell-http-allowlist-scan.mjs --allow git,docker <root> ...
 *
 * Each root is a dsh `sessions/` directory (the per-cwd buckets under it are walked).
 * Both log generations are read: `session*.jsonl.zst*` (v0-v2) and
 * `session.v3.jsonl.zstd` (v3). Decompression prefers `zstd -dc`.
 *
 * WHAT IT COUNTS. Only tool calls named `bash`/`pwsh`, and within them only the segments
 * the block would actually fire on: a segment carrying a non-local URL, whose first token
 * is a plausible command name. Local-only calls and URL-less calls are invisible to the
 * block by construction, so counting them would overstate the cost.
 *
 * It also separates the two populations, which is the number that actually matters for
 * judging the default:
 *
 *   - TARGET — the call names an explicit downloader (`curl`, `wget`) or an interpreter
 *     fetch (`urllib`, `requests`, `fetch(`, `Invoke-WebRequest`). Refusing these IS the
 *     feature.
 *   - INCIDENTAL — the call carries a URL but fetches nothing: `echo "see https://…"`, a
 *     heredoc rewriting a README full of links, a `git commit -m` with a PR URL. Refusing
 *     these is the block's cost, and the per-segment verb attribution is what turns them
 *     into nonsense "verbs" (`old`, `new`, `the`).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, validateCfg, mergeDefaults } from '../lib/defaults.js'
import { remoteFetchVerbs } from '../lib/normalize.js'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** A call that names a downloader outright, or an interpreter fetch. */
const DOWNLOADER = /\b(curl|wget)\b|urllib|\brequests\.|fetch\(|Invoke-WebRequest|\biwr\b|http\.client|\bhttpie\b/

/**
 * Every session log under one root, newest generation included.
 * @param root - a `sessions/` directory.
 * @returns the log paths.
 */
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

/**
 * Read one log as lines, decompressing when needed.
 * @param path - the log file.
 * @returns the lines, as an async iterable.
 */
async function* lines(path) {
  const compressed = /\.zst(d)?$/.test(path)
  const source = compressed
    ? execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 }).toString('utf8')
    : readFileSync(path, 'utf8')
  for (const line of source.split('\n')) if (line.trim().length > 0) yield line
}

/**
 * Parse a shell tool call into its command, tolerating either argument encoding.
 * @param data - the `tool/call` event payload.
 * @returns the command text, or `undefined` when this is not a shell call.
 */
function commandOf(data) {
  if (!SHELL_TOOLS.has(data?.name)) return undefined
  let args = data.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  const command = args?.command
  return typeof command === 'string' ? command : undefined
}

async function main() {
  const argv = process.argv.slice(2)
  let allow = [...DEFAULTS.shellHttpAllow]
  const roots = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow') {
      allow = (argv[++i] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
      continue
    }
    roots.push(argv[i])
  }
  if (roots.length === 0) {
    console.error('usage: node tools/shell-http-allowlist-scan.mjs [--allow a,b] <sessions-root> [...]')
    process.exit(2)
  }

  const cfg = validateCfg(mergeDefaults({}))
  const allowSet = new Set(allow)

  const byVerb = new Map()
  let logs = 0
  let calls = 0
  let fetching = 0
  let blocked = 0
  let target = 0
  let incidental = 0
  const incidentalExamples = []

  for (const root of roots) {
    for (const path of logsUnder(root)) {
      logs++
      for await (const line of lines(path)) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type !== 'tool/call') continue
        const command = commandOf(event.data)
        if (command === undefined) continue
        calls++
        const verbs = remoteFetchVerbs(command, cfg.hostAliases)
        if (verbs.length === 0) continue
        fetching++
        for (const verb of verbs) {
          const bucket = byVerb.get(verb) ?? { segments: 0, exempt: allowSet.has(verb) }
          bucket.segments++
          byVerb.set(verb, bucket)
        }
        const refused = verbs.filter((verb) => !allowSet.has(verb))
        if (refused.length === 0) continue
        blocked++
        if (DOWNLOADER.test(command)) {
          target++
        } else {
          incidental++
          if (incidentalExamples.length < 8) {
            incidentalExamples.push(command.split('\n')[0].slice(0, 140))
          }
        }
      }
    }
  }

  const rows = [...byVerb.entries()].sort((a, b) => b[1].segments - a[1].segments)
  console.log(`logs=${logs} shell_calls=${calls} calls_with_a_remote_url=${fetching}`)
  console.log(`allowlist=${JSON.stringify(allow)}\n`)
  console.log('verb                      segments  exempt')
  for (const [verb, bucket] of rows) {
    console.log(`${verb.padEnd(24)}  ${String(bucket.segments).padStart(8)}  ${bucket.exempt ? 'yes' : 'NO'}`)
  }
  const refusedVerbs = rows.filter(([, bucket]) => !bucket.exempt)
  console.log(
    `\nwould be REFUSED: ${refusedVerbs.reduce((sum, [, b]) => sum + b.segments, 0)} segments across ` +
      `${refusedVerbs.length} verb(s)`,
  )
  console.log(`\nrefused CALLS: ${blocked}`)
  console.log(`  TARGET (names curl/wget or an interpreter fetch): ${target}`)
  console.log(`  INCIDENTAL (carries a URL, fetches nothing):      ${incidental}`)
  if (incidentalExamples.length > 0) {
    console.log('\nincidental examples (the block\'s cost):')
    for (const example of incidentalExamples) console.log(`  ${example}`)
  }
}

await main()
