/**
 * `web_fetch_file` — fetch a URL to a FILE, returning the path rather than the body.
 *
 * ## Why it lives in this plugin rather than beside it
 *
 * The guard will eventually deny a shell fetch and tell the model what to use
 * instead. A message that names a tool the profile does not have is worse than no
 * message, so **the denial and its replacement have to ship in the same version**,
 * and the guard has to know whether the replacement actually registered. Both are
 * only possible if the tool lives here.
 *
 * ## Why it does not block loading
 *
 * The breaker is a guard and must load in profiles that have no web service at all
 * (headless, container). So `web` is NOT added to `inject` — that would make the
 * whole breaker wait for a service it does not need. Instead the registration is
 * wrapped in `ctx.inject(['web'], …)`, which is scoped and non-blocking: the tool
 * appears when the service does, and `fetchFileToolState.registered` tells the
 * guard which world it is in.
 *
 * The definition is written as **plain JSON Schema** rather than compiled by
 * `defineTool` from `@deepseek-ai/dsh-tools`. That is deliberate, and it is not a
 * shortcut: `ctx.tools.register` takes the COMPILED form — `parameters` and
 * `output.schema` as JSON Schema — so importing `defineTool` would only be a
 * convenience, and it would resolve a bare specifier from this package's REAL
 * path. A plugin installed by symlink (the dev and compat installs both do this)
 * has no `node_modules` of its own, so that import fails *silently* and the tool
 * simply never appears. Hand-writing the two schemas removes the failure mode,
 * removes the dependency, and keeps this plugin's test suite runnable without a
 * harness checkout.
 *
 * ## Why the tool exists at all
 *
 * Two problems, one tool.
 *
 * **Context.** `web_fetch` returns the body to the model, capped only by the
 * deployment's context budget. A reported run died on context size after fetching a
 * handful of weather pages, and the pages were the reason. Here the body goes to
 * disk and only `{ path, statusCode, bytes, kind, truncated }` travels back, so a
 * long document costs the same as a short one: a path.
 *
 * **Failure.** Shell HTTP hides its own outcome. `curl` exits **0** for a 404
 * unless it was given `--fail`; a shell that pipes it, masks it with `|| true`, or
 * discards the body with `-o /dev/null` can leave a failed fetch with no in-band
 * evidence at all — measured, there is a shape with zero residue. A tool call
 * cannot be masked that way: the status is the tool's own structured output, so
 * `statusCode` is a FACT rather than an inference from text.
 *
 * Measured over 3367 shell fetches: 70% piped the body into another command, 23%
 * wrote it to a file, 4% hit localhost, 2% posted data, and only 1% printed the
 * body for the model to read. This replaces the FIRST TWO, as two steps — which is
 * how the pipeline worked anyway:
 *
 *     web_fetch_file(url)            -> say /workspace/fetched/host-x.json
 *     bash: jq '.items' <that path>  -> the analysis step, unchanged
 *
 * ## What it deliberately does NOT do
 *
 * **Localhost.** Retrieval goes through `ctx.web`, dsh's own web service, so this
 * tool inherits its SSRF guard unchanged: a loopback URL fails with
 * `WEB_BLOCKED_URL — resolves to a non-public IP address`. That is correct for a
 * fetch tool, and it means local addresses stay a SHELL concern. Do not "fix" it
 * here: a fetch tool that can reach the loopback interface is an SSRF primitive.
 *
 * **Binary.** The provider classifies and decodes text (`body.kind` is `html` or
 * `text`); a binary response is not written as-is. Also inherited, also right.
 *
 * ## Placement
 *
 * The file must land in the **workspace**: /tmp does not survive between shell
 * calls in this harness (verified — a file written in one call is gone in the
 * next), so a file there would be invisible to the step meant to read it. The root
 * is resolved the way `dsh-tool-bash` resolves its workdir.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { resolveTarget } from './paths.js'

/** Defaults for the fetch-file tool, overridable from the patch layer's `config:`. */
export const FETCH_FILE_DEFAULTS = Object.freeze({
  /** Where fetched files go: relative to the workspace root unless absolute. */
  outputDir: 'fetched',
  /** Our own backstop; the provider caps the body first. */
  maxBytes: 8 * 1024 * 1024,
})

/**
 * A fresh state slot. The guard reads `registered` before blocking ANYTHING, which is
 * a fail-safe rather than a detail: refusing shell HTTP while the replacement tool is
 * absent is not a redirect, it is a lost capability — the network, gone.
 *
 * This is per-`apply` rather than a module singleton so that two contexts in one
 * process cannot contaminate each other; the exported `fetchFileToolState` below
 * exists only for direct use and for tests.
 */
export function createFetchFileState() {
  return { registered: false }
}

/** Default state slot, for callers that only ever have one context. */
export const fetchFileToolState = createFetchFileState()

/** The tool description, kept beside the registration it belongs to. */
export const FETCH_FILE_DESCRIPTION = [
  'Fetch a URL and write the body to a FILE in the workspace, returning the path —',
  'not the content. Use this instead of putting a document into the conversation: a',
  'long page costs one path here, and the analysis a shell pipeline would have done',
  'on it becomes a second call that reads that path.',
  '',
  'Returns the HTTP status, so a 404 or a 500 is reported instead of looking like a',
  'successful fetch. Does not reach non-public addresses (loopback, RFC1918) — use',
  'the shell for a local service.',
].join('\n')

