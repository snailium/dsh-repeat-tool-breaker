/**
 * The evidence for choosing a blacklist over an allowlist.
 *
 * The block has three triggers today; the broad one is "any non-local URL appears
 * anywhere in the command" (`remote` in index.js). That is what refuses a `grep` whose
 * PATTERN is an address, a heredoc writing a README full of links, a commit message
 * quoting a URL. A blacklist drops that clause and keeps only the fetch-MECHANISM
 * clauses — so the new rule is a strict SUBSET of the old one, and can therefore add no
 * new refusals. What it can do is newly ALLOW a call that fetches.
 *
 * That is the whole risk, so this tool measures exactly it: replay the corpus, and for
 * every call the old rule refused but the new one allows, report whether the command
 * names a fetch-capable mechanism at all. A newly-allowed call that names one is a
 * candidate false NEGATIVE — the thing a blacklist can get wrong — and it is printed for
 * judgement rather than counted and hidden.
 *
 * It reads local session logs and makes no network requests.
 *
 *   node tools/allowlist-vs-denylist-delta.mjs [<sessions-root> ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, mergeDefaults, validateCfg } from '../lib/defaults.js'
import { extractUrls, firstVerb, isLocalHost, normUrl, remoteFetchVerbs } from '../lib/normalize.js'

/**
 * Verbs whose PURPOSE is an HTTP fetch, so a bare invocation is inherently one. These
 * fire unconditionally at verb position — the same four the plugin already treats this
 * way, plus the file/streaming downloaders that are unambiguously in the same family.
 */
const HTTP_CLIENTS = new Set([
  'curl', 'wget', 'http', 'httpie',
  'aria2c', 'rclone', 'yt-dlp', 'youtube-dl',
])

/**
 * Mechanisms that CAN fetch but are ordinary tools for other work (`nc`, `socat`) or
 * interpreters used mostly for local work (`python3`, `node`). These fire only when the
 * command ALSO carries a non-local address — which is what keeps `ssh host 'curl …'`,
 * `xargs curl` and `python3 -c "…urllib…"` caught without refusing every ssh or python.
 */
const FETCH_API =
  /\b(curl|wget|httpie|aria2c|rclone|yt-dlp|youtube-dl|nc|ncat|netcat|socat|telnet|lftp|tftp)\b|urllib|\brequests\.|\bhttpx\b|\baiohttp\b|http\.client|\bfetch\(|\baxios\b|\bgot\(|Invoke-WebRequest|\biwr\b|\bopen-url\b/

/** The four verbs the plugin already treats as an HTTP fetch at verb position. */
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'httpie'])

/** Every segment's verb, which is what the plugin's exemption is attributed to. */
function verbs(command) {
  return command
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => firstVerb(segment.trim()))
    .filter((verb) => verb.length > 0)
}

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

/** The rule as shipped, transcribed from index.js, `remote` clause included. */
function oldRefuses(command, cfg) {
  const urls = extractUrls(command).map((raw) => normUrl(raw, cfg.hostAliases)).filter(Boolean)
  const local = urls.length > 0 && urls.every((url) => isLocalHost(url.host))
  const remote = local !== true && urls.some((url) => !isLocalHost(url.host))
  const httpVerb = HTTP_VERBS.has(firstVerb(command))
  if (!remote && !(httpVerb && local !== true)) return false
  if (cfg.shellHttpAllow.length === 0) return true
  const fetchVerbs = remoteFetchVerbs(command, cfg.hostAliases)
  if (fetchVerbs.length > 0) return !fetchVerbs.every((verb) => cfg.shellHttpAllow.includes(verb))
  return !cfg.shellHttpAllow.includes(firstVerb(command))
}

/**
 * The proposed rule: mechanism-based only. The local-only exemption gates the TRIGGER
 * (as it does in the shipped rule), not the allowlist — putting it in the allowlist
 * check instead is how an earlier draft managed to refuse a local curl, which would have
 * made the "new" rule refuse 879 calls the old one allowed.
 */
