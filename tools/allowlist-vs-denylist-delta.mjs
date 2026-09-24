/**
 * The evidence for choosing a blacklist over an allowlist.
 *
 * A command is refused today because it USES something that can fetch; before 0.6.3 it was
 * refused for merely CONTAINING a non-local address. Dropping that address-only clause makes
 * the new rule a strict SUBSET of the old one - it can add no refusal. What it can do is
 * newly ALLOW a call that fetches, and that is the entire risk, so this tool measures
 * exactly it.
 *
 * One side is measured through the REAL policy (`lib/block-policy.js`), because an earlier
 * draft re-implemented the new rule here and drifted from it three times in a row, each
 * drift showing up as a phantom "newly refused" set. A measurement that paraphrases the
 * thing it measures is not a measurement. The OLD rule no longer exists in code, so it is
 * the one side that must be a transcription, and it is labelled as one.
 *
 * It reads local session logs and makes no network requests.
 *
 *   node tools/allowlist-vs-denylist-delta.mjs [<sessions-root> ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { blockShellHttp } from '../lib/block-policy.js'
import { DEFAULTS, mergeDefaults, validateCfg } from '../lib/defaults.js'
import { extractUrls, firstVerb, isLocalHost, normUrl, remoteFetchVerbs } from '../lib/normalize.js'

/** The four verbs the pre-0.6.3 rule treated as an HTTP fetch at verb position. */
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'httpie'])

/**
 * The exemption list the OLD rule shipped with, frozen here. It is part of the
 * transcription: 0.7.0 replaced `shellHttpAllow` with `shellHttpBlock`, so the old value
 * cannot be read from the live config any more.
 */
const OLD_ALLOW = ['git', 'docker', 'grep', 'rg']

/** Mechanisms looked for when judging whether a newly-allowed call could fetch at all. */
const ANY_MECHANISM = /\b(curl|wget|httpie|aria2c|rclone|yt-dlp|youtube-dl|nc|ncat|netcat|socat|telnet)\b|urllib|\brequests\.|\bhttpx\b|http\.client|\bfetch\(|\baxios\b|Invoke-WebRequest|\biwr\b/

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

/** READ-ONLY TRANSCRIPTION of the rule that shipped before 0.6.3. Not live code. */
function oldRefuses(command, cfg) {
  const urls = extractUrls(command).map((raw) => normUrl(raw, cfg.hostAliases)).filter(Boolean)
  const local = urls.length > 0 && urls.every((url) => isLocalHost(url.host))
  const remote = local !== true && urls.some((url) => !isLocalHost(url.host))
  const httpVerb = HTTP_VERBS.has(firstVerb(command))
  if (!remote && !(httpVerb && local !== true)) return false
  if (OLD_ALLOW.length === 0) return true
  const fetchVerbs = remoteFetchVerbs(command, cfg.hostAliases)
  if (fetchVerbs.length > 0) return !fetchVerbs.every((verb) => OLD_ALLOW.includes(verb))
  return !OLD_ALLOW.includes(firstVerb(command))
}

/** The shipped rule, called rather than copied: one command line in, one verdict out. */
function newRefuses(command, cfg) {
  return blockShellHttp(command, cfg)
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: node tools/allowlist-vs-denylist-delta.mjs <sessions-root> [...]')
  process.exit(2)
}
const cfg = validateCfg(mergeDefaults({}))

let calls = 0
let both = 0
let oldOnly = 0
let newOnly = 0
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
        if (newlyAllowed.length < 5000) newlyAllowed.push(command)
      } else if (!before && after) {
        newOnly++
        if (newlyRefused.length < 20) newlyRefused.push(command)
      } else neither++
    }
  }
}

const namesMechanism = (command) => HTTP_VERBS.has(firstVerb(command)) || ANY_MECHANISM.test(command)
const risky = newlyAllowed.filter(namesMechanism)
const safe = newlyAllowed.filter((command) => !namesMechanism(command))

console.log(`shell calls replayed: ${calls}\n`)
console.log(`refused by BOTH rules      : ${both}`)
console.log(`refused ONLY by the old    : ${oldOnly}   <- newly ALLOWED (the entire delta)`)
console.log(`refused ONLY by the new    : ${newOnly}   <- a blacklist can add no refusals; expect 0`)
console.log(`allowed by both            : ${neither}\n`)

console.log('of the newly allowed, does the command name a fetch-capable mechanism?')
console.log(`  no  (unambiguously safe) : ${safe.length}`)
console.log(`  yes (candidate false NEG): ${risky.length}`)

if (newlyRefused.length > 0) {
  console.log('\n--- NEWLY REFUSED (must be empty)')
  for (const command of newlyRefused) console.log(`  ${command.split('\n')[0].slice(0, 160)}`)
}
if (risky.length > 0) {
  console.log('\n--- candidate false negatives, for judgement (first 12)')
  for (const command of risky.slice(0, 12)) console.log(`  ${command.split('\n')[0].slice(0, 160)}`)
}
console.log('\n--- what is newly allowed, by shape (first 8)')
for (const command of safe.slice(0, 8)) console.log(`  ${command.split('\n')[0].slice(0, 160)}`)

// The subset property is the whole argument for the switch, so it is an EXIT CODE rather
// than a number a reader has to check.
if (newOnly > 0) {
  console.error(`\nFAIL: the blacklist rule refused ${newOnly} call(s) the allowlist rule allowed.`)
  process.exit(1)
}
