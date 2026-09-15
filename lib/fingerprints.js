/**
 * Fingerprint extraction: one tool call -> the set of identities it carries.
 *
 * A call contributes as many fingerprints as it honestly has, e.g. a single
 * `curl` contributes a verb, a family, a stripped command line, one `net:` per
 * URL, one `site:` per URL, and a sink. Each fingerprint is counted
 * independently in the window, so a loop that dodges one of them (new host
 * spelling, new `--max-time`) still collides on the others.
 *
 * Guarantee enforced by the test suite: no fingerprint string ever contains a
 * value removed by `omitIgnored` (so `description: '1st'|'2nd'|'3rd'` and
 * `timeoutMs` cannot launder a repeat).
 */

import {
  canonical,
  extractSink,
  extractUrls,
  firstVerb,
  normUrl,
  omitIgnored,
  stripVolatileFlags,
} from './normalize.js'

/** Tool names whose `command` argument is a shell command line. */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell'])

/** Verbs that mean "this command performs an HTTP fetch". */
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'httpie'])

/** Tool names that carry a URL argument rather than a command line. */
const URL_TOOL_PATTERN = /fetch|search|browse|web_/i

/**
 * Destinations that say nothing about which resource was fetched. `-o /dev/null`
 * is the idiomatic "I only want the status code", and a real run proved the cost
 * of treating it as identity: four DIFFERENT URLs fetched with
 * `curl -s -o /dev/null -w '%{http_code}'` all collided on `sink:/dev/null`
 * starting with the second one. A generic sink is not an action.
 */
const GENERIC_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/tty', '-'])

/**
 * Whether an extracted sink is a real, identifying destination. Exported so the
 * rule is testable on its own rather than only through a window.
 * @param sink - a path from {@link extractSink}.
 * @returns whether it may participate in a fingerprint.
 */
export function isGenericSink(sink) {
  return typeof sink !== 'string' || sink.length === 0 || GENERIC_SINKS.has(sink)
}

/** Whether a tool's `command` argument is a shell command line. */
export function isShell(name) {
  return SHELL_TOOLS.has(name)
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (rest is literal). */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Whether a tool participates in the breaker at all. Untracked calls are fully
 * transparent: they neither count toward a window nor reset one.
 * @param name - tool name.
 * @param cfg - merged configuration.
 * @returns whether the call should be fingerprinted and counted.
 */
export function isTracked(name, cfg) {
  return compileTracked(cfg)(name)
}

/**
 * Pre-compile the include/exclude patterns once per plugin instance; the guard
 * runs on every tool call and must not recompile regexes per call.
 * @param cfg - merged configuration.
 * @returns a predicate over tool names.
 */
export function compileTracked(cfg) {
  const include = cfg.include.map(wildcardToRegExp)
  const exclude = cfg.exclude.map(wildcardToRegExp)
  return (name) => {
    if (typeof name !== 'string' || name.length === 0) return false
    if (include.length > 0 && !include.some((pattern) => pattern.test(name))) return false
    return !exclude.some((pattern) => pattern.test(name))
  }
}

/**
 * The identity of one call's arguments: decoy fields removed, keys sorted.
 * @param exec - the pending tool execution.
 * @param cfg - merged configuration.
 * @returns the `exact:` fingerprint string.
 */
export function exactFingerprint(exec, cfg) {
  const name = exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? ''
  const args = exec?.arguments ?? exec?.args ?? {}
  return `exact:${name}:${canonical(omitIgnored(name, args, cfg.ignoreArgs))}`
}

/**
 * Every fingerprint this call carries.
 * @param exec - the pending tool execution (`{ name, arguments, agent }`).
 * @param cfg - merged configuration.
 * @returns a deduplicated list of fingerprint strings.
 */
export function fingerprints(exec, cfg) {
  const name = exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? ''
  const args = exec?.arguments ?? exec?.args ?? {}
  const fps = new Set()
  fps.add(exactFingerprint(exec, cfg))

  if (isShell(name)) {
    const command = typeof args?.command === 'string' ? args.command : ''
    const verb = firstVerb(command)
    if (verb) {
      fps.add(`verb:${verb}`)
      if (HTTP_VERBS.has(verb)) fps.add('family:http-fetch')
    }
    const stripped = stripVolatileFlags(command)
    if (verb && stripped) fps.add(`cmd:${verb}:${stripped}`)
    for (const raw of extractUrls(command)) {
      const url = normUrl(raw, cfg.hostAliases)
      if (url === null) continue
      fps.add(`net:${url.href}`)
      fps.add(`site:${url.site}`)
    }
    const sink = extractSink(command)
    if (sink !== null && !isGenericSink(sink)) fps.add(`sink:${sink}`)
    return [...fps]
  }

  if (URL_TOOL_PATTERN.test(name)) {
    const raw = args?.url ?? args?.href ?? args?.uri ?? ''
    const url = typeof raw === 'string' ? normUrl(raw, cfg.hostAliases) : null
    if (url !== null) {
      fps.add(`net:${url.href}`)
      fps.add(`site:${url.site}`)
      fps.add('family:http-fetch')
    }
  }

  // FILE TOOLS (read / write / edit) contribute nothing but `exact:` above.
  //
  // A file operation is identified by its POSITION, not by its path: reading
  // `foo.ts` at offset 0 and again at offset 200, or editing two different
  // regions of it, are different actions that a path-only fingerprint cannot
  // tell apart. Those arguments live in `exact:` — the same file at the same
  // position with the same arguments is the same string and is still denied —
  // so a separate `readpath:`/`writepath:` counter only ever added false
  // positives (it capped re-reads and iterative edits of one file).
  return [...fps]
}

/**
 * The cap governing one fingerprint: an exact key wins, otherwise the leading
 * kind (`family:<x>` and `verb:<x>` are their own keys).
 * @param fp - fingerprint string.
 * @param limits - the `limits` table.
 * @returns the cap, or `Infinity` when the kind is uncapped.
 */
export function limitFor(fp, limits) {
  const exact = limits[fp]
  if (exact !== undefined && exact !== null) return exact
  if (exact === null) return Number.POSITIVE_INFINITY
  const kind = fp.split(':')[0]
  const byKind = limits[kind]
  return byKind == null ? Number.POSITIVE_INFINITY : byKind
}
