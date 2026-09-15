/**
 * dsh-repeat-tool-breaker v2 test suite.
 *
 * Run with `npm test` (node --test). The T-numbers match the v2 spec's table;
 * T12+ cover the plugin wiring and the fail-loud configuration contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, mergeDefaults, validateCfg } from '../lib/defaults.js'
import {
  canonical,
  extractSink,
  extractUrls,
  firstPathArg,
  firstVerb,
  normUrl,
  omitIgnored,
  stripVolatileFlags,
  tokenize,
} from '../lib/normalize.js'
import { exactFingerprint, fingerprints, isGenericSink, isTracked, limitFor } from '../lib/fingerprints.js'
import { createTracker, hasUserMessage } from '../lib/window.js'
import { denyMessage, renderResult } from '../lib/message.js'
import { apply, name as PLUGIN_NAME } from '../index.js'

const cfg = validateCfg(mergeDefaults({}))
const A = { id: 'agent-A' }
const B = { id: 'agent-B' }

/** A bash call carrying the decoy fields the spec's loop was built on. */
const bash = (command, extra = {}, agent = A) => ({
  name: 'bash',
  arguments: {
    command,
    description: extra.description ?? 'fetch data',
    timeoutMs: extra.timeoutMs ?? 60000,
  },
  agent,
})

/** Mirror of the guard's decision step: predict, then commit. */
function run(tracker, exec, config = cfg) {
  const fps = fingerprints(exec, config)
  const hits = tracker.wouldExceed(exec.agent, fps)
  tracker.commit(exec.agent, fps, hits)
  return { hits, fps }
}

const hit = (hits, prefix) => hits.some((entry) => entry.fp.startsWith(prefix))

// ---------------------------------------------------------------------------
// T1 — host ping-pong with a churning --max-time, same output file
// ---------------------------------------------------------------------------

test('T1: curl ping-pong between alias hosts is caught by net/sink, not by exact', () => {
  const tracker = createTracker(cfg)
  const first = bash('curl -s https://open-data.canada.ca/x --max-time 60 -o /workspace/od.bin', {
    description: '1st',
  })
  const second = bash('curl -s https://open.canada.ca/x --max-time 30 -o /workspace/od.bin', {
    description: '2nd',
  })

  const r1 = run(tracker, first)
  assert.deepEqual(r1.hits, [], 'the first call must always be allowed')
  assert.notEqual(exactFingerprint(first, cfg), exactFingerprint(second, cfg), 'exact must NOT match: this is the v1 blind spot')

  const r2 = run(tracker, second)
  assert.ok(hit(r2.hits, 'net:'), `expected a net: hit, got ${JSON.stringify(r2.hits)}`)
  assert.ok(hit(r2.hits, 'sink:'), 'expected a sink: hit')

  for (const call of [first, second]) {
    const r = run(tracker, call)
    assert.ok(r.hits.length > 0, 'the 3rd and 4th calls must be denied')
  }
})

test('T1b: the alias fold is what makes net: collide', () => {
  assert.equal(normUrl('open-data.canada.ca/x', cfg.hostAliases).href, 'open.canada.ca/x')
  assert.equal(normUrl('https://open.canada.ca/x/', cfg.hostAliases).href, 'open.canada.ca/x')
  assert.equal(normUrl('www.open-data.canada.ca/x', cfg.hostAliases).site, 'canada.ca')
})

// ---------------------------------------------------------------------------
// T2 / T3 — the description decoy
// ---------------------------------------------------------------------------

const SAME_COMMAND = 'curl -s https://example.com/data.json -o /workspace/d.json'

test('T2: description 1st/2nd/3rd plus a churning timeoutMs cannot launder a repeat', () => {
  const tracker = createTracker(cfg)
  const calls = [
    bash(SAME_COMMAND, { description: '1st', timeoutMs: 60000 }),
    bash(SAME_COMMAND, { description: '2nd', timeoutMs: 1000 }),
    bash(SAME_COMMAND, { description: '3rd', timeoutMs: 999999 }),
  ]
  const r0 = run(tracker, calls[0])
  assert.deepEqual(r0.hits, [])
  for (const fps of r0.fps) {
    assert.ok(!/1st|2nd|3rd/.test(fps), `fingerprint leaked a decoy: ${fps}`)
    assert.ok(!/60000|999999/.test(fps), `fingerprint leaked timeoutMs: ${fps}`)
  }
  const r1 = run(tracker, calls[1])
  assert.ok(r1.hits.length > 0, 'the 2nd call must be denied')
  const r2 = run(tracker, calls[2])
  assert.ok(r2.hits.length > 0, 'the 3rd call must be denied')
})

