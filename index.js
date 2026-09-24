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
 * ## Two escalating tracks, one gate
 *
 * Repeating a MEASURE (a fingerprint identity — `exact:`, `cmd:`, `net:`,
 * `host:`, `sink:`, …) inside the same human turn escalates:
 *
 *   1. `warnAt` (7)      — a light advisory: you are repeating; consider another route
 *   2. `summarizeAt` (11)— a demand: summarise progress; list untried alternatives
 *   3. `limits` (12)     — the gate: ask the operator (`onLimit: ask`) or deny
 *                          (`host` is 16: the coarser measure needs more evidence)
 *
 * Failing the same measure repeatedly escalates on a SECOND, much tighter scale,
 * because failure carries information that repetition does not:
 *
 *   1. `failWarnAt` (3)  — the target keeps failing; read the error, stop guessing
 *   2. `failLimit` (5)   — the gate, subject to the same `onLimit` policy
 *
 * The failure track blocks only the fingerprints that hit: a call that does not carry
 * them (reading the error log, grepping the code, another endpoint) is allowed, since
 * blocking the recovery action wedges the model. Both tracks share the measure set, the
 * exemptions and the refusal set — see `lib/failure.js` and `lib/window.js`.
 *
 * The three move together. `lib/defaults.js` is the ground truth for the numbers and
 * `docs/issue-b-thresholds.md` for the measurement behind them; the short version is
 * that the gate fires before the advisory, so a stage at or above every cap can never
 * be delivered.
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

