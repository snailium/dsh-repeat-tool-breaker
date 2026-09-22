/**
 * dsh-repeat-tool-breaker — repeat detection with escalation, not just a wall.
 *
 * A local, dependency-free DSH plugin (pure ESM, no schemastery/cordis imports).
 * It registers ONE synchronous monotonic gate through the public
 * `ctx.tools.guard` API, which runs after every `tools/pre-execute` listener and
 * before the tool body:
 *
 *   ToolGuard = (execution) => string | undefined
 *   - a string => FINAL denial; the body never runs and the model receives an
 *     `isError` result whose text is that string.
 *   - undefined => leave the call allowed (a guard can never flip a denial back
 *     to allowed by ordering).
 *
 * ## Three escalating stages
 *
 * Repeating a MEASURE (a fingerprint identity — `exact:`, `cmd:`, `net:`,
 * `host:`, `sink:`, …) inside the same human turn escalates:
 *
 *   1. `warnAt` (3)      — a light advisory: you are repeating; consider another route
 *   2. `summarizeAt` (6) — a demand: summarise progress; list untried alternatives
 *   3. `limits` (9)      — the gate: ask the operator (`onLimit: ask`) or deny
 *
 * Stages 1 and 2 are ADVISORY and cannot be delivered from the guard, which
 * returns `string | undefined` and nothing else. They ride `tools/post-execute`
 * as `additionalContexts`, the same channel `@deepseek-ai/dsh-repeat-tool-reminder`
 * uses, stamped `source.kind: 'plugin'` (an unlabeled context renders as a user
 * prompt in derived history).
 *
 * ## Why the ask lives in two hooks
 *
 * `tools/pre-execute` can ask but cannot deny; `ctx.tools.guard` can deny but
 * cannot ask. The pipeline makes the two halves distinguishable (dsh-tools
 * `prepareExecution`): a REJECTED ask never reaches the guard, while an APPROVED
 * ask does. So `pendingAsk` carries the conversation — an entry consumed by the
 * guard means "approved", an entry still present in `post-execute` means
 * "declined".
 *
 * ## Counting lives in the guard and nowhere else
 *
 * The guard commits a call on BOTH outcomes — every fingerprint when the call
 * ran, only the fingerprints that hit when it did not — which keeps a model
 * hammering a denied call from resetting its own budget, stops two calls racing
 * in one step from both seeing an empty window, and stops a denied call from
 * spending budget on a resource it never touched. `tools/post-execute` only
 * records the settled result text and settles the fate of a declined ask.
 *
 * Configuration is merged from the patch's `config:` and validated fail-loud in
 * `apply`; there is no schemastery schema export, which `cordis.resolveConfig`
 * tolerates.
 */

import { blockingHits, compileTracked, isTracked, fingerprints, limitFor } from './lib/fingerprints.js'
import { askMessage, denyMessage, renderResult, summarizeMessage, warnMessage } from './lib/message.js'
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

/** A fresh message identity, without pulling in a uuid dependency. */
function messageId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (typeof uuid === 'string') return `${name}-${uuid}`
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Which measure to NAME when several cross the same stage at the same count.
 *
 * Lower is preferred. A target-scoped measure is the actionable one — "you have
 * called `api.example.com` six times" tells the model something it can act on,
 * whereas `exact:` quotes a truncated command line, and `site:` lumps unrelated
 * services together. Nothing about the escalation changes; only which identity the
 * message names.
 */
const MEASURE_PREFERENCE = ['host', 'net', 'site', 'sink', 'cmd', 'exact']

/**
 * Rank one fingerprint for the tie-break above.
 * @param fp - the fingerprint.
 * @returns its preference index; unknown kinds sort last.
 */
function measureRank(fp) {
  const index = MEASURE_PREFERENCE.indexOf(fp.split(':')[0])
  return index === -1 ? MEASURE_PREFERENCE.length : index
}

/**
 * Build the message object an `additionalContexts` entry must be. Mirrors
 * `createUserMessage` from the sibling reminder plugin: user-role content plus a
 * `source` the harness can label with, frozen before publication.
 * @param text - the advisory text.
 * @param summary - a one-line summary for derived history.
 * @returns a frozen message.
 */