test('T3: exact fingerprints are byte-identical when only description/timeoutMs differ', () => {
  const a = bash(SAME_COMMAND, { description: '1st', timeoutMs: 60000 })
  const b = bash(SAME_COMMAND, { description: '2nd', timeoutMs: 1000 })
  assert.equal(exactFingerprint(a, cfg), exactFingerprint(b, cfg))
})

// ---------------------------------------------------------------------------
// T4 — genuinely different actions must never be blocked
// ---------------------------------------------------------------------------

test('T4: two unrelated actions are both allowed', () => {
  const tracker = createTracker(cfg)
  const r1 = run(tracker, bash('ls /workspace', { description: '1st' }))
  const r2 = run(tracker, bash('curl -s https://other.example.org/g -o /workspace/g.bin', { description: '2nd' }))
  assert.deepEqual(r1.hits, [])
  assert.deepEqual(r2.hits, [])
})

test('T4b: read then write on the SAME path is an edit, not a loop', () => {
  const tracker = createTracker(cfg)
  const read = { name: 'read', arguments: { file_path: '/w/app.ts' }, agent: A }
  const write = { name: 'write', arguments: { file_path: '/w/app.ts', content: 'x' }, agent: A }
  const edit = { name: 'edit', arguments: { file_path: '/w/app.ts', old_string: 'x', new_string: 'y' }, agent: A }
  assert.deepEqual(run(tracker, read).hits, [])
  assert.deepEqual(run(tracker, write).hits, [])
  assert.deepEqual(run(tracker, edit).hits, [])
})

test('T4c: iterating on one file is never blocked (writepath is disabled by default)', () => {
  const tracker = createTracker(cfg)
  // The reference deployment hit a writepath cap of 3 on the third consecutive
  // edit of a single document (a SKILL.md) minutes after installing 0.2.0.
  // EDITING the same file repeatedly with NEW content is ordinary work; only a
  // byte-identical rewrite is a loop, and `exact:` already covers that.
  for (let i = 0; i < 8; i += 1) {
    const step = {
      name: 'edit',
      arguments: { file_path: '/w/skill.md', old_string: `a${i}`, new_string: `b${i}` },
      agent: A,
    }
    assert.deepEqual(run(tracker, step).hits, [], `edit #${i + 1} must be allowed`)
  }
  const again = {
    name: 'edit',
    arguments: { file_path: '/w/skill.md', old_string: 'a3', new_string: 'b3' },
    agent: A,
  }
  assert.ok(run(tracker, again).hits.length > 0, 'a byte-identical re-edit is still caught by exact:')
})

// ---------------------------------------------------------------------------
// T5 / T8 — transport-level equivalence
// ---------------------------------------------------------------------------

test('T5: curl and wget fetching the same URL into the same file collide', () => {
  const tracker = createTracker(cfg)
  const r1 = run(tracker, bash('curl -s https://x.example.com/f --max-time 20 -o out.bin'))
  assert.deepEqual(r1.hits, [])
  const r2 = run(tracker, bash('wget -O out.bin https://x.example.com/f'))
  assert.ok(hit(r2.hits, 'net:'), `expected net: hit, got ${JSON.stringify(r2.hits)}`)
  assert.ok(hit(r2.hits, 'sink:'), 'expected sink: hit')
  assert.ok(r2.fps.includes('family:http-fetch'), 'wget must join the http-fetch family')
})

test('T8: volatile flags do not change the cmd: fingerprint', () => {
  const a = fingerprints(bash('curl -sS --max-time 60 --retry 3 https://a.example.com/x -o f'), cfg)
  const b = fingerprints(bash('curl --max-time 30 --retry 0 https://a.example.com/x -o f'), cfg)
  const cmds = (list) => list.filter((fp) => fp.startsWith('cmd:'))
  assert.equal(cmds(a).length, 1)
  assert.deepEqual(cmds(a), cmds(b))
})

test('T8b: stripping does not touch the payload identity', () => {
  assert.equal(stripVolatileFlags('timeout 30 curl -s -o out.bin https://a.com/x'), 'curl -o out.bin https://a.com/x')
  assert.equal(firstVerb('FOO=1 sudo timeout 5 /usr/bin/curl https://a.com'), 'curl')
})

// ---------------------------------------------------------------------------
// T6 / T7 — scoping
// ---------------------------------------------------------------------------

