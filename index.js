/**
 * dsh-repeat-tool-breaker v2 — hard break on repeated tool calls.
 *
 * A local, dependency-free DSH plugin (pure ESM, no schemastery/cordis
 * imports). It registers ONE synchronous monotonic gate through the public
 * `ctx.tools.guard` API, which runs after every `tools/pre-execute` listener
 * and before the tool body:
 *
 *   ToolGuard = (execution) => string | undefined
 *   - a string => FINAL denial; the body never runs and the model receives an
 *     `isError` result whose text is that string.
 *   - undefined => leave the call allowed (a guard can never flip a denial back
 *     to allowed by ordering).
 *
 * WHY v2 EXISTS — three loops v1 could not see:
 *
 *   A. byte-identical repeat                    -> v1 caught this.
 *   B. `description: '1st'|'2nd'|'3rd'` plus a churning `timeoutMs` made every
 *      call textually NEW, so the exact-argument counter never advanced.
 *   C. `curl --max-time 60 open-data.canada.ca` vs `curl --max-time 30
 *      open.canada.ca` alternated forever, because v1 counted only
 *      CONSECUTIVE identical calls and never normalized the command.
 *
 * v2 answers with:
 *
 *   - `ignoreArgs`: decoy/presentation arguments are deleted BEFORE any
 *     fingerprint string is built, so they cannot launder a repeat (B).
 *   - a per-agent sliding WINDOW plus semantic fingerprints — `net:` (host +
 *     path, alias-folded, query stripped), `site:`, `sink:` (where the bytes
 *     are written), `cmd:` (verb + command with volatile flags removed),
 *     `family:`/`verb:` — so alternating spellings still collide (C).
 *   - nothing path-only for file tools: `read`/`write`/`edit` are identified by
 *     POSITION through `exact:` (same file at the same offset, or the same
 *     replacement string). A different offset or region is a different action,
 *     and a path-only counter cannot tell the two apart — see CHANGELOG 0.2.2.
 *
 * Counting lives in the GUARD and nowhere else: the guard commits a call on
 * BOTH outcomes (allow and deny) — every fingerprint when the call ran, only the
 * fingerprints that hit when it did not — which keeps a model hammering a denied
 * call from resetting its own budget, stops two calls racing in one step from
 * both seeing an empty window, and stops a denied call from spending budget on a
 * resource it never touched. `tools/post-execute` only records the settled result
 * text used in the denial message — it never counts.
 *
 * Configuration is merged from the patch's `config:` and validated fail-loud in
 * `apply`; there is no schemastery schema export, which `cordis.resolveConfig`
 * tolerates.
 */

import { allHitsRelaxable, blockingHits, compileTracked, isTracked, fingerprints } from './lib/fingerprints.js'
import { denyMessage, localAskMessage, renderResult } from './lib/message.js'
import { createTracker, hasUserMessage } from './lib/window.js'
import { mergeDefaults, validateCfg } from './lib/defaults.js'

/** Stable plugin identifier. */
export const name = 'repeat-tool-breaker'

/** Injected cordis services required before `apply` runs. */
export const inject = ['tools']

/**
 * Pull the call's identity out of a pipeline execution, tolerating the shapes
 * seen across `tools/*` hooks.
 * @param exec - a tool execution.
 * @returns `{ name, args, agent }`.
 */
function parts(exec) {
  return {
    name: exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? '',
    args: exec?.arguments ?? exec?.args ?? {},
    agent: exec?.agent ?? exec?.exec?.agent ?? null,
  }
}

/**
 * Install the breaker.
 * @param ctx - plugin context (must expose `tools`).
 * @param config - raw configuration from the patch.
 * @returns a teardown function.
 */
