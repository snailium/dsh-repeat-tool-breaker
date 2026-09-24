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

import { FETCH_API, extractUrls, firstVerb, isLocalHost, normUrl, unwrapCommands } from './normalize.js'

/**
 * Decide whether a shell call is refused by the HTTP block.
 *
 * @param command - the shell command line.
 * @param cfg - the validated configuration.
 * @returns true when the call must be refused.
 */
export function blockShellHttp(command, cfg) {
  const blacklist = cfg.shellHttpBlock
  for (const candidate of unwrapCommands(command)) {
    const verb = firstVerb(candidate)
    const named = verb.length > 0 && blacklist.includes(verb)
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
