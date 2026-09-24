/**
 * Canonicalization helpers: turning a raw tool call into the stable,
 * decoy-free, spelling-insensitive primitives the fingerprint layer keys on.
 *
 * Everything here is pure and synchronous — the guard runs inside the tool
 * pipeline and must not await, resolve DNS, or touch the disk.
 */

/**
 * Canonical string form of a JSON value: object keys deep-sorted, then
 * stringified. `undefined` members are dropped (JSON's own behaviour);
 * a self-referencing object collapses to the literal `'[cycle]'`.
 * @param value - any parsed-JSON value.
 * @returns a deterministic string.
 */
export function canonical(value) {
  const seen = new Set()
  const walk = (node) => {
    if (node === undefined) return undefined
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node)) return '[cycle]'
    seen.add(node)
    try {
      if (Array.isArray(node)) {
        return node.map((item) => {
          const walked = walk(item)
          return walked === undefined ? null : walked
        })
      }
      const out = {}
      for (const key of Object.keys(node).sort()) {
        const walked = walk(node[key])
        if (walked !== undefined) out[key] = walked
      }
      return out
    } finally {
      seen.delete(node)
    }
  }
  const result = JSON.stringify(walk(value))
  return result === undefined ? 'null' : result
}

/**
 * Shallow-copy `args` without the keys `ignoreArgs` declares as decoys.
 * The deleted values must never reach a fingerprint string — that is the whole
 * point of the exercise.
 * @param name - tool name (selects the per-tool list).
 * @param args - the call's parsed arguments.
 * @param ignoreArgs - `{ '*': [...], <name>: [...] }` table.
 * @returns a detached argument object.
 */
