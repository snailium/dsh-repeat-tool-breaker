/**
 * Turning a URL into a file path, safely.
 *
 * `web_fetch_file` exists because putting a fetched document in the model's
 * context is expensive and, for a long page, fatal — a reported run died on
 * context size after fetching weather pages. The body therefore goes to disk and
 * only the PATH travels back. That makes the path the one thing this tool must get
 * right, so the rules live here, with no cordis or filesystem dependency, and are
 * tested on their own.
 *
 * The rules, in order of importance:
 *
 *   1. **Never escape the root.** A URL path can contain `..`, an absolute path, a
 *      NUL byte or a Windows drive letter. Everything is reduced to a single
 *      relative segment chain and then verified with `resolve` that the result is
 *      still inside the root. A tool that writes to an agent-supplied path is a
 *      filesystem-write primitive; it must not become an escape hatch.
 *   2. **Same URL, same file.** The name is derived from the URL, so a model that
 *      fetches twice does not accumulate `report-1.html`, `report-2.html`. It also
 *      means a retry OVERWRITES rather than doubling the disk usage.
 *   3. **Readable.** Host first, then the path, so a directory listing tells the
 *      model where each file came from.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Filename length cap, leaving room for a directory and an extension. */
const MAX_NAME = 120

/** Replace anything that is not safe in a filename with a dash. */
function slug(text) {
  return text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * The extension to give a saved body.
 *
 * The URL's own extension wins when it looks like one — it is what the author
 * published and what the model will expect to `grep`. Otherwise the provider's own
 * classification decides, so an HTML page is not saved without a hint that it is
 * HTML.
 *
 * @param url - the fetched URL.
 * @param kind - `body.kind` from the provider (`html`, `text`, …).
 * @returns an extension including the dot, or an empty string.
 */
export function extensionFor(url, kind) {
  let last = ''
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  } catch {
    last = ''
  }
  const known = /\.([A-Za-z0-9]{1,8})$/.exec(last)
  if (known !== null && /^(?:html?|xhtml|json|txt|md|csv|tsv|xml|rss|atom|js|css|yaml|yml|pdf)$/i.test(known[1])) {
    return `.${known[1].toLowerCase()}`
  }
  if (kind === 'html') return '.html'
  return '.txt'
}

/**
 * Derive a stable, readable filename from a URL.
 *
 * @param url - the fetched URL.
 * @param kind - `body.kind` from the provider.
 * @returns a filename inside the root, never empty, never absolute, never `..`.
 */
export function filenameFor(url, kind) {
  let host = 'unknown-host'
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    path = parsed.pathname
  } catch {
    /* a URL the provider accepted but `new URL` rejects: fall back to the raw text */
    host = 'unknown-host'
    path = url
  }

  const parts = path
    .split('/')
    .map((segment) => slug(segment))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

  const ext = extensionFor(url, kind)
  let head = slug(host) || 'unknown-host'
  // Keep the tail of a long path: the document name matters more than the prefix.
  let tail = parts.join('-')
  if (tail.length + head.length + ext.length + 1 > MAX_NAME) {
    tail = tail.slice(-(MAX_NAME - head.length - ext.length - 2))
  }
  const name = tail.length > 0 ? `${head}-${tail}` : head
  const trimmed = name.slice(0, MAX_NAME - ext.length)
  // Do not append an extension the derived name already carries: the path tail is
  // taken verbatim, so `…/report.csv` would otherwise become `report.csv.csv`.
  return trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? trimmed : `${trimmed}${ext}`
}

/**
 * Resolve the file to write.
 *
 * @param options - `{ root, url, kind, requested }`. `requested` is the model's own
 *   `path` argument, when it gave one.
 * @returns the absolute target path.
 * @throws when the resolved path would land outside `root`.
 */
export function resolveTarget({ root, url, kind, requested }) {
  const base = resolve(root)
  const wanted = typeof requested === 'string' && requested.trim().length > 0
    ? requested.trim()
    : filenameFor(url, kind)
  const target = isAbsolute(wanted) ? resolve(wanted) : resolve(join(base, wanted))
  const inside = target === base || target.startsWith(base + sep)
  if (!inside) {
    throw new Error(
      `web-fetch-file: refusing to write outside the workspace root — "${wanted}" resolves to ${target}, root is ${base}`,
    )
  }
  return target
}

/** The directory a derived name should live in, as a workspace-relative hint. */
export function relativeToRoot(root, target) {
  return relative(resolve(root), target) || '.'
}