test('T6: excluded tools are transparent', () => {
  assert.equal(isTracked('todo_write', cfg), false)
  assert.equal(isTracked('bash', cfg), true)
  assert.equal(isTracked('bash', mergeDefaults({ include: ['read*'] })), false)
  assert.equal(isTracked('read_file', mergeDefaults({ include: ['read*'] })), true)
})

test('T6b: an excluded tool never enters the window', () => {
  const tracker = createTracker(cfg)
  for (let i = 0; i < 10; i += 1) {
    const exec = { name: 'todo_write', arguments: { todos: [] }, agent: A }
    const fps = fingerprints(exec, cfg)
    assert.equal(isTracked(exec.name, cfg), false, 'the caller (guard) must skip it before this point')
    void fps
  }
  assert.deepEqual(tracker.slot(A).calls, [])
})

test('T7: agents have independent budgets', () => {
  const tracker = createTracker(cfg)
  const a = bash(SAME_COMMAND, {}, A)
  const b = bash(SAME_COMMAND, {}, B)
  assert.deepEqual(run(tracker, a).hits, [])
  assert.ok(run(tracker, a).hits.length > 0, 'A is saturated')
  assert.deepEqual(run(tracker, b).hits, [], 'B is untouched by A')
})

// ---------------------------------------------------------------------------
// T9 — normalization units
// ---------------------------------------------------------------------------

test('T9: omitIgnored removes the decoys and nothing else', () => {
  const cleaned = omitIgnored('bash', { command: 'ls', description: '1st', timeoutMs: 60 }, cfg.ignoreArgs)
  assert.deepEqual(cleaned, { command: 'ls' })
  assert.equal(canonical(cleaned), '{"command":"ls"}')
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}')
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(canonical(cyclic), '{"self":"[cycle]"}')
})

test('T9b: normUrl folds spelling without inventing identity', () => {
  const plain = normUrl('https://Example.COM:443/a/b/?q=1#frag', cfg.hostAliases)
  assert.deepEqual(plain, { host: 'example.com', path: '/a/b', site: 'example.com', href: 'example.com/a/b' })
  assert.equal(normUrl('https://example.com', cfg.hostAliases).path, '/')
  assert.equal(normUrl('192.168.111.90/a', {}).site, '192.168.111.90', 'IP literals must not collapse to "111.90"')
  assert.equal(normUrl('10.1.111.90/a', {}).site, '10.1.111.90')
  assert.equal(normUrl('not a url', {}), null)
})

test('T9c: extractSink understands the three shapes and ignores 2>', () => {
  assert.equal(extractSink('curl -s https://a.com/x -o out.bin'), 'out.bin')
  assert.equal(extractSink('curl -s https://a.com/x > /tmp/out.bin'), '/tmp/out.bin')
  assert.equal(extractSink('curl -s https://a.com/x >>/tmp/out.bin'), '/tmp/out.bin')
  assert.equal(extractSink('curl -s https://a.com/x 2>/dev/null > out.bin'), 'out.bin')
  assert.equal(extractSink('curl -s https://a.com/x | tee -a ./out.bin'), 'out.bin')
  assert.equal(extractSink('curl -O https://a.com/file.bin'), null, "curl's -O takes no value")
  assert.equal(extractSink('wget -O file.bin https://a.com/x'), 'file.bin')
  assert.equal(extractSink('ls -la'), null)
})

test('T9d: extractUrls trims sentence punctuation and dedupes', () => {
  assert.deepEqual(extractUrls('see https://a.com/x, and https://a.com/x again'), ['https://a.com/x'])
  assert.deepEqual(extractUrls('curl "https://a.com/x?y=1" -o f'), ['https://a.com/x?y=1'])
  assert.deepEqual(extractUrls('ls'), [])
})

test('T9e: tokenize honours quotes and escapes', () => {
  assert.deepEqual(tokenize(`curl -H 'Accept: a b' "https://x/y" -o 'out.bin'`), [
    'curl', '-H', 'Accept: a b', 'https://x/y', '-o', 'out.bin',
  ])
})

test('T9f: firstPathArg and limitFor', () => {
  assert.equal(firstPathArg({ file_path: '/a', path: '/b' }, ['path', 'file_path']), '/b')
  assert.equal(firstPathArg({}, cfg.pathAliases), null)
  assert.equal(limitFor('net:a/b', cfg.limits), 2)
  assert.equal(limitFor('site:canada.ca', cfg.limits), 3)
  assert.equal(limitFor('family:http-fetch', cfg.limits), 6)
  assert.equal(limitFor('verb:ls', cfg.limits), Number.POSITIVE_INFINITY)
})