export function omitIgnored(name, args, ignoreArgs = {}) {
  const out = isPlainObject(args) ? { ...args } : args == null ? {} : { value: args }
  const drop = [...(ignoreArgs['*'] ?? []), ...(ignoreArgs[name] ?? [])]
  for (const key of drop) delete out[key]
  return out
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Split a shell command into tokens, honouring single quotes, double quotes,
 * and backslash escapes. Quotes are removed from the result.
 * @param command - raw command text.
 * @returns the token list.
 */
export function tokenize(command) {
  const source = typeof command === 'string' ? command : String(command ?? '')
  const tokens = []
  let current = ''
  let started = false
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quote !== null) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && i + 1 < source.length) {
        current += source[(i += 1)]
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && i + 1 < source.length) {
      current += source[(i += 1)]
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** Last path segment of a command word (`/usr/bin/curl` -> `curl`). */
function basename(word) {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  return cut >= 0 ? word.slice(cut + 1) : word
}

/**
 * Shell trivia that can sit in front of a command INSIDE one segment: loop and conditional
 * bodies, grouping, negation, command substitution, and `NAME=` assignments.
 *
 * Stripping it is what makes the command's real verb visible. `for i in $(seq 1 10); do
 * t=$(curl -s '<url>' | …)` splits into a segment whose first token is `do`, and reading
 * that as the verb both mis-attributes the fetch (so an exemption compares against `do`) and
 * hides the mechanism entirely — which is how a registry-polling loop came back allowed when
 * the rule stopped firing on an address alone.
 *
 * The keywords carry a word boundary so `ifconfig` is not read as `if` + `config`.
 */
const COMMAND_PREFIX =
  /^(?:(?:do|then|else|elif|if|while|until|for)\b|\{|\}|\(|\)|!|\$\(|`|(?:[A-Za-z_][A-Za-z0-9_]*)=\$?\()/

/**
 * Strip {@link COMMAND_PREFIX} repeatedly, so `do t=$(curl …` reduces to `curl …`.
 * @param text - one segment.
 * @returns the segment with its leading shell trivia removed.
 */
function stripCommandPrefix(text) {
  let current = text
  for (let i = 0; i < 8; i += 1) {
    const next = current.replace(COMMAND_PREFIX, '').trimStart()
    if (next === current || next.length === 0) break
    current = next
  }
  return current
}

/** True when the host is an IPv4/IPv6 literal rather than a DNS name. */
function isIpLiteral(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * Whether a host is on the local machine or the local network rather than the
 * public internet: `localhost`, loopback, RFC1918, link-local, and the IPv6
 * equivalents. These are the hosts a development loop talks to — a dev server, a
 * local inference endpoint, a container — so the guard treats them as their own
 * class. See the `localHosts` policy.
 *
 * The brackets of an IPv6 literal are stripped first. `URL.hostname` keeps them
 * (`[::1]`), and comparing that spelling against `::1` silently answered "not
 * local" — so `curl http://[::1]:8080/` was refused, while the refusal message
 * told the operator that `::1` is exempt. Normalizing here as well as in
 * {@link normUrl} means a caller holding a raw host cannot get it wrong.
 *
 * @param host - a normalized hostname (lowercase, no port, no trailing dot).
 * @returns whether the host is local.
 */
export function isLocalHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (name.length === 0) return false
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true
  if (/^127\./.test(name)) return true
  if (/^10\./.test(name)) return true
  if (/^192\.168\./.test(name)) return true
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(name)) return true
  if (/^169\.254\./.test(name)) return true
  if (/^0\.0\.0\.0$/.test(name)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(name)) return true
  if (/^fe80:/i.test(name)) return true
  return false
}

/**
 * Query parameters that describe the REFERRER rather than the resource. They are
 * dropped before the query becomes part of a `net:` fingerprint, so adding one
 * cannot launder a repeat — while a real navigation parameter (`page`, `offset`,
 * `since`, …) still distinguishes one page of results from the next.
 */
const TRACKING_PARAMS = /^(?:utm_\w+|fbclid|gclid|msclkid|mc_eid|_ga|ref_src|igshid)$/i

/** Normalized `key=value` pairs of a URL query, sorted for stability. */
function normalizedQuery(search) {
  if (typeof search !== 'string' || search.length <= 1) return ''
  const pairs = []
  for (const [key, value] of new URLSearchParams(search)) {
    if (TRACKING_PARAMS.test(key)) continue
    pairs.push(`${key}=${value}`)
  }
  return pairs.sort().join('&')
}

/** Registrable-ish site key: last two DNS labels, or the host for IPs. */
function siteOf(host) {
  if (isIpLiteral(host)) return host
  const parts = host.split('.').filter(Boolean)
  return parts.length <= 2 ? host : parts.slice(-2).join('.')
}

/**
 * Normalize a URL or bare host into the spelling-insensitive identity the
 * `net:` / `site:` fingerprints use. A missing scheme is assumed `https`.
 * `www.` and default ports are dropped, aliases are folded, the fragment is
 * discarded, a trailing slash is trimmed, and the query is kept — SORTED, with
 * tracking parameters removed — because the query is what distinguishes one page
 * of results from the next (`?page=2`), while `utm_source=` is not part of the
 * resource at all.
 * @param raw - URL text (with or without scheme).
 * @param hostAliases - canonical-host table.
 * @returns `{ host, path, site, href }` or `null` when unparseable.
 */
/**
 * Drop a port that is a SHELL VARIABLE.
 *
 * A URL whose port is not a literal number — an ordinary way to write a local health check —
 * makes `new URL` THROW, and a throw here reads as "there is no address at all". So a local
 * endpoint written that way was classified as remote and refused: it dominated the
 * false-positive set at 316 corpus calls rather than being a curiosity.
 *
 * The port is not part of any fingerprint, so a non-numeric one is dropped instead of being
 * allowed to fail the parse. A numeric port is left for `new URL` to normalize as usual.
 *
 * @param text - a URL that already carries a scheme.
 * @returns the URL with any non-numeric port removed.
 */
function dropVariablePort(text) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]+)(.*)$/.exec(text)
  if (match === null) return text
  const [, scheme, authority, rest] = match
  const at = authority.lastIndexOf('@')
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : ''
  const hostport = at >= 0 ? authority.slice(at + 1) : authority
  // An IPv6 literal's colons are INSIDE its brackets, so the port separator is the first
  // colon after the closing one. Reading them as separators truncates the address instead
  // of the port — `[fe80::1]` became `[fe80:`, which is not local, so a link-local URL was
  // refused.
  const close = hostport.startsWith('[') ? hostport.indexOf(']') : -1
  const colon = close >= 0 ? hostport.indexOf(':', close + 1) : hostport.lastIndexOf(':')
  if (colon < 0) return text
  const port = hostport.slice(colon + 1)
  if (port === '' || /^\d+$/.test(port)) return text
  return `${scheme}${userinfo}${hostport.slice(0, colon)}${rest}`
}

