/**
 * Tests for the `web_fetch_file` tool: path safety, and the tool's own contract.
 *
 * These run WITHOUT cordis and without the harness. That is the point of splitting
 * `paths.js` out and of `makeFetchFileExecute` taking the web service as an
 * argument: the rules that matter — where a file may be written, and what the tool
 * returns — are testable on their own, so `npm test` never needs a harness checkout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  FETCH_FILE_DEFAULTS,
  makeFetchFileExecute,
  registerFetchFileTool,
  fetchFileToolState,
  validateFetchFileCfg,
} from '../lib/fetch-file.js'
import { extensionFor, filenameFor, resolveTarget } from '../lib/paths.js'

const ROOT = '/workspace'

// ---------------------------------------------------------------------------
// paths.js — a write primitive must not be an escape hatch
// ---------------------------------------------------------------------------

test('F1: a name is derived from the URL, with a sensible extension', () => {
  assert.equal(filenameFor('https://example.com/', 'html'), 'example.com.html')
  assert.equal(filenameFor('https://example.com/a/b.json', 'text'), 'example.com-a-b.json')
  // The URL's own extension wins when it looks like one: it is what the model
  // will expect to grep.
  assert.equal(extensionFor('https://x.example.com/feed.xml', 'html'), '.xml')
  // Otherwise the provider's classification decides, so HTML is not saved bare.
  assert.equal(extensionFor('https://x.example.com/api/items', 'html'), '.html')
  assert.equal(extensionFor('https://x.example.com/api/items', 'text'), '.txt')
})

test('F2: the same URL always derives the same name', () => {
  // Fetching twice must OVERWRITE, not accumulate report-1.html, report-2.html.
  const a = filenameFor('https://weather.gc.ca/data/2026/11/report.csv', 'text')
  const b = filenameFor('https://weather.gc.ca/data/2026/11/report.csv', 'text')
  assert.equal(a, b)
  assert.equal(a, 'weather.gc.ca-data-2026-11-report.csv')
})

test('F3: a long path keeps its tail, where the document name lives', () => {
  const url = `https://example.com/${'segment/'.repeat(30)}the-document.json`
  const name = filenameFor(url, 'text')
  assert.ok(name.length <= 120, `name too long: ${name.length}`)
  assert.ok(name.endsWith('.json'))
  assert.ok(name.includes('the-document'), 'the tail must survive the trim')
})

test('F4: a hostile URL cannot escape the root', () => {
  for (const hostile of [
    '../../etc/passwd',
    '/etc/passwd',
    'a/../../../../etc/shadow',
    './../../outside.txt',
  ]) {
    assert.throws(
      () => resolveTarget({ root: ROOT, url: 'https://x.example.com/', kind: 'text', requested: hostile }),
      /refusing to write outside the workspace root/,
      `"${hostile}" must be rejected`,
    )
  }
  // A traversal INSIDE the root is fine — that is just a subdirectory.
  assert.equal(
    resolveTarget({ root: ROOT, url: 'https://x/', kind: 'text', requested: 'a/b/c.html' }),
    resolve(ROOT, 'a/b/c.html'),
  )
})

test('F5: a derived name never contains a traversal either', () => {
  // The URL path is the other way a `..` could arrive, so it is stripped rather
  // than trusted.
  const name = filenameFor('https://x.example.com/a/../../../etc/passwd', 'text')
  assert.ok(!name.includes('..'), `derived name contains a traversal: ${name}`)
  assert.ok(!name.startsWith('/'), `derived name is absolute: ${name}`)
  assert.equal(resolveTarget({ root: ROOT, url: 'https://x/', kind: 'text', requested: name }).startsWith(ROOT), true)
})

// ---------------------------------------------------------------------------
// the tool's own contract
// ---------------------------------------------------------------------------

/** A fake `ctx.web` that answers with a chosen status and body. */
function fakeWeb({ statusCode = 200, body = 'hello', kind = 'text', truncated = false, impl } = {}) {
  return {
    fetch: impl ?? (async () => ({ url: 'https://example.com/', statusCode, body: { kind, content: body }, truncated })),
  }
}

/** A fake cordis context: only `get('sandboxPolicy')` is consulted. */
const fakeCtx = () => ({ get: () => undefined })

