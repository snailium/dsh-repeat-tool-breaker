/**
 * `web_fetch_file` — fetch a URL to a FILE, returning the path rather than the body.
 *
 * ## Two backends, and the switch between them
 *
 * Retrieval is either the platform's web service (`ctx.web`, the polite default: its SSRF guard,
 * its redirect policy, its size caps) or a `curl` subprocess. The switch is a SETTING —
 * `fetchWithCurl` — because the two are not interchangeable and the difference is a risk the
 * operator should take deliberately rather than inherit.
 *
 * **`web` (`fetchWithCurl: false`).** Text only, by platform design:
 *
 *     classifyContentType: text/html · application/xhtml+xml · text/* · application/json|xml
 *     everything else -> `await response.body?.cancel()` then WEB_UNSUPPORTED_CONTENT_TYPE
 *
 * The bytes are discarded before anyone sees them, so a PDF, an image or an archive cannot be
 * fetched at all, and a cross-origin redirect is refused. It also cannot reach loopback or
 * RFC1918: the SSRF guard owns that decision and it is the right one for a fetch tool.
 *
 * **`curl` (the default).** Fetches anything, follows redirects wherever they go, and keeps a
 * per-session cookie jar. It reaches whatever the operator's shell can reach, loopback and private
 * addresses included, and it carries cookies — which is the point, and also the risk. Measured
 * on session b623d414: the model needed two public PDFs, and with the `web` backend every path
 * dead-ended (this tool returned `unsupported content type "application/pdf"` twice, the shell
 * was refused by this plugin's own block, and a text extractor had nothing to extract). A
 * steering block that leads to a dead end is worse than no block: it burned three calls and
 * produced nothing. That is why curl is the DEFAULT rather than an option nobody finds.
 *
 * ## Why it lives in this plugin rather than beside it
 *
 * The guard denies a shell fetch and tells the model what to use instead. A message that names a
 * tool the profile does not have is worse than no message, so **the denial and its replacement
 * ship in the same version**, and the guard reads {@link fetchFileToolState} before naming it.
 *
 * ## The boundaries the curl backend keeps
 *
 * - **http and https only.** `curl` speaks `file:`, `scp:`, `dict:` and more; a fetch tool that
 *   can read `file:///etc/passwd` is a filesystem-read primitive. The scheme is refused before
 *   curl runs.
 * - **argv, never a shell.** `spawn(curlPath, [...])` with `--` before the URL, so a URL cannot
 *   be read as a flag and nothing is ever interpolated into a command line.
 * - **`allowPrivateHosts`** can be turned off; the host is then resolved and any loopback or
 *   RFC1918 answer refuses the call. Best-effort, and stated as such: one resolution before the
 *   transfer, not a re-validation of every hop.
 * - **Size and time caps**: `--max-filesize`, `--max-time`, `--max-redirs`, plus our own unlink of
 *   the partial file on failure, so a failed download never leaves a half file that a later step
 *   would read as the document.
 * - **A per-session cookie jar** (0600) under the OS temp directory: a login established by one
 *   fetch carries to the next fetch in the SAME session, and nowhere else.
 *
 * The curl backend fetches to a temporary name first and renames afterwards, because the final
 * name depends on the effective URL (after redirects) and on the response's content type, and
 * neither is known before the transfer.
 *
 * ## Stance that did NOT change
 *
 * The promise the block makes — "do not hide a fetch in the shell, this tool reports the outcome"
 * — holds for both backends: `statusCode`, byte count, content type, effective URL and the
 * written path come back as structured fields, which is exactly what a piped `curl -o /dev/null`
 * cannot give anyone.
 *
 * ## Placement
 *
 * The file must land in the **workspace**: /tmp does not survive between shell calls in this
 * harness (verified — a file written in one call is gone in the next), so a file there would be
 * invisible to the step meant to read it. The root is resolved the way `dsh-tool-bash` does.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { resolveTarget } from './paths.js'
import { isLocalHost } from './normalize.js'

/** Defaults for the fetch-file tool, overridable from the patch layer's `config:`. */
export const FETCH_FILE_DEFAULTS = Object.freeze({
  /**
   * Which backend retrieves the bytes.
   *
   * `true` (default) is `curl`: any content type, any redirect, cookies, loopback and RFC1918,
   * i.e. what the shell could do. `false` is `ctx.web`: the platform's guard, its redirect policy,
   * its caps — and its refusal of everything that is not text, which makes a download impossible
   * rather than merely discouraged.
   */
  fetchWithCurl: true,
  /** Where fetched files go: relative to the workspace root unless absolute. */
  outputDir: 'fetched',
  /** Our own backstop on the saved body (the `web` backend caps first and reports `truncated`). */
  maxBytes: 8 * 1024 * 1024,
  /** curl only: whole-transfer cap, honoured by `--max-time`. */
  timeoutMs: 30_000,
  /** curl only: redirect hops, honoured by `--max-redirs`. Cross-origin hops are followed. */
  maxRedirects: 5,
  /** curl only: sent as `--user-agent`; a bare `curl/…` is refused by a surprising number of hosts. */
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-web-fetch-file/1.0',
  /** curl only: whether loopback and RFC1918 targets are allowed. Default true: curl can reach them. */
  allowPrivateHosts: true,
  /** curl only: share cookies between fetches of one session, via a per-session jar. */
  cookieJar: true,
  /** curl only: the binary to run. Resolved from PATH; a missing one is reported, not ignored. */
  curlPath: 'curl',
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
  'Fetch a URL and write the body to a FILE in the workspace, returning the path — not the',
  'content. Use this instead of putting a document into the conversation, and instead of',
  'downloading with the shell: a long page costs one path here, and the status, byte count,',
  'content type and effective URL come back as fields.',
  '',
  'Two backends, chosen by the `fetchWithCurl` setting, which is ON by default: retrieval runs',
  'curl, so ANY content type is saved (PDFs, images, archives), redirects are followed wherever',
  'they lead, cookies are shared between fetches of the same session, and anything the shell can',
  'reach is reachable — loopback and RFC1918 included. Turn `fetchWithCurl` OFF to retrieve',
  'through the platform web service instead: text pages only, no cross-origin redirects, and no',
  'private addresses.',
  '',
  'Returns the HTTP status, so a 404 or a 500 is reported instead of looking like a successful',
  'fetch.',
].join('\n')

/**
 * Classify a response's content type into the `kind` this tool reports.
 *
 * Mirrors the platform's own text/html split, so a caller switching between the two sees the
 * same word, and adds the cases it refuses — because those are the ones this tool exists for.
 *
 * @param contentType - the `Content-Type` header, possibly with parameters, possibly empty.
 * @returns `html`, `text`, `pdf`, `image`, `binary`, or `unknown` for an absent header.
 */
export function kindFor(contentType) {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (mime.length === 0) return 'unknown'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text'
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  return 'binary'
}

/**
 * Validate the fetch-file settings.
 * @param cfg - merged configuration.
 * @returns the validated settings.
 */
export function validateFetchFileCfg(cfg) {
  if (typeof cfg.outputDir !== 'string' || cfg.outputDir.trim().length === 0) {
    throw new Error(`repeat-tool-breaker: \`outputDir\` must be a non-empty string (got ${String(cfg.outputDir)})`)
  }
  for (const key of ['maxBytes', 'timeoutMs', 'maxRedirects']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be an integer >= 1 (got ${String(cfg[key])})`)
    }
  }
  for (const key of ['fetchWithCurl', 'allowPrivateHosts', 'cookieJar']) {
    if (typeof cfg[key] !== 'boolean') {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be a boolean (got ${String(cfg[key])})`)
    }
  }
  for (const key of ['userAgent', 'curlPath']) {
    if (typeof cfg[key] !== 'string' || cfg[key].trim().length === 0) {
      throw new Error(`repeat-tool-breaker: \`${key}\` must be a non-empty string (got ${String(cfg[key])})`)
    }
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
 * Parse and vet a target URL.
 *
 * @param url - the raw URL the model asked for.
 * @returns the parsed URL.
 * @throws when the scheme is not http or https.
 */
export function assertFetchableUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`web_fetch_file: \`url\` is not a valid URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `web_fetch_file: only http and https can be fetched (got ${parsed.protocol.replace(':', '')}) — ` +
        'curl also speaks file:, scp: and others, and a fetch tool that reads local files is not a fetch tool',
    )
  }
  return parsed
}

/**
 * Refuse a target that resolves to a private address, when the operator asked for that.
 *
 * @param parsed - the parsed URL.
 * @throws when any resolved address is loopback, link-local or RFC1918.
 */
export async function assertPublicHost(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isLocalHost(host)) {
    throw new Error(`web_fetch_file: ${host} is a local address and \`allowPrivateHosts\` is false`)
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch (error) {
    throw new Error(`web_fetch_file: cannot resolve ${host}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const privateAddresses = addresses.filter((entry) => isLocalHost(entry.address))
  if (privateAddresses.length > 0) {
    throw new Error(
      `web_fetch_file: ${host} resolves to ${privateAddresses.map((entry) => entry.address).join(', ')}, ` +
        'which is a private address and `allowPrivateHosts` is false',
    )
  }
}

/**
 * The cookie jar to use for one execution: one file per SESSION, so a login established by one
 * fetch is carried by the next, and nothing leaks into another conversation.
 *
 * @param settings - validated fetch-file settings.
 * @param exec - the current execution, whose `agent.session` names the session.
 * @returns the jar path, or undefined when the jar is disabled.
 */
export function cookieJarFor(settings, exec) {
  if (settings.cookieJar !== true) return undefined
  const session = exec?.agent?.session
  const id =
    session?.header?.id ?? session?.id ?? session?.header?.cwd ?? session?.header?.workspace ?? 'default'
  const safe = String(id).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'default'
  return join(tmpdir(), 'dsh-repeat-tool-breaker', `cookies-${safe}.txt`)
}

/**
 * Run curl for one URL and report what it did.
 *
 * @param options - `{ settings, url, target, jar, signal }`.
 * @returns `{ statusCode, contentType, bytes, finalUrl }`.
 * @throws when curl cannot be started, or exits non-zero (with its own last stderr line).
 */
export function runCurl({ settings, url, target, jar, signal }) {
  return new Promise((resolve, reject) => {
    // `\u0001` as the field separator: it cannot appear in a URL or a MIME type, unlike a tab
    // that a header value could smuggle in.
    const writeOut = '\u0001%{http_code}\u0001%{content_type}\u0001%{size_download}\u0001%{url_effective}'
    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs',
      String(settings.maxRedirects),
      '--max-time',
      String(Math.max(1, Math.ceil(settings.timeoutMs / 1000))),
      '--max-filesize',
      String(settings.maxBytes),
      '--user-agent',
      settings.userAgent,
      '--output',
      target,
      '--write-out',
      writeOut,
    ]
    if (jar !== undefined) args.push('--cookie', jar, '--cookie-jar', jar)
    // `--` last: a URL that begins with a dash is a URL, not an option.
    args.push('--', url)

    let child
    try {
      child = spawn(settings.curlPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(
        new Error(
          `web_fetch_file: cannot run ${settings.curlPath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      reject(
        new Error(
          `web_fetch_file: cannot run ${settings.curlPath} (${error instanceof Error ? error.message : String(error)}) — ` +
            'set `curlPath` if it lives somewhere unusual',
        ),
      )
    })

    child.on('close', (code) => {
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      if (code === 0) {
        const [, statusCode, contentType, size, finalUrl] = stdout.split('\u0001')
        resolve({
          statusCode: Number(statusCode) || 0,
          contentType: (contentType ?? '').trim(),
          bytes: Number(size) || 0,
          finalUrl: (finalUrl ?? url).trim() || url,
        })
        return
      }
      const why =
        code === 63
          ? ` (larger than maxBytes=${settings.maxBytes}; raise \`maxBytes\` to allow it)`
          : code === 28
            ? ` (exceeded timeoutMs=${settings.timeoutMs})`
            : code === 6
              ? ' (the host did not resolve)'
              : code === 7
                ? ' (the connection failed)'
                : ''
      const lastLine = stderr.trim().split('\n').filter((line) => line.trim().length > 0).pop() ?? ''
      reject(new Error(`web_fetch_file: curl exited ${code}${why}${lastLine.length > 0 ? `: ${lastLine}` : ''}`))
    })
  })
}

