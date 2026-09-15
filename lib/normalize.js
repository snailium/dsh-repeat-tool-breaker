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
 * @param host - a normalized hostname (lowercase, no port, no trailing dot).
 * @returns whether the host is local.
 */
export function isLocalHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^0\.0\.0\.0$/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe80:/i.test(host)) return true
  return false
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
 * `www.` and default ports are dropped, aliases are folded, the query and
 * fragment are discarded, and a trailing slash is trimmed.
 * @param raw - URL text (with or without scheme).
 * @param hostAliases - canonical-host table.
 * @returns `{ host, path, site, href }` or `null` when unparseable.
 */
export function normUrl(raw, hostAliases = {}) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text.length === 0) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  let host = (url.hostname || '').toLowerCase()
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
  return { host, path, site: siteOf(host), href: `${host}${path}` }
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
 * Every distinct `http(s)` URL appearing in a command, with trailing
 * sentence punctuation trimmed.
 * @param command - raw command text.
 * @returns the URL list, deduplicated by spelling.
 */
export function extractUrls(command) {
  const source = typeof command === 'string' ? command : ''
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
