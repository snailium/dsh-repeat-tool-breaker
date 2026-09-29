/**
 * The shell-HTTP block's whole policy, as one pure function.
 *
 * It lives here rather than inside `apply` so the decision can be tested and measured
 * directly. The evidence tool (`tools/allowlist-vs-denylist-delta.mjs`) calls THIS, and an
 * earlier draft re-implemented the rule by hand — which drifted from the real one three
 * times, each drift showing up as a phantom "newly refused" set. A measurement that
 * paraphrases the thing it measures is not a measurement.
 *
 * ## The rule is a BLACKLIST, and the blacklist is a setting
 *
 * `shellHttpBlock` lists the commands to filter. The tool does exactly that: it traverses
 * every place the command line can run something (`unwrapCommands`), and refuses when any
 * of those candidates has a blacklisted verb, or names a request API outright.
 *
 * A command is refused because it RUNS something that fetches, never because it CONTAINS
 * an address. An address appears in a grep pattern, a heredoc writing a README, a commit
 * message quoting a link; a mechanism appears only when a request is about to happen. The
 * earlier rule also fired on any non-local URL, which turned all of those ordinary commands
 * into refusals, each carrying a message asserting the call "fetches over HTTP" — false —
 * and pointing at `web_fetch_file`, which cannot help with a grep.
 *
 * Coverage is deliberately incomplete and extensible: another shell to open is another line
 * in `SHELL_HOSTS`, and another command to filter is another entry in the setting. Neither
 * needs the rule to understand where a mechanism appears, which is the modelling that got
 * this wrong in both directions.
 *
 * @module dsh-repeat-tool-breaker/block-policy
 */

import { FETCH_API, REMOTE_CLIENTS, extractUrls, firstVerb, isLocalHost, isThisMachineHost, normUrl, remoteClientTarget, stripInertHeredocs, unwrapCommands } from './normalize.js'

/**
 * Decide whether a shell call is refused by the HTTP block.
 *
 * @param command - the shell command line.
 * @param cfg - the validated configuration.
 * @returns true when the call must be refused.
 */
/**
 * Whether a segment only LOOKS UP command names, so a blacklisted word among them is data.
 *
 * @param candidate - one command segment.
 * @returns true for `command -v| -V <names>`, `which <names>`, `type <names>`.
 */
function looksUpAName(candidate) {
  const tokens = candidate.trim().split(/\s+/)
  const head = tokens[0] ?? ''
  if (head === 'which' || head === 'type') return true
  // `command` alone EXECUTES its argument (`command curl …` is a real fetch); only the
  // lookup flags make it a query.
  return head === 'command' && (tokens[1] === '-v' || tokens[1] === '-V')
}

/**
 * Whether a named verb has anything to act on. A bare `curl` prints usage and fetches
 * nothing, so a lone word — from a regex, a banner, or a `grep -c` tally — is not a fetch.
 *
 * @param candidate - one command segment.
 * @returns true when at least one token follows the verb.
 */
function hasAnArgument(candidate) {
  return candidate.trim().split(/\s+/).length > 1
}

export function blockShellHttp(command, cfg) {
  const blacklist = cfg.shellHttpBlock

  // A command whose every address is local is not a remote fetch, whatever mechanism it
  // uses. Computed over the WHOLE command on purpose: `unwrapCommands` splits a heredoc on
  // newlines and commas, so the request API and its address land in DIFFERENT segments —
  // `import json, urllib.request` arrives as an address-less segment and the local URL as
  // another. A per-segment test then sees an "API with no address" and refuses it, while
  // the per-segment local exemption can never fire. Measured: four such refusals in one
  // session, one of them a script that fetched nothing at all.
  const everyAddress = extractUrls(stripInertHeredocs(command))
    .map((raw) => normUrl(raw, cfg.hostAliases))
    .filter((url) => url !== null)
  if (
    everyAddress.length > 0 &&
    everyAddress.every((url) => isLocalHost(url.host)) &&
    cfg.blockLocalHttp !== true
  ) {
    return false
  }

  // `ssh localhost 'curl …'` is a local fetch wearing a costume and IS judged; an `ssh` to
  // another machine fetches over there, where `web_fetch_file` cannot act at all, so it is not.
  const payloadRunsHere = (candidate) => {
    const verb = firstVerb(candidate)
    // Everything that is not a remote client keeps its payload opened, exactly as before:
    // `bash -c '…'` runs HERE and must still be judged.
    if (!REMOTE_CLIENTS.has(verb)) return true
    const host = remoteClientTarget(candidate)
    return host !== null && isThisMachineHost(host)
  }
  for (const candidate of unwrapCommands(command, { openRemote: payloadRunsHere })) {
    const verb = firstVerb(candidate)
    if (REMOTE_CLIENTS.has(verb) && !payloadRunsHere(candidate)) continue
    // A blacklisted word in a NAME LIST is a name, not a command: `command -v curl`,
    // `which wget`, `type curl`. Checking whether a tool exists fetches nothing.
    if (looksUpAName(candidate)) continue
    const named = verb.length > 0 && blacklist.includes(verb) && hasAnArgument(candidate)
    // The interpreter arm: `python3` cannot go on the list without refusing every local
    // script, so a request API inside the program is what names the mechanism there.
    const api = FETCH_API.test(candidate)
    if (!named && !api) continue

    // A blacklisted fetch aimed only at the local machine stays. That is not leniency:
    // `web_fetch_file` reuses dsh's retrieval and inherits its SSRF guard, so it CANNOT
    // reach loopback or RFC1918 — refusing these would leave no way to do them at all.
    const urls = extractUrls(candidate)
      .map((raw) => normUrl(raw, cfg.hostAliases))
      .filter((url) => url !== null)
    const localOnly = urls.length > 0 && urls.every((url) => isLocalHost(url.host))
    if (localOnly && cfg.blockLocalHttp !== true) continue

    return true
  }
  return false
}