test('F6: the body goes to a file, and only the path comes back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    const body = `<html><body>${'x'.repeat(500)}</body></html>`
    const execute = makeFetchFileExecute({
      ctx: fakeCtx(),
      resolveWeb: () => fakeWeb({ statusCode: 200, body, kind: 'html' }),
      settings: { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false, outputDir: dir },
    })
    const value = await execute({ url: 'https://example.com/page' }, {})

    assert.equal(value.statusCode, 200)
    assert.equal(value.bytes, Buffer.byteLength(body))
    assert.equal(await readFile(value.path, 'utf8'), body)
    assert.ok(value.path.startsWith(dir), 'written under the configured directory')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F7: a 404 is a FACT in the returned value, not a guess', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    const execute = makeFetchFileExecute({
      ctx: fakeCtx(),
      resolveWeb: () => fakeWeb({ statusCode: 404, body: 'not found', kind: 'html' }),
      settings: { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false, outputDir: dir },
    })
    const value = await execute({ url: 'https://example.com/gone' }, {})
    // The whole reason the tool exists: the status is the tool's own structured
    // output, so nothing has to be inferred from shell text later.
    assert.equal(value.statusCode, 404)
    assert.equal(existsSync(value.path), true, 'the error body is still saved')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F8: an over-large body is clipped and reported as truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    const execute = makeFetchFileExecute({
      ctx: fakeCtx(),
      resolveWeb: () => fakeWeb({ statusCode: 200, body: 'y'.repeat(1000) }),
      settings: { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false, outputDir: dir, maxBytes: 100 },
    })
    const value = await execute({ url: 'https://example.com/big' }, {})
    assert.equal(value.bytes, 100)
    assert.equal(value.truncated, true)
    assert.equal((await readFile(value.path, 'utf8')).length, 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F9: the model-chosen path is honoured, and still confined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    const settings = { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false, outputDir: dir }
    const execute = makeFetchFileExecute({ ctx: fakeCtx(), settings, resolveWeb: () => fakeWeb({ body: 'x' }) })
    const value = await execute({ url: 'https://example.com/', path: 'nested/here.txt' }, {})
    assert.ok(value.path.endsWith('nested/here.txt'), value.path)
    await assert.rejects(
      () => execute({ url: 'https://example.com/', path: '../../escape.txt' }, {}),
      /refusing to write outside/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F10: a missing url is rejected before any request', async () => {
  let called = false
  const execute = makeFetchFileExecute({
    web: fakeWeb({ impl: async () => { called = true; return {} } }),
    ctx: fakeCtx(),
    settings: { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false, outputDir: '/tmp' },
  })
  await assert.rejects(() => execute({}, {}), /`url` must be a non-empty string/)
  assert.equal(called, false, 'no request for an empty url')
})

test('F11: the tool registers when a web service exists, and stays away when not', () => {
  // Registration does NOT wait for `ctx.web` any more. The curl backend needs no such service,
  // and the guard only blocks shell HTTP while this tool is registered — so registering late
  // would strand a profile whose whole point is to fetch with curl.
  const registered = []
  const withWeb = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['web'])
      callback({ web: { fetch: async () => ({}) } })
      return () => {}
    },
    get: () => undefined,
    tools: { register: (def) => registered.push(def) },
  }
  fetchFileToolState.registered = false
  registerFetchFileTool(withWeb, FETCH_FILE_DEFAULTS)
  assert.equal(fetchFileToolState.registered, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'web_fetch_file')
  // The registration must carry plain JSON Schema, which is what `register`
  // validates — this is the shape `defineTool` would have produced.
  assert.equal(registered[0].parameters.type, 'object')
  assert.deepEqual(registered[0].parameters.required, ['url'])
  assert.equal(registered[0].output.schema.additionalProperties, false)
  assert.equal(typeof registered[0].output.render, 'function')

  // A context with no scoped `inject` at all (a test double) still gets the TOOL registered, and
  // with curl as the DEFAULT it is also CAPABILITY: no web service is needed, so the guard may
  // block shell HTTP and point at it.
  const bare = []
  fetchFileToolState.registered = false
  assert.doesNotThrow(() =>
    registerFetchFileTool({ get: () => undefined, tools: { register: (def) => bare.push(def) } }, FETCH_FILE_DEFAULTS),
  )
  assert.equal(bare.length, 1)
  assert.equal(fetchFileToolState.registered, true, 'the curl default needs no web service')

  // …and ONLY the curl backend gives capability without a service. With `fetchWithCurl: false`
  // and no web service there is a tool that cannot fetch, so the flag stays false — capability,
  // not existence. That is the fail-safe the guard reads.
  const seamOnly = []
  fetchFileToolState.registered = false
  registerFetchFileTool(
    { get: () => undefined, tools: { register: (def) => seamOnly.push(def) } },
    { ...FETCH_FILE_DEFAULTS, fetchWithCurl: false },
  )
  assert.equal(seamOnly.length, 1, 'the definition is still registered, it just cannot fetch yet')
  assert.equal(fetchFileToolState.registered, false, 'no web service and no curl is NOT capability')

  // A context with NO tool registry registers nothing, and the guard can see that. That is the
  // fail-safe: no replacement tool means the block must not run.
  fetchFileToolState.registered = false
  assert.doesNotThrow(() => registerFetchFileTool({ inject: () => () => {}, get: () => undefined }, FETCH_FILE_DEFAULTS))
  assert.equal(fetchFileToolState.registered, false)
})

