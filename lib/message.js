/**
 * The text this plugin hands to the model and to the operator.
 *
 * Four messages, one per stage plus the operator prompt:
 *
 *   - {@link warnMessage}      stage 1: a light nudge (default `warnAt`, 7)
 *   - {@link summarizeMessage} stage 2: a demand for a summary (default `summarizeAt`, 11)
 *   - {@link denyMessage}      stage 3: the denial the model receives
 *   - {@link askMessage}       stage 3: the prompt the operator receives
 *
 * The denial message is the ONLY new information the model gets on a blocked
 * call, so it has to answer three questions by itself: what was repeated (the
 * fingerprints that hit, with their counts), that cosmetic variation does not
 * count as a new action, and what to do instead (the previous result is quoted
 * inline). None of these texts may contain anything that looks like a tool-call
 * template (`<tool_call>`, `<function=`, …).
 *
 * ## On naming the measure
 *
 * The originating proposal asked for "no source names, no URLs" in the advisory
 * text, to avoid solving the task for the model. These messages name the measure
 * anyway — e.g. `host:api.weather.gc.ca` — because that is the model's OWN
 * repeated action rather than a hint about the answer (it cannot solve the task
 * with knowledge it just acted on), because the denial message has always listed
 * raw fingerprints, and because without the identity a model juggling several
 * targets cannot tell which one is being flagged. No *unrepeated* source, no
 * candidate answer and no value is ever named.
 */

import { describeFailure } from './failure.js'

