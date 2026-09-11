/**
 * dsh-repeat-tool-breaker
 *
 * Hard break on repeated identical tool calls.
 *
 * A local, dependency-free DSH plugin (pure ESM, no schemastery/cordis
 * imports). It registers a single synchronous monotonic gate via the public
 * Public API `ctx.tools.guard` that runs AFTER every `tools/pre-execute`
 * listener and BEFORE the tool body:
 *
 *   ToolGuard = (execution) => string | undefined
 *   - return a string => FINAL denial; the tool body never runs and the model
 *     sees an `isError` ToolResult whose text is `Error: <reason>`.
 *   - return undefined => leave the call allowed (no guard may flip a denial
 *     back to allowed by ordering).
 *
 * Default behaviour (per-agent, WeakMap-keyed on the live Agent object):
 *   - the 2nd identical (same tool name + canonically-equal arguments) call is
 *     denied with a message naming the tool, the repeat count, an argument
 *     preview, and the most recent successful result of that identical call,
 *     plus an explicit instruction not to retry and to advance or conclude.
 *   - `todo_write` (and any `exclude` patterns) is transparent: excluded calls
 *     neither count nor reset.
 *   - a new user message (`agent/pre-step` seeing a user source) clears the
 *     agent's whole chain, so a fresh instruction is never treated as a loop.
 *   - read-like tools also get a same-path cap so re-reading one file with
 *     varying arguments is limited.
 *
 * Counting happens in the GUARD for every tracked attempt (the only place that
 * runs for both allowed and denied attempts), and state is committed on allow
 * OR deny at the end of the predicate. `tools/post-execute` only records the
 * rendered result of the settled call (for the deny message quality) and emits
 * an optional advisory when the committed count reaches `warnAfter`; it never
 * increments, which is what keeps the two hooks from double-counting.
 *
 * This plugin intentionally ships WITHOUT a registration wall: it declares
 * `inject: ['tools']` so cordis activates it only once the ToolRuntime service
 * exists, at which point `ctx.tools.guard` is reachable. Configuration is
 * merged from the patch (`config:`) and validated fail-loud in `apply` — there
 * is no schemastery schema export, which `cordis.resolveConfig` tolerates.
 */

/** Stable plugin identifier. */
export const name = 'repeat-tool-breaker'

/** Injected cordis services required before `apply` runs. */
export const inject = ['tools']

const DEFAULTS = Object.freeze({
  denyAfter: 2,
  warnAfter: 1,
  registerAdvisory: true,
  exclude: ['todo_write'],
  include: [],
  readTools: ['read', 'Read', 'read_file', 'read-file', 'file-read', 'fs-read'],
  matchReadBySubstring: true,
  pathAliases: ['path', 'filePath', 'file', 'target_file'],
  maxSamePath: 3,
  previewChars: 400,
  resultPreviewChars: 800,
})

/**
 * Validate & merge configuration. Any invariants the plugin relies on throw
 * here (fail loud), mirroring the reference plugin's load-time contract.
 */
function resolveConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!Number.isInteger(cfg.denyAfter) || cfg.denyAfter < 2) {
    throw new Error('repeat-tool-breaker: `denyAfter` must be an integer >= 2')
  }
  if (cfg.denyAfter - 1 > Number.MAX_SAFE_INTEGER) {
    throw new Error('repeat-tool-breaker: `denyAfter` is too large')
  }
  if (cfg.warnAfter != null && (!Number.isInteger(cfg.warnAfter) || cfg.warnAfter < 1)) {
    throw new Error('repeat-tool-breaker: `warnAfter` must be an integer >= 1 when set')
  }
  if (cfg.maxSamePath != null && (!Number.isInteger(cfg.maxSamePath) || cfg.maxSamePath < 1)) {
    throw new Error('repeat-tool-breaker: `maxSamePath` must be an integer >= 1 when set')
  }
  for (const key of ['exclude', 'include', 'readTools', 'pathAliases']) {
    if (!Array.isArray(cfg[key]) || cfg[key].some((x) => typeof x !== 'string')) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be an array of strings`)
    }
  }
  for (const key of ['previewChars', 'resultPreviewChars']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be an integer >= 1`)
    }
  }
  Object.freeze(cfg.exclude)
  Object.freeze(cfg.include)
  Object.freeze(cfg.readTools)
  Object.freeze(cfg.pathAliases)
  return cfg
}