export function apply(ctx, config = {}) {
  const cfg = validateCfg(mergeDefaults(config))
  const tracker = createTracker(cfg)
  const tracked = compileTracked(cfg)
  /**
   * Executions this plugin has asked about, mapped to what it would have denied.
   *
   * This is how the two halves of the `ask` policy talk to each other, and it
   * rests on one fact of the pipeline (dsh-tools `prepareExecution`):
   *
   *   - a REJECTED ask never reaches the guard — the registry materializes the
   *     denial straight from the approval decision — so a pending entry left in
   *     `post-execute` means "the operator said no";
   *   - an APPROVED ask does reach the guard, so an entry consumed there means
   *     "the operator said yes". The guard cannot be told otherwise: it runs
   *     AFTER the approval resolves and can only deny.
   */
  const pendingAsk = new WeakMap()
  /** Disposers of everything this plugin registered, run by the returned teardown. */
  const teardown = []

  /**
   * Decide the fate of one call: its fingerprints, the hits, and what still
   * blocks once the agent's local exemption is taken into account.
   * @param exec - the pending tool execution.
   * @param agent - the calling agent.
   */
  const evaluate = (exec, agent) => {
    const { fps, local } = fingerprints(exec, cfg)
    const hits = tracker.wouldExceed(agent, fps)
    const exempt = tracker.isLocalExempt(agent)
    return { fps, local, hits, blocking: blockingHits(hits, local, exempt), exempt }
  }

  /**
   * Offer the operator the choice on a local block, once per turn. Runs before
   * the guard, because a guard can only deny — it has no way to ask.
   */
  const onPre = ctx.on('tools/pre-execute', async (exec, next) => {
    if (cfg.localHosts !== 'ask') return next()
    const { name, agent } = parts(exec)
    // An ask is only worth making when local traffic is the ONLY reason this call
    // would be denied; a real repeat must stay a straight denial.
    if (agent === null || !tracked(name) || tracker.isLocalRefused(agent) || tracker.isLocalExempt(agent)) {
      return next()
    }
    const { fps, local, hits, blocking } = evaluate(exec, agent)
    if (blocking.length !== hits.length || !allHitsRelaxable(hits, local)) return next()
    pendingAsk.set(exec, { fps, hits })
    return { kind: 'ask', reason: localAskMessage(hits, cfg) }
  })
  teardown.push(onPre)

  /**
   * The synchronous monotonic guard — the one and only counter. It must never
   * await, resolve DNS, or touch the disk.
   */
  const guard = (exec) => {
    const { name, agent } = parts(exec)
    if (agent === null || !tracked(name)) return undefined

    // Reaching the guard with a pending ask means the operator approved it.
    if (pendingAsk.has(exec)) {
      pendingAsk.delete(exec)
      tracker.exemptLocal(agent)
    }

    const { fps, local, hits, blocking } = evaluate(exec, agent)
    tracker.commit(agent, fps, blocking)
    if (blocking.length === 0) return undefined
    const localOnly = allHitsRelaxable(blocking, local)
    return denyMessage({
      name,
      hits: blocking,
      lastResult: tracker.slot(agent).lastResult,
      cfg,
      local: localOnly ? (tracker.isLocalRefused(agent) ? 'refused' : 'policy') : undefined,
    })
  }


  const disposeGuard = ctx.tools.guard(guard)
  if (typeof disposeGuard === 'function') teardown.push(disposeGuard)

  // Records the settled result text quoted by a later denial. No counting here:
  // denied calls also reach this waterfall, so counting would double-count.
  //
  // It also settles the fate of an ask. A rejected ask never reached the guard
  // (see `pendingAsk`), so a pending entry here means the operator declined:
  // spend the budget anyway, so the next identical local call is denied outright
  // instead of re-asking, and remember the refusal for the rest of the turn.
  const onPost = ctx.on('tools/post-execute', async (exec, result, next) => {
    const { name, agent } = parts(exec)
    if (agent === null) return next()
    const pending = pendingAsk.get(exec)
    if (pending !== undefined) {
      pendingAsk.delete(exec)
      tracker.refuseLocal(agent)
      tracker.commit(agent, pending.fps, pending.hits)
      return next()
    }
    if (tracked(name) && result?.isError !== true) {
      const text = renderResult(result)
      if (text) tracker.slot(agent).lastResult = text.slice(0, cfg.resultPreviewChars)
    }
    return next()
  })
  teardown.push(onPost)

  // A real human turn clears that agent's window. Plugin notices and tool
  // results do not, so the breaker's own denial never resets the budget it is
  // trying to enforce.
  const onPreStep = ctx.on('agent/pre-step', (input, next) => {
    const agent = input?.agent ?? null
    if (agent !== null && hasUserMessage(input?.messages)) tracker.reset(agent)
    return next()
  })
  teardown.push(onPreStep)

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

export { isTracked }

export default { name, inject, apply }