// ---------------------------------------------------------------------------
// T10 / T11 — read paths and deny bookkeeping
// ---------------------------------------------------------------------------

test('T10: reading the same file twice is denied', () => {
  const tracker = createTracker(cfg)
  const read = (extra = {}) => ({ name: 'read', arguments: { file_path: '/w/README.md', ...extra }, agent: A })
  assert.deepEqual(run(tracker, read()).hits, [])
  const second = run(tracker, read({ offset: 0 }))
  assert.ok(hit(second.hits, 'readpath:'), `expected readpath: hit, got ${JSON.stringify(second.hits)}`)
})

test('T11: a denied call still consumes its budget (hammering stays blocked)', () => {
  const tracker = createTracker(cfg)
  const call = bash('curl -s https://blocked.example.com/x -o f')
  assert.deepEqual(run(tracker, call).hits, [])
  assert.ok(run(tracker, call).hits.length > 0, '2nd denied')
  // "Parallel" duplicates in the same step all see the deny path's commit.
  assert.ok(run(tracker, call).hits.length > 0)
  assert.ok(run(tracker, call).hits.length > 0)
})

test('T11b: a denied call does NOT spend budget for resources it never touched', () => {
  const tracker = createTracker(cfg)
  // Two calls into the same output file: the 2nd is denied on sink:, and its own
  // (never-fetched) URL must not be charged to net:.
  run(tracker, bash('curl -s https://a.example.com/1 -o /tmp/shared.bin'))
  const denied = run(tracker, bash('curl -s https://b.example.com/2 -o /tmp/shared.bin'))
  assert.ok(hit(denied.hits, 'sink:'), 'denied on the shared sink')
  assert.deepEqual(
    tracker.wouldExceed(A, ['net:b.example.com/2']),
    [],
    'the URL of a call that never ran must still be fetchable another way',
  )
  assert.ok(
    tracker.wouldExceed(A, ['sink:/tmp/shared.bin']).length > 0,
    'the fingerprint that actually hit stays at its cap',
  )
})

test('T15: a generic sink is not an action identity', () => {
  assert.equal(isGenericSink('/dev/null'), true)
  assert.equal(isGenericSink('-'), true)
  assert.equal(isGenericSink('/tmp/out.bin'), false)
  // Four DIFFERENT urls, all writing to /dev/null, must all be allowed: this is
  // the exact shape that a live run broke on.
  const tracker = createTracker(cfg)
  for (const host of ['example.com', 'example.org', 'iana.org', 'rfc-editor.org']) {
    const r = run(tracker, bash(`curl -s -o /dev/null -w "%{http_code}" https://${host}/`))
    assert.deepEqual(r.hits, [], `${host} must be allowed`)
    assert.ok(!r.fps.includes('sink:/dev/null'))
  }
})

// ---------------------------------------------------------------------------
// T12 — the plugin wiring itself
// ---------------------------------------------------------------------------

/** A minimal cordis-shaped context capturing the guard and the listeners. */
function fakeCtx() {
  const guards = []
  const handlers = new Map()
  const ctx = {
    tools: { guard: (fn) => { guards.push(fn); return () => {} } },
    on: (event, fn) => { handlers.set(event, fn); return () => {} },
  }
  return { ctx, guards, handlers }
}

test('T12: apply() wires a synchronous guard that denies a repeat with a usable message', async () => {
  assert.equal(PLUGIN_NAME, 'repeat-tool-breaker')
  const { ctx, guards, handlers } = fakeCtx()
  const dispose = apply(ctx, {})
  assert.equal(guards.length, 1)

  const call = bash(SAME_COMMAND, { description: '1st' })
  const first = guards[0](call)
  assert.equal(first, undefined, 'the value returned from a guard must be undefined to allow')

  const denied = guards[0](bash(SAME_COMMAND, { description: '2nd' }))
  assert.equal(typeof denied, 'string')
  assert.match(denied, /^REPEAT_TOOL_BLOCKED:/)
  assert.ok(!denied.includes('<tool_call>') && !denied.includes('<function='), 'denial must not look like markup')
  // The boilerplate names "1st"/"2nd" as EXAMPLES of decoration; the Hits block
  // must never quote the actual decoy value that was passed in.
  const hitsBlock = denied.split('Hits:')[1].split('Changing description')[0]
  assert.ok(!hitsBlock.includes('1st'), `the hits must not echo the decoy description: ${hitsBlock}`)

  // post-execute records the settled result, and does not count.
  const post = handlers.get('tools/post-execute')
  await post(
    { name: 'bash', arguments: { command: 'ls' }, agent: A },
    { isError: false, content: [{ type: 'text', text: 'PREVIOUS RESULT BODY' }] },
    async () => ({ kind: 'accept' }),
  )
  const withResult = guards[0](bash('curl -s https://example.com/data.json -o /workspace/d.json', { description: '3rd' }))
  assert.equal(typeof withResult, 'string')
  assert.ok(withResult.includes('PREVIOUS RESULT BODY'), 'the denial must quote the previous result')

  assert.equal(typeof dispose, 'function')
  dispose()
})