test('F12: the rendering never contains the body', async () => {
  // The single most important property: a fetch that dumps the document into the
  // conversation is the bug this tool was written to fix.
  const registered = []
  registerFetchFileTool(
    {
      inject: (_deps, cb) => {
        cb({ web: { fetch: async () => ({}) } })
        return () => {}
      },
      get: () => undefined,
      tools: { register: (def) => registered.push(def) },
    },
    FETCH_FILE_DEFAULTS,
  )
  const secret = 'SECRET-BODY-MARKER'
  const rendered = registered[0].output.render({}, {
    path: '/workspace/fetched/x.html',
    statusCode: 200,
    bytes: secret.length,
    kind: 'html',
    truncated: false,
  })
  const text = rendered.map((block) => block.text).join('\n')
  assert.ok(text.includes('/workspace/fetched/x.html'), 'the path must be there')
  assert.ok(text.includes('200'), 'the status must be there')
  assert.ok(!text.includes(secret), 'the body must NOT be there')
})

test('F13: fetch-file settings are validated fail-loud', () => {
  const base = { ...FETCH_FILE_DEFAULTS }
  assert.throws(() => validateFetchFileCfg({ ...base, outputDir: '' }), /outputDir/)
  assert.throws(() => validateFetchFileCfg({ ...base, maxBytes: 0 }), /maxBytes/)
  assert.throws(() => validateFetchFileCfg({ ...base, maxBytes: 1.5 }), /maxBytes/)
  // The curl backend's own knobs, which the backend will otherwise pass to curl unchecked.
  assert.throws(() => validateFetchFileCfg({ ...base, fetchWithCurl: 'yes' }), /fetchWithCurl/)
  assert.throws(() => validateFetchFileCfg({ ...base, allowPrivateHosts: 'no' }), /allowPrivateHosts/)
  assert.throws(() => validateFetchFileCfg({ ...base, cookieJar: 'no' }), /cookieJar/)
  assert.throws(() => validateFetchFileCfg({ ...base, timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => validateFetchFileCfg({ ...base, maxRedirects: 0 }), /maxRedirects/)
  assert.throws(() => validateFetchFileCfg({ ...base, curlPath: '' }), /curlPath/)
  assert.throws(() => validateFetchFileCfg({ ...base, userAgent: '' }), /userAgent/)
  assert.doesNotThrow(() => validateFetchFileCfg({ ...base, outputDir: 'fetched', maxBytes: 1024 }))
})

// ---------------------------------------------------------------------------
// The settings namespace: the box an operator uses to extend shellHttpBlock
// ---------------------------------------------------------------------------

/**
 * A settings-provider double, shaped like `ctx.settings` in dsh-settings: `register`
 * returns a scope whose `get`/`watch` the plugin uses, and the schema is CALLED to
 * resolve a value — which is the plugin's proof that a real schemastery schema is
 * required rather than a hand-written validator.
 */
function fakeSettingsService({ base }) {
  const watchers = []
  let resolved = null
  return {
    set(next) {
      resolved = next
      for (const cb of watchers) cb()
    },
    registered: null,
    service: {
      register(ns, schema, options) {
        this.__ns = ns
        this.__schema = schema
        resolved = schema(options.base)
        return {
          get: () => resolved,
          watch: (cb) => {
            watchers.push(cb)
            return () => {}
          },
          update: async () => {},
        }
      },
    },
    get resolved() {
      return resolved
    },
  }
}

test('F14: the exported Config IS the settings schema, and every field is volatile', async () => {
  // dsh 0.1.7 removed `ctx.settings.register`: `SettingsForms.schema()` reads the plugin's
  // exported `Config`, and `volatileForm()` keeps only fields marked `volatile()` — an
  // entry with no such field is SKIPPED, so a schema without volatile is a schema with no
  // form at all. Both halves are asserted here because either one silently removes the
  // settings page.
  const { Config } = await import('../index.js')
  const fields = Object.keys(Config.dict ?? {})
  assert.deepEqual(
    [...fields].sort(),
    ['blockLocalHttp', 'blockShellHttp', 'failLimit', 'failWarnAt', 'fetchWithCurl', 'shellHttpBlock', 'summarizeAt', 'warnAt'],
  )
  for (const field of fields) {
    assert.equal(Config.dict[field].meta?.volatile, true, `${field} must be volatile or the form skips it`)
  }

  // The documented off-switches must accept `null` rather than failing the load.
  //
  // Measured, and it contradicts what this test first asserted: `.volatile()` RELAXES type
  // checking at resolve time — a live reference is not a value — so a `null` reaches
  // `apply` even on a plain `z.number()` field, and an assertion that `warnAt: null` throws
  // was simply wrong. The explicit union is kept for the INTENT the rendered form reads,
  // and `plainConfig` normalises an unset nullable field to `null`, so the documented
  // off-switch behaves identically whether it was set explicitly or left to its default.
  assert.doesNotThrow(() => Config({ summarizeAt: null, failLimit: null }))
  assert.doesNotThrow(() => Config({ warnAt: null }))
})

test('F16: the published package still ships its entry point', async () => {
  // A programmatic rewrite of package.json silently dropped `index.js` from `files`,
  // which would have published a package with no entry point at all — broken on
  // install, and invisible until someone installed it. This is the cheapest possible
  // guard against that class of mistake.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // The dsh compatibility range has to be machine-readable, and it has to admit the PRERELEASE
  // builds: semver excludes a prerelease unless a comparator in the same set names one, so
  // `>=0.2.0` would have rejected the 0.2.0-rc.2 this plugin was verified against.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'], '^0.1.7-rc.2 || >=0.2.0-rc.1 <0.2.1-0')
  // dsh comes from the HOST at runtime; a non-optional peer would make npm/pnpm install a
  // second copy of it into the consumer's tree and pin it in their lockfile.
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true)
  for (const entry of ['index.js', 'lib', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `\`files\` must include ${entry} (got ${JSON.stringify(manifest.files)})`)
  }
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['.'].default, './index.js')
  // The bundle patch is how a profile mounts the plugin at all.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('F17: the published package still ships its browser half', async () => {
  // The card is invisible unless BOTH halves of the manifest agree: `dsh.client` is what
  // puts the bundle in the boot graph, and `exports["./client"]` is what the module system
  // resolves it through. Either one alone is a silent no-op — the settings namespace
  // registers, the card never renders, and nothing anywhere reports an error.
  const { readFileSync, existsSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // The dsh compatibility range has to be machine-readable, and it has to admit the PRERELEASE
  // builds: semver excludes a prerelease unless a comparator in the same set names one, so
  // `>=0.2.0` would have rejected the 0.2.0-rc.2 this plugin was verified against.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'], '^0.1.7-rc.2 || >=0.2.0-rc.1 <0.2.1-0')
  // dsh comes from the HOST at runtime; a non-optional peer would make npm/pnpm install a
  // second copy of it into the consumer's tree and pin it in their lockfile.
  assert.equal(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true)

  assert.ok(manifest.dsh.client, '`dsh.client` declares the browser half and must exist')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject), '`dsh.client.inject` must be an array')
  for (const dependency of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
    assert.ok(
      manifest.dsh.client.inject.includes(dependency),
      `the card needs ${dependency} loaded first (got ${JSON.stringify(manifest.dsh.client.inject)})`,
    )
  }

  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  const clientPath = new URL('../lib/client.js', import.meta.url)
  assert.ok(existsSync(clientPath), 'the exported browser half must exist on disk')
  // `lib` is already in `files`; assert it so a future narrowing cannot drop the bundle.
  assert.ok(manifest.files.includes('lib'), '`files` must include lib/ for the browser half')
  const source = readFileSync(clientPath, 'utf8')
  // The loader id must be the package name: the boot graph keys rows by it, so a mismatch
  // leaves the factory registered under an id nothing ever resolves.
  assert.ok(
    source.includes(`id: '${manifest.name}'`),
    `the bundle must register under the package name ${manifest.name}`,
  )
  // react plus the shared settings primitives are the module-table dependencies; every
  // SERVICE arrives by injection. The primitives are what supply the form chrome, so the
  // bundle does not re-implement (and mis-style) the card.
  const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
  assert.deepEqual(
    [...required].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
    'the module table surface must stay at react and the shared form components',
  )
})