export function normUrl(raw, hostAliases = {}) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text.length === 0) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) text = `https://${text}`
  text = dropVariablePort(text)
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  let host = (url.hostname || '').toLowerCase()
  // `URL.hostname` keeps an IPv6 literal's brackets; the guard compares against the
  // bare address, so they are dropped here rather than only in `isLocalHost`.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('www.')) host = host.slice(4)
  if (host.length === 0) return null
  if (Object.hasOwn(hostAliases, host)) {
    const mapped = hostAliases[host]
    if (typeof mapped === 'string' && mapped.length > 0) host = mapped.toLowerCase()
  }
  let path = url.pathname || '/'
  if (path.length > 1) path = path.replace(/\/+$/, '')
  if (path.length === 0) path = '/'
  const query = normalizedQuery(url.search)
  return {
    host,
    path,
    site: siteOf(host),
    href: query.length > 0 ? `${host}${path}?${query}` : `${host}${path}`,
  }
}

/** Wrapper commands that are transparent for the purpose of naming the verb. */
const PREFIX_WORDS = new Set(['sudo', 'doas', 'command', 'env', 'time', 'nice', 'nohup', 'exec'])

/** Value-taking single-dash options of the transparent wrappers above. */
const PREFIX_VALUE_OPTIONS = new Set([
  '-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-R', '-T', '-S', '-n', '-D',
])

/**
 * The command word that actually does the work: transparent wrappers,
 * `VAR=value` assignments, wrapper options, and `timeout [opts] <duration>` are
 * skipped, then the first remaining token is reduced to its basename and
 * lowercased.
 * @param command - raw command text.
 * @returns the verb, or `''` when the command is empty.
 */
export function firstVerb(command) {
  const tokens = tokenize(command)
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1
      continue
    }
    if (token === 'timeout') {
      i += 1
      while (i < tokens.length && tokens[i].startsWith('--')) i += 1
      if (i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i])) i += 1
      continue
    }
    if (PREFIX_WORDS.has(token)) {
      i += 1
      while (i < tokens.length && PREFIX_VALUE_OPTIONS.has(tokens[i])) i += 2
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1
      continue
    }
    break
  }
  const verb = tokens[i]
  return verb === undefined ? '' : basename(verb).toLowerCase()
}

/** URLs embedded in a command string. */
const URL_PATTERN = /https?:\/\/[^\s"'\\<>`]+/g

/**
 * A backslash immediately before one of these is a REGEX ESCAPE rather than part of
 * the address: `http://127\.0\.0\.1:3080/\?token=x` is how a shell spells a loopback
 * URL inside a `grep -oE` pattern. A backslash cannot appear in a URL, so
 * {@link URL_PATTERN} stops there — and the match truncates. Without this step
 * `http://127\.0\.0\.1:3080/` is extracted as `http://127`, which WHATWG then reads as
 * the IPv4 NUMBER 0.0.0.127. That is not loopback, so a LOCAL address written as a
 * pattern was classified as remote and refused.
 *
 * Found the hard way: a post-restart verification command that grepped for a loopback
 * token URL was blocked by this plugin's own rule. The measured cost of the block is
 * small (52 of 4081 refused calls carry a URL without fetching anything), but this
 * shape lands squarely on the most common verification command there is.
 *
 * Only these characters are unescaped, and only in the copy the pattern reads. A
 * backslash before a path separator (`C:\dir\file`) or a line continuation (`\` plus
 * a newline) is left alone, and nothing outside URL extraction sees the rewritten text.
 */
const REGEX_ESCAPE_BEFORE_URL_CHAR = /\\(?=[.:/?&=#%~-])/g

/**
 * Every distinct `http(s)` URL appearing in a command, with trailing
 * sentence punctuation trimmed.
 * @param command - raw command text.
 * @returns the URL list, deduplicated by spelling.
 */
export function extractUrls(command) {
  const source =
    typeof command === 'string' ? command.replace(REGEX_ESCAPE_BEFORE_URL_CHAR, '') : ''
  const urls = []
  const seen = new Set()
  for (const match of source.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?)\]}'"]+$/, '')
    if (raw.length === 0 || seen.has(raw)) continue
    seen.add(raw)
    urls.push(raw)
  }
  return urls
}

