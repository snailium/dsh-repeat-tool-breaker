/**
 * The text this plugin hands to the model and to the operator.
 *
 * Four messages, one per stage plus the operator prompt:
 *
 *   - {@link warnMessage}      stage 1 (count 3): a light nudge
 *   - {@link summarizeMessage} stage 2 (count 6): a demand for a summary
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
 * Stage 3, operator side — the exemption prompt. `reason` on an approval request
 * is all the operator sees, so it must carry the measure, the count, what
 * approving buys and what declining leaves.
 * @param hits - the offending entries.
 * @param cfg - merged configuration.
 * @returns the prompt text.
 */
export function askMessage(hits, cfg) {
  const list = hits.map((hit) => `  - ${preview(hit.fp, cfg.previewChars)} ${hit.next}/${hit.cap}`)
  return [
    'repeat-tool-breaker: this call is about to be blocked as a repeat:',
    ...list,
    '',
    'Approve to stop counting the measure(s) above for the REST OF THIS TURN — later',
    'identical calls are then allowed. Decline and those measures stay blocked until',
    'your next message.',
  ].join('\n')
}

/**
 * Build the denial reason returned from `ctx.tools.guard`.
 * @param options - tool name, hits, last result, config, and whether the operator
 *   already declined an exemption for these measures this turn.
 * @returns the model-facing denial text.
 */
export function denyMessage({ name, hits, lastResult, cfg, refused }) {
  const lines = [
    `REPEAT_TOOL_BLOCKED: repeated ${name || 'tool call'} (semantic match). The call was stopped before executing.`,
    '',
    'Hits:',
  ]
  for (const hit of hits) {
    lines.push(`- ${preview(hit.fp, cfg.previewChars)} ${hit.next}/${hit.cap}`)
  }
  lines.push(
    '',
    'Changing description ("1st"/"2nd"/"3rd"), timeoutMs, --max-time, or the host',
    'spelling (open-data.canada.ca vs open.canada.ca) does not count as a new action.',
  )
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
    'Do not repeat this call with different cosmetics. Use the result above, take a genuinely',
    'different action, or answer the user with what you already have.',
  )
  return lines.join('\n')
}