/** Head-truncate text for quoting, marking how much was dropped. */
export function preview(text, cap) {
  const value = text == null ? '' : String(text)
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}… (+${value.length - cap} more chars)`
}

/**
 * Render the settled content of a tool result for inline quoting.
 * @param result - a `ToolExecutionResult`-shaped value.
 * @returns the concatenated text blocks, or `''`.
 */
export function renderResult(result) {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Stage 1 — the light warning. Deliberately small: it states the repeat and
 * suggests reconsidering the route, and demands nothing. The heavier summary
 * demand is stage 2, and the two are separate settings so an operator can run
 * either one alone.
 * @param fp - the fingerprint that was reached.
 * @param count - its count including the current call.
 * @param cfg - merged configuration.
 * @returns the advisory text.
 */
export function warnMessage(fp, count, cfg) {
  return [
    `CONVERGENCE_CHECK: you are repeating yourself — ${preview(fp, cfg.previewChars)} has come up ${count} times this turn.`,
    '',
    'Consider whether the current route is actually working, and whether a different',
    'approach would get there faster.',
  ].join('\n')
}

/**
 * Stage 2 — the summary demand. This is the load-bearing intervention: the model
 * must write down what it knows, what it assumed, what failed, and at least two
 * things it has NOT tried. In the observed failing session the model had already
 * written the correct alternative in its own compaction summary and did not act
 * on it, so the enumeration has to be explicit and immediate.
 * @param fp - the fingerprint that was reached.
 * @param count - its count including the current call.
 * @param cfg - merged configuration.
 * @returns the demand text.
 */
export function summarizeMessage(fp, count, cfg) {
  return [
    `CONVERGENCE_CHECK: ${preview(fp, cfg.previewChars)} has now come up ${count} times this turn without producing a result.`,
    '',
    'Stop and summarise your progress:',
    '',
    '  1. What you have established, and how you know it.',
    '  2. What you have assumed without verifying.',
    '  3. What you have tried that failed, and why it appears to have failed.',
    '  4. At least two approaches you have NOT yet tried, and which you will try next.',
    '',
    'Do not repeat an approach you have already listed as failed. Summarise the progress',
    'and find an alternative way forward.',
    '',
    'If you are processing in batches, use a larger per-batch amount to reduce the number',
    'of batches.',
    // Deliberately generic, and deliberately not about HTTP paging. The same failure shows
    // up in more than one shape — an agent walking many pages of one API, or reading a file
    // line by line with `read` — and advice that names paging reads as being about some
    // other problem to the agent doing the second one. "A larger per-batch amount" covers
    // both without naming a parameter, so nothing task-specific leaks either.
    // No budget percentage here on purpose: this plugin has no budget or token source, so
    // any figure would be invented. Do not "complete" this line with one.
  ].join('\n')
}

/**
 * Failure track, stage 1 — the "this is not working" nudge.
 *
 * Deliberately about the FAILURE rather than the count: the count is only what
 * makes it worth saying out loud. The three questions are the ones a stuck model
 * skips — read the error, check the target exists, fix the cause instead of
 * re-running — and they are phrased so they apply to a shell error and a 404
 * alike. The error detail is passed in because it is the one piece of information
 * the model already has and is ignoring.
 *
 * @param fp - the fingerprint whose streak was reached.
 * @param streak - the streak length, including the call that just failed.
 * @param failure - `{ reason, detail }` from the classifier.
 * @param cfg - merged configuration.
 * @returns the advisory text.
 */
export function failWarnMessage(fp, streak, failure, cfg) {
  return [
    `CONVERGENCE_CHECK: ${preview(fp, cfg.previewChars)} has failed ${streak} times in a row — ${describeFailure(failure)}.`,
    '',
    'A run of failures means the approach is not working, and repeating it is unlikely',
    'to change that. Before trying it again:',
    '',
    '  1. Read the error above and state what it actually says.',
    '  2. If it names a target — a URL, a path, a host, a command — check that the',
    '     target exists, rather than adjusting the request around it.',
    '  3. If it names a cause, fix the cause instead of re-running the same call.',
  ].join('\n')
}

/**
 * Stage 3, operator side — the exemption prompt. `reason` on an approval request
 * is all the operator sees, so it must carry the measure, the count, what
 * approving buys and what declining leaves.
 * @param hits - the offending entries.
 * @param cfg - merged configuration.
 * @returns the prompt text.
 */
export function askMessage(hits, cfg) {
  const failures = hits.filter((hit) => hit.kind === 'failure')
  const repeats = hits.filter((hit) => hit.kind !== 'failure')
  const lines = []
  if (failures.length > 0) {
    lines.push(
      'repeat-tool-breaker: this call is about to be blocked because its target keeps FAILING:',
      ...failures.map((hit) => `  - ${preview(hit.fp, cfg.previewChars)} ${hit.next} consecutive failures`),
      '',
    )
  }
  if (repeats.length > 0) {
    lines.push(
      'repeat-tool-breaker: this call is about to be blocked as a repeat:',
      ...repeats.map((hit) => `  - ${preview(hit.fp, cfg.previewChars)} ${hit.next}/${hit.cap}`),
      '',
    )
  }
  lines.push(
    'Approve to stop counting the measure(s) above for the REST OF THIS TURN — later',
    'identical calls are then allowed. Decline and those measures stay blocked until',
    'your next message.',
  )
  return lines.join('\n')
}

/**
 * Build the denial reason returned from `ctx.tools.guard`.
 * @param options - tool name, hits, last result, config, and whether the operator
 *   already declined an exemption for these measures this turn.
 * @returns the model-facing denial text.
 */
export function denyMessage({ name, hits, lastResult, cfg, refused }) {
  const failures = hits.filter((hit) => hit.kind === 'failure')
  const repeats = hits.filter((hit) => hit.kind !== 'failure')
  const lines = []
  if (failures.length > 0) {
    lines.push(
      `REPEAT_TOOL_BLOCKED: ${name || 'tool call'} (consecutive failures). The call was stopped before executing.`,
      '',
      'Failing target(s):',
    )
    for (const hit of failures) {
      const why = hit.detail ? ` (${describeFailure(hit.detail)})` : ''
      lines.push(`- ${preview(hit.fp, cfg.previewChars)} — ${hit.next} consecutive failures${why}`)
    }
    lines.push(
      '',
      'This target is not going to start working because the call is rephrased. The',
      'failure is the information: read it, check that the target exists, or fix the',
      'cause. A different call — reading the error log, grepping the code, trying another',
      'endpoint — is NOT blocked by this.',
    )
  }
  if (repeats.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      `REPEAT_TOOL_BLOCKED: repeated ${name || 'tool call'} (semantic match). The call was stopped before executing.`,
      '',
      'Hits:',
    )
    for (const hit of repeats) {
      lines.push(`- ${preview(hit.fp, cfg.previewChars)} ${hit.next}/${hit.cap}`)
    }
    lines.push(
      '',
      'Changing description ("1st"/"2nd"/"3rd"), timeoutMs, --max-time, or the host',
      'spelling (open-data.canada.ca vs open.canada.ca) does not count as a new action.',
    )
  }
  if (refused) {
    lines.push(
      '',
      'An exemption was requested for the measure(s) above and was NOT granted — the',
      'request was declined, or no approval channel was available to answer it — so they',
      'stay blocked until the next human message.',
    )
  }
  if (lastResult) {
    lines.push(
      '',
      'Previous tool result:',
      preview(lastResult, cfg.resultPreviewChars),
    )
  } else {
    lines.push('', 'The result of the previous such call is already in the conversation history.')
  }
  lines.push(
    '',
    repeats.length > 0
      ? 'Do not repeat this call with different cosmetics. Use the result above, take a genuinely'
      : 'Do not retry the failing target as-is. Use the result above, take a genuinely',
    'different action, or answer the user with what you already have.',
  )
  return lines.join('\n')
}

/**
 * The denial for a shell HTTP fetch, and the whole steering mechanism.
 *
 * It has to do three things at once: say that the call never ran, say what to use
 * instead in a form the model can act on immediately, and — critically — say what
 * still works, so the model does not conclude that fetching is broken. The two-step
 * shape is spelled out because it is the part that is not obvious: the analysis the
 * model wanted to pipe into STILL runs, just against a path.
 *
 * @param options - `{ name, localAllowed }`.
 * @returns the model-facing denial text.
 */
export function shellHttpBlockedMessage({ name, localAllowed }) {
  const lines = [
    `SHELL_HTTP_BLOCKED: this ${name || 'shell'} call fetches over HTTP and was stopped before executing.`,
    '',
    'HTTP from the shell is not available here. The reason is not policy for its own sake:',
    'a shell fetch hides its own outcome — curl exits 0 for a 404 unless it is given',
    '--fail, and `-o /dev/null` with `|| true` leaves no trace at all — so the harness',
    'cannot tell a working fetch from a broken one, and neither can you.',
  ]
  // This denial is only reachable when `web_fetch_file` IS registered — the guard
  // checks that before blocking anything, because refusing a fetch with no replacement
  // would remove the network rather than redirect it. So the message always names it.
  lines.push(
    '',
    'Use `web_fetch_file` instead: it saves the body to a FILE and returns the path, so',
    'a long page never enters the conversation, and the HTTP status comes back as a',
    'structured field.',
    '',
    'It is two steps, not a replacement for the pipeline you had in mind:',
    '',
    '  1. web_fetch_file(url)                 -> returns a path, e.g. /workspace/fetched/x.json',
    '  2. bash: jq / grep / python3 on that path   -> the analysis, unchanged',
    '',
    'Anything else you were doing with the command — parsing the body, filtering it,',
    'saving it — still works, on the file.',
  )
  if (localAllowed) {
    lines.push(
      '',
      'LOCAL addresses (127.0.0.1, ::1, RFC1918, fe80::/fc00::) are NOT covered by this',
      'block and still work from the shell — the fetch tool cannot reach them.',
    )
  }
  lines.push(
    '',
    'Do not look for another way to make this request from the shell. Rework the step to',
    'use the file, or answer with what you already have.',
  )
  return lines.join('\n')
}