function noticeMessage(text, summary) {
  return Object.freeze({
    id: messageId(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: name, form: 'notice', summary }),
  })
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
   * See the module docstring: the guard consuming an entry means the operator
   * approved; the entry surviving into `post-execute` means they declined.
   */
  const pendingAsk = new WeakMap()
  /**
   * The advisory text owed to one execution, computed in the guard (the only
   * place that sees the counts) and attached in `post-execute` (the only place
   * that can add context).
   */
  const advisoryFor = new WeakMap()
  /** Disposers of everything this plugin registered, run by the returned teardown. */
  const teardown = []

  /**
   * Decide the fate of one call: its fingerprints, the hits, and what still
   * blocks once this turn's exemptions are taken into account.
   * @param exec - the pending tool execution.
   * @param agent - the calling agent.
   */
  const evaluate = (exec, agent) => {
    const { fps, local } = fingerprints(exec, cfg)
    const hits = tracker.wouldExceed(agent, fps)
    return { fps, local, hits, blocking: blockingHits(hits, tracker.exemptSet(agent)) }
  }

  /**
   * Which advisory stage, if any, this call reaches — read BEFORE the call is
   * committed, so `count` includes it.
   *
   * A stage fires on exact equality, so each crossing produces one message: the
   * window slides, an exempted measure stops moving entirely, and a measure that
   * sits above the gate does not keep re-announcing itself. When several
   * measures cross at once, the strongest stage wins and ties go to the highest
   * count.
   * @param agent - the calling agent.
   * @param fps - the call's fingerprints.
   * @returns the advisory message, or `null`.
   */
  const stageAdvisory = (agent, fps) => {
    const counts = tracker.tallyOf(agent)
    let chosen = null
    for (const fp of fps) {
      // A measure with NO CAP has no gate, so it must have no escalation either: the
      // stages live BELOW the cap, not beside it. Without this guard the disabled
      // volume budgets (`site:`, `family:*`, `verb:*` are all `null` by default) still
      // fire advisories — reintroducing, through the advisory channel, exactly the
      // signal 0.3.2 and 0.3.3 deliberately turned off. One `curl` emits several of
      // those measures at once, so the omission produced up to four near-identical
      // messages about a single action.
      if (!Number.isFinite(limitFor(fp, cfg.limits))) continue
      const next = (counts.get(fp) ?? 0) + 1
      let stage = 0
      if (cfg.summarizeAt !== null && next === cfg.summarizeAt) stage = 2
      else if (cfg.warnAt !== null && next === cfg.warnAt) stage = 1
      if (stage === 0) continue
      const rank = measureRank(fp)
      const better =
        chosen === null ||
        stage > chosen.stage ||
        (stage === chosen.stage && (next > chosen.next || (next === chosen.next && rank < chosen.rank)))
      if (better) chosen = { stage, fp, next, rank }
    }
    if (chosen === null) return null
    const message =
      chosen.stage === 2
        ? summarizeMessage(chosen.fp, chosen.next, cfg)
        : warnMessage(chosen.fp, chosen.next, cfg)
    return noticeMessage(message, `${chosen.fp} × ${chosen.next}`)
  }

  /**
   * Offer the operator the choice when a call is about to be gated, once per
   * measure per turn. Runs before the guard, because a guard can only deny — it
   * has no way to ask.
   */
  const onPre = ctx.on('tools/pre-execute', async (exec, next) => {
    if (cfg.onLimit !== 'ask') return next()
    const { name, agent } = parts(exec)
    if (agent === null || !tracked(name)) return next()
    const { fps, hits, blocking } = evaluate(exec, agent)
    if (blocking.length === 0) return next()
    // If ANY blocking measure was already declined this turn, an approval could
    // not unblock this call anyway — so do not ask, just deny.
    if (blocking.some((hit) => tracker.isRefused(agent, hit.fp))) return next()
    pendingAsk.set(exec, { fps, hits: blocking })
    return { kind: 'ask', reason: askMessage(blocking, cfg) }
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
    const approved = pendingAsk.get(exec)
    if (approved !== undefined) {
      pendingAsk.delete(exec)
      tracker.exemptFingerprints(
        agent,
        approved.hits.map((hit) => hit.fp),
      )
    }

    const { fps, blocking } = evaluate(exec, agent)

    if (blocking.length > 0) {
      tracker.commit(agent, fps, blocking)
      return denyMessage({
        name,
        hits: blocking,
        lastResult: tracker.slot(agent).lastResult,
        cfg,
        refused: blocking.every((hit) => tracker.isRefused(agent, hit.fp)),
      })
    }

    // Allowed. The advisory is computed BEFORE the commit, so this call is
    // counted in the number it reports.
    const advisory = stageAdvisory(agent, fps)
    if (advisory !== null) advisoryFor.set(exec, advisory)
    tracker.commit(agent, fps, [])
    return undefined
  }

  const disposeGuard = ctx.tools.guard(guard)
  if (typeof disposeGuard === 'function') teardown.push(disposeGuard)

  // Records the settled result text quoted by a later denial, settles the fate of
  // a declined ask, and attaches any advisory the guard computed.
  //
  // No counting here: denied calls also reach this waterfall, so counting would
  // double-count. The guard is the only counter.
  //
  // The advisory merge requires awaiting `next()` rather than returning it, so a
  // downstream block's decision is preserved and the context composes with it
  // instead of replacing it.
  const onPost = ctx.on('tools/post-execute', async (exec, result, next) => {
    const { name, agent } = parts(exec)
    if (agent !== null) {
      const pending = pendingAsk.get(exec)
      if (pending !== undefined) {
        // A rejected ask never reached the guard, so a surviving entry means the
        // operator declined: spend the budget anyway, so the next identical call
        // is denied outright instead of re-asking, and remember the refusal.
        pendingAsk.delete(exec)
        tracker.refuseFingerprints(
          agent,
          pending.hits.map((hit) => hit.fp),
        )
        tracker.commit(agent, pending.fps, pending.hits)
      } else if (tracked(name) && result?.isError !== true) {
        const text = renderResult(result)
        if (text) tracker.slot(agent).lastResult = text.slice(0, cfg.resultPreviewChars)
      }
    }

    const downstream = await next()
    const advisory = advisoryFor.get(exec)
    advisoryFor.delete(exec)
    if (advisory === undefined) return downstream
    const existing = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : []
    return { ...downstream, additionalContexts: [advisory, ...existing] }
  })
  teardown.push(onPost)

  // A real human turn clears that agent's window — and with it the exemptions and
  // refusals. Plugin notices and tool results do not, so the breaker's own
  // messages never reset the budget they are trying to enforce.
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
