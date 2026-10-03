/**
 * dsh-repeat-tool-breaker/fetch-file — standalone web_fetch_file tool component.
 *
 * Exposes `web_fetch_file` as an independent Cordis component that can be
 * toggled on and off independently in DSH Settings → Plugins.
 *
 * When enabled, registers `web_fetch_file` into `ctx.tools` and announces
 * its capability through `fetchFileToolState.registered = true`.
 * When disabled, unregisters the tool, allowing `repeat-tool-breaker`'s
 * fail-safe to gracefully permit shell HTTP downloads.
 */

import z from '@deepseek-ai/schemastery'
import {
  FETCH_FILE_DEFAULTS,
  fetchFileToolState,
  registerFetchFileTool,
  validateFetchFileCfg,
} from './fetch-file.js'

export const name = 'web-fetch-file'
export const inject = ['tools']

export const Config = z.object({
  fetchWithCurl: z
    .boolean()
    .default(FETCH_FILE_DEFAULTS.fetchWithCurl)
    .description('Fetch with curl instead of the platform web service (supports arbitrary content types, redirects, cookies).')
    .volatile(),
  outputDir: z
    .string()
    .default(FETCH_FILE_DEFAULTS.outputDir)
    .description('Directory where fetched files are saved, relative to the workspace root.')
    .volatile(),
  maxBytes: z
    .number()
    .default(FETCH_FILE_DEFAULTS.maxBytes)
    .description('Maximum body size in bytes to save (default 8MB).')
    .volatile(),
  timeoutMs: z
    .number()
    .default(FETCH_FILE_DEFAULTS.timeoutMs)
    .description('Timeout for curl downloads in milliseconds (default 30,000ms).')
    .volatile(),
  maxRedirects: z
    .number()
    .default(FETCH_FILE_DEFAULTS.maxRedirects)
    .description('Maximum redirect hops to follow (default 5).')
    .volatile(),
  allowPrivateHosts: z
    .boolean()
    .default(FETCH_FILE_DEFAULTS.allowPrivateHosts)
    .description('Whether loopback and RFC1918 private IP addresses can be fetched by curl.')
    .volatile(),
  cookieJar: z
    .boolean()
    .default(FETCH_FILE_DEFAULTS.cookieJar)
    .description('Whether to maintain a per-session cookie jar across fetches.')
    .volatile(),
})

export function apply(ctx, config = {}) {
  const plainCfg = {}
  for (const [k, v] of Object.entries(config)) {
    plainCfg[k] = v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v
  }
  const settings = validateFetchFileCfg({
    ...FETCH_FILE_DEFAULTS,
    ...plainCfg,
  })

  const unregister = registerFetchFileTool(ctx, settings, fetchFileToolState)

  return () => {
    fetchFileToolState.registered = false
    if (typeof unregister === 'function') {
      try {
        unregister()
      } catch {
        /* best-effort unregister */
      }
    }
  }
}

export default { name, inject, apply, Config }