/**
 * Build the tool definition's `execute`, so it can be tested without cordis.
 *
 * The backend is chosen per CALL from the live settings, so flipping `fetchWithCurl` in the card
 * applies to the next fetch without a reload.
 *
 * @param options - `{ ctx, settings, resolveWeb }`: the context (workspace root), the validated
 *   settings, and a way to reach `ctx.web` for the default backend.
 * @returns a `web_fetch_file` execute function.
 */
export function makeFetchFileExecute({ ctx, settings, resolveWeb }) {
  return async function execute(args, exec) {
    const url = typeof args?.url === 'string' ? args.url.trim() : ''
    if (url.length === 0) throw new Error('web_fetch_file: `url` must be a non-empty string')

    const root = workspaceRootFor(ctx, exec)
    const dir = isAbsolute(settings.outputDir) ? settings.outputDir : `${root}/${settings.outputDir}`
    await mkdir(dir, { recursive: true })

    if (settings.fetchWithCurl !== true) {
      // The platform backend: text only, its guard, its caps. A URL it refuses is a fact to
      // report, so nothing is swallowed here.
      const web = typeof resolveWeb === 'function' ? resolveWeb() : undefined
      if (web === undefined) {
        throw new Error(
          'web_fetch_file: the `web` service is not mounted in this profile, so the default backend ' +
            'cannot run — set `fetchWithCurl` to fetch with curl instead',
        )
      }
      const fetched = await web.fetch({ url }, exec?.signal)
      const kind = typeof fetched?.body?.kind === 'string' ? fetched.body.kind : 'text'
      const body = typeof fetched?.body?.content === 'string' ? fetched.body.content : ''
      const target = resolveTarget({ root: dir, url: fetched?.url ?? url, kind, requested: args?.path })
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
        contentType: '',
        kind,
        finalUrl: typeof fetched?.url === 'string' ? fetched.url : url,
        ...(fetched?.truncated === true || overflow ? { truncated: true } : {}),
      }
    }

    // The curl backend: any content type.
    const parsed = assertFetchableUrl(url)
    if (settings.allowPrivateHosts !== true) await assertPublicHost(parsed)

    const jar = cookieJarFor(settings, exec)
    if (jar !== undefined) await mkdir(dirname(jar), { recursive: true })

    // Download under a temporary name: the final name needs the effective URL and the content
    // type, and both arrive with the response.
    const incoming = join(
      dir,
      `.incoming-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    try {
      const outcome = await runCurl({ settings, url: parsed.href, target: incoming, jar, signal: exec?.signal })
      const target = resolveTarget({
        root: dir,
        url: outcome.finalUrl,
        kind: outcome.contentType,
        requested: args?.path,
      })
      await mkdir(dirname(target), { recursive: true })
      await rename(incoming, target)
      if (jar !== undefined) await chmod(jar, 0o600).catch(() => {})
      return {
        path: target,
        statusCode: outcome.statusCode,
        bytes: outcome.bytes,
        contentType: outcome.contentType,
        kind: kindFor(outcome.contentType),
        finalUrl: outcome.finalUrl,
      }
    } catch (error) {
      // A failed transfer must not leave a partial file behind: a later step would read it as
      // the document, which is exactly the class of mistake this tool exists to remove.
      await unlink(incoming).catch(() => {})
      throw error
    }
  }
}

/**
 * Register `web_fetch_file`.
 *
 * Registration does not wait for `ctx.web`: the curl backend needs no such service, and the guard
 * only blocks shell HTTP while this tool is actually registered — so registering early is what
 * lets the block steer instead of strand. The default backend resolves the service lazily and
 * says so if it is absent.
 *
 * @param ctx - cordis context.
 * @param settings - validated fetch-file settings.
 * @param state - the slot to mark registered; defaults to the module singleton.
 * @returns nothing; inspect `state`.
 */
export function registerFetchFileTool(ctx, settings, state = fetchFileToolState) {
  if (typeof ctx?.tools?.register !== 'function') return
  // `registered` is the guard's fail-safe, and it must mean CAPABILITY rather than "a tool
  // definition exists". A profile with no web service and the default backend has a tool that
  // cannot fetch anything — pointing a denial at it would strand the network, which is the one
  // thing this flag exists to prevent. So it starts true only when curl is the backend, and the
  // web service turns it true when (and if) that service appears.
  state.registered = settings.fetchWithCurl === true
  let injected
  if (typeof ctx.inject === 'function') {
    // Scoped and non-blocking: capture the service when it exists, without making the plugin
    // wait for it. `ctx.get('web')` is the fallback, and `resolveWeb` may still find nothing —
    // which the default backend reports rather than failing silently.
    ctx.inject(['web'], (webCtx) => {
      // Only a context that actually CARRIES the service counts: a scoped inject may fire with
      // nothing in it, and treating that as capability is how the fail-safe would report a
      // replacement tool that cannot fetch.
      if (webCtx?.web !== undefined && webCtx.web !== null) {
        injected = webCtx.web
        state.registered = true
      }
    })
  }
  const resolveWeb = () => injected ?? ctx.get?.('web')
  const execute = makeFetchFileExecute({ ctx, settings, resolveWeb })
  ctx.tools.register({
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
          contentType: { type: 'string' },
          kind: { type: 'string' },
          finalUrl: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      // The rendering is the contract: NOTHING here may contain the body.
      render: (_args, value) => {
        const lines = [
          `Fetched (HTTP ${value.statusCode}) -> ${value.path}`,
          `${value.bytes} bytes written${value.kind ? ` (${value.kind}${value.contentType ? `: ${value.contentType}` : ''})` : ''}.`,
        ]
        if (typeof value.finalUrl === 'string' && value.finalUrl.length > 0) {
          lines.push(`Final URL: ${value.finalUrl}`)
        }
        if (value.truncated === true) {
          lines.push('The body was truncated; the file holds the truncated form.')
        }
        lines.push('Read or process the file to see the content.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    execute,
  })
  // NO `state.registered = true` here. Registering a tool definition is not capability: the flag
  // the guard reads is set at the top (curl backend) or when the web service actually arrives,
  // and a trailing assignment would erase that distinction — which is exactly what T50 caught.
}