/** Normalize a potential `arguments` value into a plain structure. */
function asObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Deep key-sort of a JSON value so property order never changes identity. */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = {}
    for (const key of Object.keys(value).sort()) record[key] = sortJsonValue(value[key])
    return record
  }
  return value
}

/** Canonical string form: deep key-sort, then stringify (deterministic). */
function canonicalize(argumentsValue) {
  // `arguments` is the loop's parsed JSON (deep-frozen); JSON's value domain is
  // all there is, so sorting keys + stringify is a complete identity.
  try {
    return JSON.stringify(sortJsonValue(argumentsValue))
  } catch {
    return String(argumentsValue)
  }
}

/** Head-truncate a string for quoting, marking omitted length. */
function preview(text, cap) {
  const s = text == null ? '' : String(text)
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}… (+${s.length - cap} more chars)`
}

/** Render a post-execute result's model-facing text for a deny message summary. */
function renderResult(result) {
  if (!result) return ''
  const content = result.content
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  return ''
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (rest is literal). */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Install the breaker's guard + advisory listeners. */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const includePatterns = cfg.include.map(wildcardToRegExp)
  const excludePatterns = cfg.exclude.map(wildcardToRegExp)
  const readTools = new Set(cfg.readTools)

  /** Per-agent chain + result scratch. Lifecycle-bounded by the WeakMap key. */
  const byAgent = new WeakMap()

  function stateOf(agent) {
    let st = byAgent.get(agent)
    if (!st) {
      st = {
        // current consecutive-identical run
        sig: null,
        count: 0,
        // rendered result of the most recent call on the CURRENT run
        lastResult: '',
        // path -> { reads, result } for allowed same-path reads this turn-chain
        pathReads: new Map(),
      }
      byAgent.set(agent, st)
    }
    return st
  }

  function tracked(toolName) {
    if (includePatterns.length > 0 && !includePatterns.some((p) => p.test(toolName))) return false
    return !excludePatterns.some((p) => p.test(toolName))
  }

  function isReadTool(toolName) {
    if (readTools.has(toolName)) return true
    return cfg.matchReadBySubstring && /read/i.test(toolName)
  }

  function pathOf(args) {
    const obj = asObject(args)
    for (const key of cfg.pathAliases) {
      const v = obj[key]
      if (typeof v === 'string' && v.length) return v
    }
    return null
  }

  /**
   * Denial reason for an identical repeat. Mentions the previous successful
   * result summary so the model can proceed without re-running, and states the
   * hard rule. Deliberately contains no copyable `<tool_call>`/XML markup.
   */
  function denyIdentical(name, count, canonical, lastResult) {
    const lines = [
      `REPEAT_TOOL_BLOCKED: ${name} has already been called ${count} times with identical arguments this turn. The call was stopped before executing.`,
      `Arguments: ${preview(canonical, cfg.previewChars)}`,
    ]
    if (lastResult) {
      lines.push(
        `Previous result of the last such call (use it instead of re-running):\n${preview(lastResult, cfg.resultPreviewChars)}`,
      )
    } else {
      lines.push('The previous such result is already in the conversation history.')
    }
    lines.push(
      'Do not call this tool with these exact arguments again. Analyze the result above, take the next distinct step, or give the user a final answer now.',
    )
    return lines.join('\n')
  }

  function denySamePath(name, path, reads, lastResult) {
    const lines = [
      `REPEAT_PATH_BLOCKED: ${name} has already read "${path}" ${reads} times this turn (same-path cap ${cfg.maxSamePath}). The read was stopped before executing.`,
    ]
    if (lastResult) {
      lines.push(
        `Use the previous contents instead of reading again:\n${preview(lastResult, cfg.resultPreviewChars)}`,
      )
    } else {
      lines.push('The file contents are already in the conversation history.')
    }
    lines.push('Proceed with analysis of that content, or read a different file.')
    return lines.join('\n')
  }

  function warnMessage(name, count) {
    return `You just ran ${name} with identical arguments ${count} time(s). The next identical call will be hard-blocked. Analyze the latest result and change approach or finish instead of retrying it.`
  }

  /**
   * The synchronous monotonic guard: the ONLY counter. Evaluated after
   * `tools/pre-execute`, before `tools/execute`. It commits the run on every
   * tracked attempt (allow or deny), so consecutive identical attempts always
   * see a monotonic count and a repeated deny can never be let through by a
   * reset between attempts.
   */
  const guard = (exec) => {
    const name = exec.name
    const args = exec.arguments
    const agent = exec.agent
    if (!agent || !tracked(name)) return undefined

    const st = stateOf(agent)
    const canonical = canonicalize(args)
    const key = JSON.stringify([name, canonical])
    const path = isReadTool(name) ? pathOf(args) : null

    // Hard identical-arg break.
    const predCount = st.sig === key ? st.count + 1 : 1
    if (predCount >= cfg.denyAfter) {
      st.sig = key
      st.count = predCount
      return denyIdentical(name, predCount, canonical, st.lastResult)
    }

    // Same-path cap for read-like tools (varying args, same file). This read is
    // about to become an additional same-path read; block when the cap is met.
    if (path) {
      const entry = st.pathReads.get(path)
      const reads = entry ? entry.reads : 0
      if (reads >= cfg.maxSamePath) {
        return denySamePath(name, path, reads, entry ? entry.result : '')
      }
    }

    // Allowed: commit the predicted count so the next identical call denies,
    // and (for a read path) account this additional same-path read.
    st.sig = key
    st.count = predCount
    if (path) {
      const entry = st.pathReads.get(path)
      if (entry) entry.reads += 1
      else st.pathReads.set(path, { reads: 1, result: '' })
    }
    return undefined
  }

  const dispose = ctx.tools.guard(guard)
  // Cordis would dispose listeners with this ctx; also mirror the event
  // disposal so a reload (HMR) tears the guard down in the same tick.
  const teardown = []
  if (typeof dispose === 'function') teardown.push(dispose)

  // Advisory (soft) only — NEVER a deny. Runs after a settled call, records the
  // rendered result for the deny message and emits a warning when the committed
  // identical-run count reaches warnAfter. It never increments; the guard owns
  // counting.
  const pf = ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec.agent
    const execName = exec.name
    if (agent && tracked(execName)) {
      const st = stateOf(agent)
      const key = JSON.stringify([execName, canonicalize(exec.arguments)])
      const rendered = renderResult(result)
      if (st.sig === key && rendered) st.lastResult = rendered
      // Also keep the rendered result for the read path it covered, so a later
      // same-path read uses the exact previous contents in its deny message.
      if (isReadTool(execName) && rendered) {
        const path = pathOf(exec.arguments)
        if (path) {
          const entry = st.pathReads.get(path)
          if (entry) entry.result = rendered
        }
      }
    }
    const downstream = await next()
    if (!cfg.registerAdvisory) return downstream
    // Deliver the advisory exactly once per ascent through warnAfter.
    let noticeText = null
    let summary = null
    if (agent && tracked(execName)) {
      const st = byAgent.get(agent)
      if (st && st.sig === JSON.stringify([execName, canonicalize(exec.arguments)]) && st.count === cfg.warnAfter) {
        noticeText = warnMessage(execName, st.count)
        summary = `${execName} × ${st.count}`
      }
    }
    if (!noticeText) return downstream
    const message = {
      role: 'user',
      content: [{ type: 'text', text: noticeText }],
      source: { kind: 'plugin', plugin: 'repeat-tool-breaker', form: 'notice', summary },
    }
    const prepend = (ctxArr) => [message, ...(ctxArr ?? [])]
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prepend(downstream.additionalContexts) }
    }
    return { ...downstream, additionalContexts: prepend(downstream.additionalContexts) }
  })

  // New user message clears that agent's chain (identical to the reference).
  const us = ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages && messages.some((m) => m && m.source && m.source.kind === 'user')) {
      byAgent.delete(agent)
    }
    return next()
  })
  teardown.push(pf, us)

  return () => {
    for (const fn of teardown) {
      try {
        if (typeof fn === 'function') fn()
      } catch {
        /* best-effort teardown */
      }
    }
  }
}

export default { name, inject, apply }