/** Flags whose value should be treated as volatile (`--max-time 60`). */
const VOLATILE_VALUE_FLAGS = new Set([
  '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time',
  '--speed-time', '--speed-limit', '--max-redirs', '--user-agent',
  '-m', '-A',
])

/** Boolean flags that carry no meaning for action identity. */
const VOLATILE_SHORT_FLAGS = new Set(['s', 'S', 'f', 'L', 'k'])

/** Boolean long flags that carry no meaning for action identity. */
const VOLATILE_LONG_FLAGS = new Set([
  '--silent', '--show-error', '--fail', '--location', '--insecure',
  '--user-agent', '--compressed', '--no-progress-meter',
])

/** True for a `-abc` cluster made only of ignorable short flags. */
function isVolatileCluster(token) {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return false
  return [...token.slice(1)].every((char) => VOLATILE_SHORT_FLAGS.has(char))
}

/**
 * Strip timing/verbosity/retry flags and a leading `timeout` wrapper from a
 * command so the `cmd:` fingerprint survives "same command, different
 * `--max-time`". Extraction of URLs and sinks always reads the RAW command.
 * @param command - raw command text.
 * @returns the stripped command with whitespace collapsed.
 */
export function stripVolatileFlags(command) {
  const tokens = tokenize(command)
  let start = 0
  while (start < tokens.length) {
    const token = tokens[start]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      start += 1
      continue
    }
    if (token === 'timeout') {
      start += 1
      while (start < tokens.length && tokens[start].startsWith('--')) start += 1
      if (start < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[start])) start += 1
      continue
    }
    break
  }
  const kept = []
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (VOLATILE_LONG_FLAGS.has(token) || VOLATILE_VALUE_FLAGS.has(token)) {
      if (VOLATILE_VALUE_FLAGS.has(token)) i += 1
      continue
    }
    if (isVolatileCluster(token)) continue
    if (/^(?:--[a-z-]+)=/.test(token) && VOLATILE_VALUE_FLAGS.has(token.slice(0, token.indexOf('=')))) continue
    if (/^-[mA]\d/.test(token)) continue
    kept.push(token)
  }
  return kept.join(' ').trim()
}

/** Strip surrounding quotes and a leading `./` from an extracted path. */
function cleanPath(value) {
  if (typeof value !== 'string') return null
  let path = value.trim().replace(/^['"]|['"]$/g, '')
  while (path.startsWith('./')) path = path.slice(2)
  return path.length === 0 ? null : path
}

/**
 * Whether a token is a bare `http(s)` URL. Used only to disambiguate `-O`:
 * curl's `-O` is a flag (the URL follows it), while wget's `-O` takes the
 * output filename — a plain filename is NOT a URL just because it has a dot.
 */
function isUrlLike(token) {
  return /^https?:\/\//i.test(token)
}

/** Shell operators that end a `tee` target scan. */
const SHELL_OPERATORS = new Set(['|', '||', ';', '&&', '&', '>', '>>', '<'])

/**
 * The path a command writes its payload to. Checked in order:
 * `-o` / `--output` / `--output-document` (and `-O`, which takes a value in
 * wget but is a bare flag in curl — a URL-looking next token keeps curl's
 * meaning), then a `>` / `>>` redirection that is not `2>` or `&>`, then the
 * final argument of `tee`.
 * @param command - raw command text.
 * @returns the cleaned path, or `null`.
 */
export function extractSink(command) {
  const tokens = tokenize(command)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '-o' || token === '--output' || token === '--output-document') {
      const value = tokens[i + 1]
      if (value !== undefined && !value.startsWith('-')) return cleanPath(value)
      continue
    }
    if (token === '-O') {
      const value = tokens[i + 1]
      if (value !== undefined && !value.startsWith('-') && !isUrlLike(value)) return cleanPath(value)
      continue
    }
    if (token.startsWith('--output=')) return cleanPath(token.slice('--output='.length))
    if (token === '>' || token === '>>' || /^>{1,2}/.test(token)) {
      const inline = token.replace(/^>{1,2}/, '')
      if (inline.length > 0) return cleanPath(inline)
      const value = tokens[i + 1]
      if (value !== undefined && !SHELL_OPERATORS.has(value)) return cleanPath(value)
      continue
    }
    if (token === 'tee') {
      let last = null
      for (let j = i + 1; j < tokens.length; j += 1) {
        const candidate = tokens[j]
        if (SHELL_OPERATORS.has(candidate)) break
        if (candidate.startsWith('-')) continue
        last = candidate
      }
      if (last !== null) return cleanPath(last)
    }
  }
  return null
}

