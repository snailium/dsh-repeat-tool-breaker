/**
 * The denial text. This message is the ONLY new information the model gets on
 * a blocked call, so it has to answer three questions by itself:
 *
 *   1. what was repeated (the fingerprints that hit, with their counts),
 *   2. that cosmetic variation does not count as a new action, and
 *   3. what to do instead (the previous result is quoted inline).
 *
 * It must not contain anything the model could mistake for a tool-call
 * template (`<tool_call>`, `<function=`, …).
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
 * Build the denial reason returned from `ctx.tools.guard`.
 * @param options - tool name, hits, last result, config.
 * @returns the model-facing denial text.
 */
export function denyMessage({ name, hits, lastResult, cfg }) {
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
