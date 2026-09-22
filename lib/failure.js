/**
 * Deciding whether a settled tool result is a FAILURE.
 *
 * `result.isError` is NOT the answer, and using it as one is the mistake this
 * module exists to prevent. It is true only when the CALL failed — a thrown
 * error, an unknown tool, a sandbox denial, an abort. It is `false` for a
 * non-zero exit code and `false` for an HTTP 404, which are the two shapes that
 * actually matter:
 *
 *   - `dsh-tool-bash` renders a non-zero exit as an `[exit code: N]` marker in
 *     the text and returns `{ kind: 'foreground', exitCode: N, … }` as the
 *     structured value. The call SUCCEEDED; the command did not.
 *   - `dsh-tool-web` heads its text with `Fetched <url> (HTTP <status>)` and
 *     returns `{ url, statusCode, … }`. A 404 is a successful fetch.
 *
 * Measured over 40 recorded sessions: `data.error` (the thrown case) covers 40 of
 * 6765 bash results — 0.6%. Counting only that would make the failure track blind
 * to almost every real failure.
 *
 * The structured value is the reliable channel, because each tool declares it in
 * `output.schema`; the text markers are the fallback for a tool that declares
 * nothing useful. Both are checked, structured first.
 *
 * ## What is deliberately NOT a failure
 *
 *   - `aborted` — a cancellation is external to the model's choice, and counting
 *     it would punish the model for the operator stopping a call.
 *   - a background job that started — `{ kind: 'background', jobId }` means the
 *     work was launched; its exit code arrives later and is not this call's.
 *
 * ## A denial by SOMETHING ELSE is counted, and that is deliberate
 *
 * `isError` also covers a call blocked by another plugin, or by the harness's own
 * policy layer. Those calls never ran, so calling them failures is arguable — but a
 * model that keeps running into the same wall is looping in the sense that matters
 * here, and telling the two apart would mean pattern-matching another plugin's
 * message text. THIS plugin's own denials are the exception and are excluded
 * explicitly (see `deniedByUs` in `index.js`): counting those would make the guard
 * feed itself, since each denial would arm the next one a step earlier.
 */

/** Read `result.value` if it is a plain object, else an empty object. */
function valueOf(result) {
  const value = result?.value
  return value !== null && typeof value === 'object' ? value : {}
}

/**
 * Classify one settled tool result.
 *
 * @param result - the `ToolExecutionResult`-shaped value from `post-execute`.
 * @returns `null` when the call succeeded, otherwise `{ reason, detail }` — a
 *   short machine-ish reason (`exit`, `http`, `timeout`, `signal`, `error`) and
 *   the specific evidence, for the message text.
 */
export function classifyFailure(result) {
  // A thrown failure. The most specific case, so it is checked first.
  if (result?.isError === true) {
    const code = result.error?.code ?? result.error?.name
    return { reason: 'error', detail: typeof code === 'string' ? code : '' }
  }

  const value = valueOf(result)
  if (value.kind === 'background') return null

  // A command that ran and exited non-zero. Not an `isError`.
  if (typeof value.exitCode === 'number' && value.exitCode !== 0) {
    return { reason: 'exit', detail: String(value.exitCode) }
  }
  if (value.timedOut === true) {
    return { reason: 'timeout', detail: value.timeoutMs ? `${value.timeoutMs}ms` : '' }
  }
  if (typeof value.signal === 'string' && value.signal.length > 0) {
    return { reason: 'signal', detail: value.signal }
  }

  // A fetch that completed with an error status. Also not an `isError`.
  if (typeof value.statusCode === 'number' && value.statusCode >= 400) {
    return { reason: 'http', detail: String(value.statusCode) }
  }
  if (value.sandbox?.denied === true) {
    return { reason: 'sandbox', detail: String(value.sandbox.mode ?? '') }
  }

  // Fallback for a tool that declares no useful structured value: read the text
  // markers the harness renderers emit.
  return classifyFromText(result)
}

/** One line describing the failure, for quoting in a message. */
export function describeFailure(failure) {
  if (failure === null) return ''
  const suffix = failure.detail ? ` ${failure.detail}` : ''
  switch (failure.reason) {
    case 'exit':
      return `the command exited${suffix}`
    case 'http':
      return `the request returned HTTP${suffix}`
    case 'timeout':
      return `the call timed out${suffix ? ` (${suffix})` : ''}`
    case 'signal':
      return `the command was killed by signal${suffix}`
    case 'sandbox':
      return `the sandbox denied the operation${suffix ? ` (${suffix})` : ''}`
    case 'error':
      return `the call raised an error${suffix ? ` (${suffix})` : ''}`
    default:
      return 'the call failed'
  }
}

/**
 * Text-marker fallback. Kept separate so the structured path is obviously the
 * primary one; these patterns mirror the renderers in `dsh-tool-bash` and
 * `dsh-tool-web`.
 * @param result - the settled result.
 * @returns the same shape as {@link classifyFailure}.
 */
function classifyFromText(result) {
  const text = Array.isArray(result?.content)
    ? result.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
    : ''
  if (text.length === 0) return null

  const exit = /\[exit code: (-?\d+)\]/.exec(text)
  if (exit !== null && Number(exit[1]) !== 0) return { reason: 'exit', detail: exit[1] }
  const http = /\(HTTP (\d{3})\)/.exec(text)
  if (http !== null && Number(http[1]) >= 400) return { reason: 'http', detail: http[1] }
  if (/\[timed out after (\d+)ms\]/.test(text)) {
    return { reason: 'timeout', detail: `${/\[timed out after (\d+)ms\]/.exec(text)[1]}ms` }
  }
  const signal = /\[killed by signal: ([^\]]+)\]/.exec(text)
  if (signal !== null) return { reason: 'signal', detail: signal[1] }
  if (/\[sandbox: file access denied/.test(text)) return { reason: 'sandbox', detail: '' }
  return null
}