/** The operators that start a new command inside one shell string. */
const SEGMENT_SPLIT = /\n|;|&&|\|\||\||&/

/**
 * The verbs that actually FETCH, one per command segment that targets a remote URL.
 *
 * `firstVerb` alone is not enough for this: it describes the WHOLE string, so
 * `cd /somewhere && curl https://…` reports `cd`, and `echo …; git clone https://…`
 * reports `echo`. Attributing a fetch to the wrong verb is how an allowlist
 * misfires — it would exempt, or refuse, the wrong thing.
 *
 * The split is textual, so a `|` inside quotes would divide a segment early. That is
 * deliberate: the cost is a misattributed VERB on an unusual string, and the
 * alternative — a full shell parser — is not something this plugin should carry.
 *
 * @param command - the shell command.
 * @param hostAliases - host folding, as the fingerprints use.
 * @returns the remote-fetching verbs, in order, deduplicated; empty when no segment
 *   targets a remote URL.
 */
export function remoteFetchVerbs(command, hostAliases = {}) {
  // Join line continuations first: a `for url in \` + newline header otherwise splits
  // into a segment whose first token is a URL fragment, and a fragment is not a verb.
  const source = (typeof command === 'string' ? command : '').replace(/\\\r?\n/g, ' ')
  const verbs = []
  for (const segment of source.split(SEGMENT_SPLIT)) {
    const text = segment.trim()
    if (text.length === 0) continue
    const urls = extractUrls(text)
      .map((raw) => normUrl(raw, hostAliases))
      .filter((url) => url !== null)
    if (urls.length === 0) continue
    if (urls.every((url) => isLocalHost(url.host))) continue
    const verb = firstVerb(stripCommandPrefix(text))
    // Only a plausible command name is a verb. Anything else — a URL fragment, a
    // quoted string that happened to lead a segment — is not one, and reporting it as
    // such would make the allowlist compare against nonsense. Dropping it means the
    // caller falls through to its own verb, which refuses rather than exempts.
    if (verb === null || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(verb)) continue
    if (!verbs.includes(verb)) verbs.push(verb)
  }
  return verbs
}

/**
 * Verbs that RUN another command line. Each is a shell to be opened, not a mechanism to
 * judge: the command it runs is extracted and tested on its own.
 *
 * The list is deliberately open-ended. "Not 100% coverage" is a design decision rather
 * than a compromise — every entry here buys coverage, costs nothing when it is wrong, and
 * can be added later, while a rule that tries to decide WHERE a mechanism appears has to
 * model shell nesting and gets it wrong in both directions.
 */
const SHELL_HOSTS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ssh', 'xargs', 'env', 'sudo', 'doas', 'command',
  'exec', 'timeout', 'nice', 'nohup', 'stdbuf', 'watch', 'eval', 'parallel', 'busybox',
])

/** Options of a shell host that TAKE a value, so the next token is not the command. */
const SHELL_HOST_VALUE_OPTIONS = new Set([
  '-F', '-o', '-i', '-p', '-l', '-P', '-E', '-I', '-n', '-u', '-g', '-C', '-S', '-R', '-T',
  '--exec', '--max-args', '--replace', '--delimiter', '--timeout', '--user', '--signal',
])