function newRefuses(command, cfg) {
  const urls = extractUrls(command).map((raw) => normUrl(raw, cfg.hostAliases)).filter(Boolean)
  const local = urls.length > 0 && urls.every((url) => isLocalHost(url.host))
  if (local) return false

  // TRIGGER (the only thing that changes): the shipped rule is `remote URL ||
  // http-verb`; this one is `http-verb || (mechanism token + remote URL)`. The second
  // term is the blacklist refinement — a mechanism must be NAMED, so a URL in text is no
  // longer a trigger on its own.
  //
  // Clause 1 stays on the command's first verb, the same attribution `family:http-fetch`
  // uses. Broadening it to every segment's verb reads well but refuses
  // `a && b && curl --config f` with no URL, which the old rule allowed; measured at 86
  // newly-refused calls when it was in, and it costs the subset property that makes this
  // change provable.
  const fetchVerbs = remoteFetchVerbs(command, cfg.hostAliases)
  const exempt = (verbsList) => verbsList.length > 0 && verbsList.every((verb) => cfg.shellHttpAllow.includes(verb))

  const byVerb = HTTP_CLIENTS.has(firstVerb(command))
  const byApi =
    urls.some((url) => !isLocalHost(url.host)) && FETCH_API.test(command) && !exempt(fetchVerbs)
  if (!byVerb && !byApi) return false

  // DECISION: shared with the shipped rule, so the exemption is attributed per segment
  // exactly as before. A separate decision here is what refused a LOCAL curl that shared a
  // command with an exempt `git`/`grep` remote fetch (5 calls).
  if (cfg.shellHttpAllow.length === 0) return true
  if (fetchVerbs.length > 0) return !exempt(fetchVerbs)
  return !cfg.shellHttpAllow.includes(firstVerb(command))
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: node tools/allowlist-vs-denylist-delta.mjs <sessions-root> [...]')
  process.exit(2)
}
const cfg = validateCfg(mergeDefaults({}))

let calls = 0
let oldOnly = 0
let newOnly = 0
let both = 0
let neither = 0
const newlyAllowed = []
const newlyRefused = []

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
      calls++

      const before = oldRefuses(command, cfg)
      const after = newRefuses(command, cfg)
      if (before && after) both++
      else if (before && !after) {
        oldOnly++
        if (newlyAllowed.length < 2000) newlyAllowed.push(command)
      } else if (!before && after) {
        newOnly++
        if (newlyRefused.length < 20) newlyRefused.push(command)
      } else neither++
    }
  }
}

const namesMechanism = (command) => HTTP_CLIENTS.has(firstVerb(command)) || FETCH_API.test(command)
const risky = newlyAllowed.filter(namesMechanism)
const safe = newlyAllowed.filter((command) => !namesMechanism(command))

console.log(`shell calls replayed: ${calls}\n`)
console.log(`refused by BOTH rules      : ${both}`)
console.log(`refused ONLY by the old    : ${oldOnly}   <- newly ALLOWED (the entire delta)`)
console.log(`refused ONLY by the new    : ${newOnly}   <- a blacklist can add no refusals; expect 0`)
console.log(`allowed by both            : ${neither}\n`)

console.log(`of the newly allowed, does the command name a fetch-capable mechanism?`)
console.log(`  no  (unambiguously safe) : ${safe.length}`)
console.log(`  yes (candidate false NEG): ${risky.length}`)

if (newlyRefused.length > 0) {
  console.log('\n--- NEWLY REFUSED (must be empty)')
  for (const command of newlyRefused) console.log(`  ${command.split('\n')[0].slice(0, 160)}`)
}

if (risky.length > 0) {
  console.log('\n--- candidate false negatives, for judgement (first 12)')
  for (const command of risky.slice(0, 12)) {
    console.log(`  ${command.split('\n')[0].slice(0, 160)}`)
  }
}

console.log('\n--- what is newly allowed, by shape (first 8 unambiguously safe)')
for (const command of safe.slice(0, 8)) {
  console.log(`  ${command.split('\n')[0].slice(0, 160)}`)
}
