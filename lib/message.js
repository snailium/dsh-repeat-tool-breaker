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
 * @param options - tool name, hits, last result, config, and an optional local
 *   disposition (`'policy'` when the profile's `localHosts` policy blocked a
 *   local call, `'refused'` when the operator declined to exempt local traffic
 *   this turn).
 * @returns the model-facing denial text.
 */
export function denyMessage({ name, hits, lastResult, cfg, local }) {
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
  if (local === 'refused') {
    lines.push(
      '',
      'Every hit above points at a LOCAL address (localhost / private network). Local traffic',
      'was NOT exempted this turn — the request was declined, or no approval channel was',
      'available to answer it — so local calls stay blocked until the next human message.',
    )
  } else if (local === 'policy') {
    lines.push(
      '',
      'Every hit above points at a LOCAL address (localhost / private network). This profile',
      `blocked it anyway (\`localHosts: ${cfg.localHosts}\`). If this is a development loop`,
      'rather than a crawl, use `localHosts: ask` (be prompted once per turn) or',
      '`localHosts: allow` (local traffic is never counted) on this profile\'s',
      'repeat-tool-breaker row.',
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

/**
 * The reason shown to the operator in an approval prompt, when the `localHosts`
 * policy is `ask` and a local call is about to be blocked.
 * @param hits - the offending entries.
 * @param cfg - merged configuration.
 * @returns the prompt text.
 */
export function localAskMessage(hits, cfg) {
  const list = hits.map((hit) => `  - ${preview(hit.fp, cfg.previewChars)} ${hit.next}/${hit.cap}`)
  return [
    'repeat-tool-breaker: a call to a LOCAL address (localhost / private network) is about to',
    'be blocked as a repeat:',
    ...list,
    '',
    'Approve to ignore local-address repeats for the REST OF THIS TURN. Decline and local',
    'calls keep being blocked until your next message.',
  ].join('\n')
}