test('T12b: a human turn clears the window, a plugin notice does not', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  const dispose = apply(ctx, {})
  const call = bash(SAME_COMMAND)
  guards[0](call)
  assert.equal(typeof guards[0](call), 'string')

  const preStep = handlers.get('agent/pre-step')
  const noop = () => undefined
  await preStep({ agent: A, messages: [{ source: { kind: 'plugin', plugin: 'repeat-tool-breaker' } }] }, noop)
  assert.equal(typeof guards[0](call), 'string', 'a plugin notice must NOT reset the budget')

  await preStep({ agent: A, messages: [{ source: { kind: 'user' } }] }, noop)
  assert.equal(guards[0](call), undefined, 'a real user turn must reset the budget')
  dispose()
})

test('T12c: apply() refuses the arguments of the removed v1 configuration', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { denyAfter: 3 }), /removed in 0\.2\.0/)
  assert.throws(() => apply(ctx, { window: 3 }), /window/)
  assert.throws(() => apply(ctx, { limits: { net: 1 } }), /must be a finite number >= 2/)
  assert.equal(typeof apply(ctx, { limits: { net: null } }), 'function', 'null is the documented "disable this cap"')
})

// ---------------------------------------------------------------------------
// T13 — message rendering
// ---------------------------------------------------------------------------

test('T13: denyMessage lists hits with counts and the last result', () => {
  const text = denyMessage({
    name: 'bash',
    hits: [{ fp: 'net:open.canada.ca/x', next: 2, cap: 2 }],
    lastResult: 'FILE CONTENTS',
    cfg,
  })
  assert.match(text, /- net:open\.canada\.ca\/x 2\/2/)
  assert.match(text, /FILE CONTENTS/)
  assert.match(text, /open-data\.canada\.ca vs open\.canada\.ca/)
})

test('T13b: renderResult concatenates text blocks only', () => {
  assert.equal(renderResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(renderResult({}), '')
  assert.equal(renderResult(undefined), '')
})

test('T13c: hasUserMessage only trusts the human source', () => {
  assert.equal(hasUserMessage([{ source: { kind: 'user' } }]), true)
  assert.equal(hasUserMessage([{ source: { kind: 'plugin' } }, { source: { kind: 'model' } }]), false)
  assert.equal(hasUserMessage([]), false)
  assert.equal(hasUserMessage(undefined), false)
})

// ---------------------------------------------------------------------------
// T14 — documented shape of the shipped defaults
// ---------------------------------------------------------------------------

test('T14: shipped defaults are the v2 table', () => {
  assert.equal(DEFAULTS.window, 12)
  assert.deepEqual(DEFAULTS.limits, {
    exact: 2,
    cmd: 2,
    net: 2,
    sink: 2,
    readpath: 2,
    writepath: null,
    site: 3,
    'family:http-fetch': 6,
    'verb:curl': 6,
    'verb:wget': 6,
  })
  assert.deepEqual(DEFAULTS.exclude, ['todo_write'])
  assert.ok(DEFAULTS.pathAliases.includes('file_path'), "dsh's own file tools use file_path")
})

test('T14b: DOCUMENTED BEHAVIOR — the volume cap on http fetching is a backstop, not a 4-call wall', () => {
  const tracker = createTracker(cfg)
  // Six DIFFERENT urls in the window: a real research batch must survive.
  const hosts = ['a.example.com', 'b.example.net', 'c.example.org', 'd.example.io', 'e.example.co']
  for (const host of hosts) {
    assert.deepEqual(
      run(tracker, bash(`curl -s -o /dev/null https://${host}/p`)).hits,
      [],
      `${host} must be allowed (this is the case a live run broke on)`,
    )
  }
  const sixth = run(tracker, bash('curl -s -o /dev/null https://f.example.dev/p'))
  assert.ok(hit(sixth.hits, 'family:http-fetch'), 'family:http-fetch stops a runaway crawl at 6 per window')
})