// ---------------------------------------------------------------------------
// the curl backend (`fetchWithCurl: true`)
// ---------------------------------------------------------------------------

const hasCurl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0
const skipCurl = hasCurl ? false : 'curl is not installed in this environment'

/** Run one throwaway HTTP server on loopback, and hand the caller its base URL. */
async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** An execute bound to the curl backend, writing into `dir`. */
const curlExecute = (dir, extra = {}) =>
  makeFetchFileExecute({
    ctx: fakeCtx(),
    settings: { ...FETCH_FILE_DEFAULTS, fetchWithCurl: true, outputDir: dir, ...extra },
  })

/** One session's execution context, which is what names the cookie jar. */
const session = (id) => ({ agent: { session: { header: { id } } } })

test('F20: a binary body is saved byte-for-byte, and named from its content type', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    // A real PDF header followed by bytes that are NOT valid UTF-8: the platform backend refuses
    // this outright, which is the whole reason the curl backend exists.
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f])])
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        res.end(body)
      },
      async (base) => {
        const value = await curlExecute(dir)({ url: `${base}/doc` }, session('bin'))
        assert.equal(value.statusCode, 200)
        assert.equal(value.contentType, 'application/pdf')
        assert.equal(value.kind, 'pdf')
        assert.equal(value.bytes, body.length)
        assert.ok(value.path.endsWith('.pdf'), `expected a .pdf name, got ${value.path}`)
        assert.deepEqual(await readFile(value.path), body, 'the bytes must survive unchanged')
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F21: cookies are shared inside one session and not across sessions', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    await withServer(
      (req, res) => {
        if (req.url === '/set') {
          res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'token=abc123; Path=/' })
          res.end('set')
          return
        }
        const carried = /token=abc123/.test(req.headers.cookie ?? '')
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(carried ? 'carried' : 'absent')
      },
      async (base) => {
        const execute = curlExecute(dir)
        const first = await execute({ url: `${base}/set` }, session('sess-a'))
        assert.equal(await readFile(first.path, 'utf8'), 'set')
        // Same session: the jar was written by the first call and is sent by the second.
        const second = await execute({ url: `${base}/check` }, session('sess-a'))
        assert.equal(await readFile(second.path, 'utf8'), 'carried')
        // A different session must not inherit it.
        const other = await execute({ url: `${base}/check` }, session('sess-b'))
        assert.equal(await readFile(other.path, 'utf8'), 'absent')
        // With the jar off, even the same session carries nothing.
        const noJar = curlExecute(dir, { cookieJar: false })
        const third = await noJar({ url: `${base}/check` }, session('sess-a'))
        assert.equal(await readFile(third.path, 'utf8'), 'absent')
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F22: a redirect is followed, and the effective URL is reported', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    await withServer(
      (req, res) => {
        if (req.url === '/from') {
          res.writeHead(302, { location: '/to' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('landed')
      },
      async (base) => {
        const value = await curlExecute(dir)({ url: `${base}/from` }, session('redir'))
        assert.equal(value.statusCode, 200)
        assert.ok(value.finalUrl.endsWith('/to'), `finalUrl should be the redirect target: ${value.finalUrl}`)
        assert.equal(await readFile(value.path, 'utf8'), 'landed')
        // The name comes from the EFFECTIVE url, not the one asked for.
        assert.ok(value.path.includes('-to'), `expected the effective path in the name: ${value.path}`)
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F23: an HTTP error is a STATUS, and the body is still saved', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    await withServer(
      (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/html' })
        res.end('<html><body>not found</body></html>')
      },
      async (base) => {
        const value = await curlExecute(dir)({ url: `${base}/missing` }, session('404'))
        assert.equal(value.statusCode, 404, 'a 404 is a fact in the value, not an exception')
        assert.equal(value.kind, 'html')
        assert.ok((await readFile(value.path, 'utf8')).includes('not found'))
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F24: a refused transfer leaves no half file behind', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.alloc(4096, 7))
      },
      async (base) => {
        const execute = curlExecute(dir, { maxBytes: 1024 })
        await assert.rejects(() => execute({ url: `${base}/big` }, session('big')), /maxBytes|curl exited 63/)
        const left = await readdir(dir)
        assert.deepEqual(left, [], `a failed download must leave nothing: ${left.join(', ')}`)
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F25: a non-http scheme and a private host are both refused before curl runs', { skip: skipCurl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  try {
    const execute = curlExecute(dir)
    // `file:` is the reason the scheme is checked at all: curl speaks it, and a fetch tool that
    // can read local files is a filesystem-read primitive.
    await assert.rejects(() => execute({ url: 'file:///etc/passwd' }, session('scheme')), /only http and https/)
    // The private-host policy is opt-out, and it refuses loopback too.
    const strict = curlExecute(dir, { allowPrivateHosts: false })
    await assert.rejects(
      () => strict({ url: 'http://127.0.0.1:9/x' }, session('strict')),
      /local address|private address/,
    )
    assert.deepEqual(await readdir(dir), [], 'nothing may be written for a refused target')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