/**
 * Validate the fetch-file settings.
 * @param cfg - merged configuration.
 * @returns the validated settings.
 */
export function validateFetchFileCfg(cfg) {
  if (typeof cfg.outputDir !== 'string' || cfg.outputDir.trim().length === 0) {
    throw new Error(`repeat-tool-breaker: \`outputDir\` must be a non-empty string (got ${String(cfg.outputDir)})`)
  }
  if (!Number.isInteger(cfg.maxBytes) || cfg.maxBytes < 1) {
    throw new Error(`repeat-tool-breaker: \`maxBytes\` must be an integer >= 1 (got ${String(cfg.maxBytes)})`)
  }
  return cfg
}

/**
 * Resolve the workspace root for one execution, the way `dsh-tool-bash` does.
 *
 * Falls back through the standing sandbox policy, then the session header's `cwd`,
 * then the process. The policy is read defensively: a profile without a confining
 * sandbox simply has none.
 *
 * @param ctx - the cordis context.
 * @param exec - the current tool execution.
 * @returns the absolute root directory.
 */
export function workspaceRootFor(ctx, exec) {
  try {
    const policy = ctx.get('sandboxPolicy')
    if (policy !== undefined && typeof policy.resolve === 'function') {
      const session = exec?.agent?.session
      const resolved = policy.resolve(session === undefined ? {} : { session })
      if (typeof resolved?.workspaceRoot === 'string') return resolved.workspaceRoot
    }
  } catch {
    /* a profile without a sandbox policy: fall through */
  }
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
  return process.cwd()
}

/**
 * Build the tool definition's `execute`, so it can be tested without cordis.
 *
 * @param options - `{ web, ctx, settings }`: the web service, the context (for the
 *   workspace root) and the validated settings.
 * @returns a `web_fetch_file` execute function.
 */
export function makeFetchFileExecute({ web, ctx, settings }) {
  return async function execute(args, exec) {
    const url = typeof args?.url === 'string' ? args.url.trim() : ''
    if (url.length === 0) throw new Error('web_fetch_file: `url` must be a non-empty string')

    // Retrieval through dsh's own service: same provider, same SSRF guard, same
    // redirect/timeout/size policy as `web_fetch`. A blocked URL or a transport
    // failure throws here and becomes a structured error result, which is the
    // point — the outcome is a fact, not something a later reader must infer.
    const fetched = await web.fetch({ url }, exec?.signal)

    const kind = typeof fetched?.body?.kind === 'string' ? fetched.body.kind : 'text'
    const body = typeof fetched?.body?.content === 'string' ? fetched.body.content : ''

    const root = workspaceRootFor(ctx, exec)
    const dir = isAbsolute(settings.outputDir) ? settings.outputDir : `${root}/${settings.outputDir}`
    const target = resolveTarget({
      root: dir,
      url: fetched?.url ?? url,
      kind,
      requested: args?.path,
    })

    const overflow = Buffer.byteLength(body, 'utf8') > settings.maxBytes
    const clipped = overflow
      ? Buffer.from(body, 'utf8').subarray(0, settings.maxBytes).toString('utf8')
      : body

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, clipped, 'utf8')

    return {
      path: target,
      statusCode: typeof fetched?.statusCode === 'number' ? fetched.statusCode : 0,
      bytes: Buffer.byteLength(clipped, 'utf8'),
      kind,
      truncated: fetched?.truncated === true || overflow,
    }
  }
}

/**
 * Register `web_fetch_file` once `ctx.web` exists.
 *
 * Non-blocking on purpose: see the module docstring. A profile with no web service
 * keeps a working guard and simply has no fetch-file tool — and the guard reads
 * {@link fetchFileToolState} before naming it.
 *
 * @param ctx - cordis context.
 * @param settings - validated fetch-file settings.
 * @param state - the slot to mark registered; defaults to the module singleton.
 * @returns nothing; inspect `state`.
 */
export function registerFetchFileTool(ctx, settings, state = fetchFileToolState) {
  // A context without scoped `inject` (a test double, or a minimal embedder) simply
  // has no web service to wait for: leave the tool unregistered and say so.
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['web'], (webCtx) => {
    const execute = makeFetchFileExecute({ web: webCtx.web, ctx, settings })
    webCtx.tools.register({
      name: 'web_fetch_file',
      description: FETCH_FILE_DESCRIPTION,
      // JSON Schema, as `register` expects. `required` belongs HERE — the value
      // schema below expresses the same thing with presence + additionalProperties.
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            statusCode: { type: 'integer' },
            bytes: { type: 'integer' },
            kind: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        // The rendering is the contract: NOTHING here may contain the body.
        render: (_args, value) => {
          const lines = [
            `Fetched (HTTP ${value.statusCode}) -> ${value.path}`,
            `${value.bytes} bytes written${value.kind ? ` (${value.kind})` : ''}.`,
          ]
          if (value.truncated === true) {
            lines.push('The provider truncated this body; the file holds the truncated form.')
          }
          lines.push('Read or process the file to see the content.')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: () => false,
      execute,
    })
    state.registered = true
  })
}
