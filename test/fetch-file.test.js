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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      web: fakeWeb({ statusCode: 200, body, kind: 'html' }),
      ctx: fakeCtx(),
      settings: { ...FETCH_FILE_DEFAULTS, outputDir: dir },
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
      web: fakeWeb({ statusCode: 404, body: 'not found', kind: 'html' }),
      ctx: fakeCtx(),
      settings: { ...FETCH_FILE_DEFAULTS, outputDir: dir },
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
      web: fakeWeb({ statusCode: 200, body: 'y'.repeat(1000) }),
      ctx: fakeCtx(),
      settings: { ...FETCH_FILE_DEFAULTS, outputDir: dir, maxBytes: 100 },
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
    const settings = { ...FETCH_FILE_DEFAULTS, outputDir: dir }
    const execute = makeFetchFileExecute({ web: fakeWeb({ body: 'x' }), ctx: fakeCtx(), settings })
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
    settings: { ...FETCH_FILE_DEFAULTS, outputDir: '/tmp' },
  })
  await assert.rejects(() => execute({}, {}), /`url` must be a non-empty string/)
  assert.equal(called, false, 'no request for an empty url')
})

test('F11: the tool registers when a web service exists, and stays away when not', () => {
  // A profile WITH the service: `inject` fires and the tool appears.
  const registered = []
  const withWeb = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['web'])
      callback({ web: { fetch: async () => ({}) }, tools: { register: (def) => registered.push(def) } })
      return () => {}
    },
    get: () => undefined,
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

  // A profile WITHOUT the service: nothing registers, and the guard can see that.
  fetchFileToolState.registered = false
  registerFetchFileTool({ inject: () => () => {}, get: () => undefined }, FETCH_FILE_DEFAULTS)
  assert.equal(fetchFileToolState.registered, false)

  // A context with no scoped `inject` at all (a test double) must not throw.
  fetchFileToolState.registered = false
  assert.doesNotThrow(() => registerFetchFileTool({ get: () => undefined }, FETCH_FILE_DEFAULTS))
  assert.equal(fetchFileToolState.registered, false)
})

test('F12: the rendering never contains the body', async () => {
  // The single most important property: a fetch that dumps the document into the
  // conversation is the bug this tool was written to fix.
  const registered = []
  registerFetchFileTool(
    {
      inject: (_deps, cb) => {
        cb({ web: { fetch: async () => ({}) }, tools: { register: (def) => registered.push(def) } })
        return () => {}
      },
      get: () => undefined,
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
  assert.throws(() => validateFetchFileCfg({ outputDir: '', maxBytes: 10 }), /outputDir/)
  assert.throws(() => validateFetchFileCfg({ outputDir: 'x', maxBytes: 0 }), /maxBytes/)
  assert.throws(() => validateFetchFileCfg({ outputDir: 'x', maxBytes: 1.5 }), /maxBytes/)
  assert.doesNotThrow(() => validateFetchFileCfg({ outputDir: 'fetched', maxBytes: 1024 }))
})