/**
 * APIs that exist to make a request. Seeing one is evidence on its own, which is how an
 * interpreter is covered: `python3` cannot go on a verb blacklist without refusing every
 * local script, so the request API inside the program is what names the mechanism.
 */
export const FETCH_API =
  /urllib|\brequests\.|\bhttpx\b|\baiohttp\b|http\.client|\bfetch\(|\baxios\b|\bgot\(|Invoke-WebRequest|\biwr\b/

/** The body of every `$(…)` and backtick pair in one segment. */
function substitutionBodies(text) {
  const bodies = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === '(') depth += 1
        else if (text[j] === ')') depth -= 1
      }
      bodies.push(text.slice(i + 2, j - 1))
      i = j - 1
    } else if (text[i] === '`') {
      const j = text.indexOf('`', i + 1)
      if (j > i) {
        bodies.push(text.slice(i + 1, j))
        i = j
      }
    }
  }
  return bodies
}

/** The command a shell host runs, with the host and its own options removed. */
function afterShellHost(segment) {
  const tokens = tokenize(segment)
  if (tokens.length < 2) return null
  if (!SHELL_HOSTS.has(basename(tokens[0]).toLowerCase())) return null
  let i = 1
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const option = tokens[i]
    i += 1
    if (option === '-c' || option === '-e' || option === '-r') break
    if (SHELL_HOST_VALUE_OPTIONS.has(option)) i += 1
  }
  while (i < tokens.length && /^\d+[smhd]?$/.test(tokens[i])) i += 1
  return i < tokens.length ? tokens.slice(i).join(' ') : null
}

/** Every candidate command string inside one segment, before recursion. */
function innerCommands(segment) {
  const inner = []
  for (const body of substitutionBodies(segment)) inner.push(body)

  const hosted = afterShellHost(segment)
  if (hosted !== null) inner.push(hosted)

  // `find … -exec <cmd> {} ;`, where the command is an argument rather than the segment's
  // own verb.
  const exec = /(?:^|\s)-exec\s+([\s\S]*)$/.exec(segment)
  if (exec !== null) inner.push(exec[1].replace(/\s*[;+]\s*$/, ''))

  // A quoted nested command arrives as ONE token — `ssh host 'curl -s …'` yields
  // `curl -s …` — so a token containing whitespace is a command line worth testing.
  for (const token of tokenize(segment)) {
    if (/\s/.test(token) && token.length > 1) inner.push(token)
  }
  return inner
}

/**
 * Every command this command line could run, one shell layer at a time.
 *
 * The traverse the whole block is built on: split on the separators, then open the shells —
 * command substitution, a shell host, `-exec`, a quoted sub-command — and test what comes
 * out. A mechanism is only judged on a candidate where it is the VERB, so `grep 'https://…'`
 * and a README quoting a URL are not candidates for anything.
 *
 * Bounded in depth and de-duplicated, so a self-referential wrapper cannot loop.
 *
 * @param command - the shell command line.
 * @param options - `maxDepth` (default 6).
 * @returns the candidate command strings, outer first.
 */
export function unwrapCommands(command, options = {}) {
  const maxDepth = options.maxDepth ?? 6
  const out = []
  const seen = new Set()

  const visit = (text, depth) => {
    if (depth > maxDepth) return
    // Join line continuations BEFORE splitting. A continued command otherwise splits into
    // fragments, and the fragment carrying the verb has no address: `curl -s \\` + newline
    // + `http://127.0.0.1:…` reads as a URL-less curl, which is refused — a local fetch
    // caught by mistake, and the dominant cause of the newly-refused set measured at 329.
    const joined = String(text).replace(/\\\r?\n/g, ' ')
    for (const raw of joined.split(SEGMENT_SPLIT)) {
      const stripped = stripCommandPrefix(raw.trim())
      if (stripped.length === 0) continue
      if (!seen.has(stripped)) {
        seen.add(stripped)
        out.push(stripped)
      }
      for (const inner of innerCommands(stripped)) visit(inner, depth + 1)
    }
  }

  visit(command, 0)
  return out
}