import {
  blockingHits,
  compileTracked,
  isShell,
  isTracked,
  fingerprints,
  limitFor,
} from './lib/fingerprints.js'
import {
  askMessage,
  denyMessage,
  failWarnMessage,
  renderResult,
  shellHttpBlockedMessage,
  summarizeMessage,
  warnMessage,
} from './lib/message.js'
import { classifyFailure } from './lib/failure.js'
import { fetchFileToolState, registerFetchFileTool } from './lib/fetch-file.js'
import { createTracker, hasUserMessage } from './lib/window.js'
import { mergeDefaults, validateCfg } from './lib/defaults.js'
import { firstVerb } from './lib/normalize.js'

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
  /**
   * Executions THIS plugin stopped. A denial is not the model's failure, and
   * counting it as one would make the guard feed itself: deny a call, the streak
   * grows, the next call is denied one step earlier. Rejected asks land here too
   * (the call never ran), and they are recorded where the ask is settled.
   */
  const deniedByUs = new WeakSet()
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
    // Two tracks, one gate. The failure hits come first because they are the more
    // actionable of the two, and both go through the same exemption/refusal path
    // below -- a second gate would need a second ask, a second refusal set and a
    // second way to get stuck.
    const hits = [
      ...tracker.failureHits(agent, fps),
      ...tracker.wouldExceed(agent, fps).map((hit) => ({ ...hit, kind: 'repeat' })),
    ]
    return { fps, local, hits, blocking: blockingHits(hits, tracker.exemptSet(agent)) }
  }

  /**
   * Whether this shell call is an HTTP fetch that the block covers.
   *
   * The test is SEMANTIC and destination-based, so it does not care how the request
   * is made: `curl`, `wget`, a `python3 -c` one-liner, a `node -e`, an absolute
   * `/usr/bin/curl`, or a script run by name all carry the destination in the
   * command text. Enumerating downloader names would have missed the interpreters
   * and been defeated by an absolute path.
   *
   * `host:` is the non-local-target marker: with the shipped `includeLocal: false`
   * it is emitted ONLY for a non-local host, so a call carrying one is fetching
   * something remote. `family:http-fetch` covers an HTTP verb with no URL in the
   * text (`curl --config …`). A purely local call carries neither, which is what
   * keeps localhost usable -- see `blockLocalHttp` for why that matters.
   *
   * @param fps - the call's fingerprints.
   * @param local - whether every URL in the call was local.
   * @returns whether the call is a covered HTTP fetch.
   */
  const isBlockedShellHttp = (fps, local, command) => {
    if (cfg.blockShellHttp !== true) return false
    // An incidental fetch by a local tool (a package manager, `git`) is left alone:
    // there is no fetch-to-file equivalent, so blocking it removes the capability
    // instead of redirecting it. See `shellHttpAllow`.
    if (cfg.shellHttpAllow.length > 0 && cfg.shellHttpAllow.includes(firstVerb(command))) return false
    const remote = local !== true && fps.some((fp) => fp.startsWith('host:'))
    const httpVerb = fps.includes('family:http-fetch')
    if (remote || (httpVerb && local !== true)) return true
    if (cfg.blockLocalHttp === true && local === true) {
      return fps.some((fp) => fp.startsWith('net:'))
    }
    return false
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

    // The HTTP block is a flat refusal, not an escalation: it fires on the FIRST
    // fetch, it never asks, and it does not depend on a count. Asking would defeat
    // the purpose -- the point is that this class of call cannot happen, so that
    // every fetch goes through a tool whose status is a fact.
    if (isShell(name)) {
      const { fps: blockFps, local } = fingerprints(exec, cfg)
      const { args } = parts(exec)
      if (isBlockedShellHttp(blockFps, local, typeof args?.command === 'string' ? args.command : '')) {
        deniedByUs.add(exec)
        return shellHttpBlockedMessage({
          name,
          toolAvailable: fetchFileToolState.registered,
          localAllowed: cfg.blockLocalHttp !== true,
        })
      }
    }

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
      deniedByUs.add(exec)
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

  // `web_fetch_file` is registered only when the profile actually has the web
  // service. It is the replacement a denial points at, so the guard must know
  // whether it exists -- naming a tool a profile does not have is worse than
  // naming nothing.
  registerFetchFileTool(ctx, { outputDir: cfg.outputDir, maxBytes: cfg.maxBytes })

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
    let failureAdvisory
    if (agent !== null && tracked(name)) {
      const pending = pendingAsk.get(exec)
      if (pending !== undefined) {
        // A rejected ask never reached the guard, so a surviving entry means the
        // operator declined: spend the budget anyway, so the next identical call
        // is denied outright instead of re-asking, and remember the refusal.
        // The call did not run, so it is not a failure either.
        deniedByUs.add(exec)
        pendingAsk.delete(exec)
        tracker.refuseFingerprints(
          agent,
          pending.hits.map((hit) => hit.fp),
        )
        tracker.commit(agent, pending.fps, pending.hits)
      } else if (!deniedByUs.has(exec)) {
        // The failure track is settled HERE and only here: the outcome is not known
        // before the call runs, which is also why the gate for it can only ever
        // fire on a LATER call.
        const { fps } = fingerprints(exec, cfg)
        // `shell` gates the text fallback: a shell's exit code is masked by
        // pipelines, so its text is the only remaining evidence; other tools answer
        // through their structured value and must not be guessed at from prose.
        const failure = classifyFailure(result, { shell: isShell(name) })
        const warned = tracker.noteOutcome(agent, fps, failure)
        if (warned.length > 0) {
          // Name the longest streak. A tie is broken by `measureRank` for the same
          // reason the occurrence stages do it: identical calls cross `exact:`,
          // `cmd:`, `net:` and `host:` together, and naming `exact:` quotes a
          // truncated command line instead of the target the model can act on.
          const top = warned.reduce((best, entry) =>
            entry.streak > best.streak ||
            (entry.streak === best.streak && measureRank(entry.fp) < measureRank(best.fp))
              ? entry
              : best,
          )
          failureAdvisory = noticeMessage(
            failWarnMessage(top.fp, top.streak, failure, cfg),
            `${top.fp} failed x${top.streak}`,
          )
        }
        const text = renderResult(result)
        if (text) tracker.slot(agent).lastResult = text.slice(0, cfg.resultPreviewChars)
      }
    }

    const downstream = await next()
    const advisory = advisoryFor.get(exec)
    advisoryFor.delete(exec)
    // At most one message per track. Both may fire on the same call -- a repeated
    // call that also failed -- and the failure one goes first because it is the
    // more actionable of the two.
    const owed = [failureAdvisory, advisory].filter((entry) => entry !== undefined)
    if (owed.length === 0) return downstream
    const existing = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : []
    return { ...downstream, additionalContexts: [...owed, ...existing] }
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

export { fetchFileToolState, isTracked }

export default { name, inject, apply }
