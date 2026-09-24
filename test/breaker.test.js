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
  firstVerb,
  isLocalHost,
  normUrl,
  omitIgnored,
  stripVolatileFlags,
  tokenize,
} from '../lib/normalize.js'
import {
  blockingHits,
  exactFingerprint,
  fingerprints,
  isGenericSink,
  isTracked,
  limitFor,
} from '../lib/fingerprints.js'
import { classifyFailure, describeFailure } from '../lib/failure.js'
import {
  FETCH_FILE_DEFAULTS,
  fetchFileToolState,
  registerFetchFileTool,
} from '../lib/fetch-file.js'
import { createTracker, hasUserMessage } from '../lib/window.js'
import { askMessage, denyMessage, renderResult, summarizeMessage, warnMessage } from '../lib/message.js'
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
  const { fps, local } = fingerprints(exec, config)
  const hits = tracker.wouldExceed(exec.agent, fps)
  tracker.commit(exec.agent, fps, hits)
  return { hits, fps, local }
}

const hit = (hits, prefix) => hits.some((entry) => entry.fp.startsWith(prefix))

/**
 * The cap the shipped defaults apply to action identity (`exact`/`cmd`/`net`/
 * `sink`). Assertions are written in terms of it — "the cap-th identical call is
 * denied, the earlier ones are allowed" — so retuning the cap does not require
 * rewriting every test.
 */
const CAP = cfg.limits.exact
/** The two advisory stages, likewise read from the shipped defaults. */
const WARN = cfg.warnAt
const SUMMARIZE = cfg.summarizeAt
/** `host:` is deliberately looser than action identity; see docs/issue-b-thresholds.md. */
const HOST_CAP = cfg.limits.host

/** Run one call until it is denied; returns that deny result and how long it took. */
function runUntilDenied(tracker, exec, max = CAP + 2) {
  let last
  for (let i = 0; i < max; i += 1) {
    last = run(tracker, exec)
    if (last.hits.length > 0) return { ...last, attempts: i + 1 }
  }
  return { ...last, attempts: max }
}

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

  assert.notEqual(exactFingerprint(first, cfg), exactFingerprint(second, cfg), 'exact must NOT match: this is the v1 blind spot')

  // The two spellings alternate, so no two consecutive calls share their
  // arguments: v1's consecutive-identical counter saw a new action every round.
  // v2 counts one net: and one sink: per fetch of the same resource, so the
  // cap-th round trip is denied however the host is spelled.
  const alternation = [first, second]
  let last
  for (let i = 0; i < CAP; i += 1) {
    last = run(tracker, alternation[i % 2])
    if (i < CAP - 1) assert.deepEqual(last.hits, [], `round ${i + 1} must still be allowed`)
  }
  assert.ok(hit(last.hits, 'net:'), `expected a net: hit on round ${CAP}, got ${JSON.stringify(last.hits)}`)
  assert.ok(hit(last.hits, 'sink:'), 'expected a sink: hit')
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
  const decoys = ['1st', '2nd', '3rd', '4th', '5th']
  const call = (i) => bash(SAME_COMMAND, { description: decoys[i], timeoutMs: 1000 * (i + 1) + 59999 })
  let last
  for (let i = 0; i < CAP; i += 1) {
    last = run(tracker, call(i))
    if (i === 0) {
      for (const fps of last.fps) {
        assert.ok(!/1st|2nd|3rd|4th|5th/.test(fps), `fingerprint leaked a decoy: ${fps}`)
        assert.ok(!/60000|999999/.test(fps), `fingerprint leaked timeoutMs: ${fps}`)
      }
    }
    if (i < CAP - 1) assert.deepEqual(last.hits, [], `decorated call ${i + 1} must be allowed`)
  }
  assert.ok(last.hits.length > 0, `the cap-th (${CAP}) decorated call must be denied`)
})

test('T2b: a failed attempt leaves room to retry the SAME call (why the cap is 5)', () => {
  // The reference deployment: an `edit` failed at the tool layer — the harness
  // requires a read first, a precondition and not a loop — and the correct
  // response was to satisfy it and retry the identical call. At a cap of 2 that
  // retry is the very call that gets blocked, and the only way forward is to
  // cosmetically change the arguments, which is the behaviour this plugin exists
  // to stop. At 5 the retry fits with room to spare, and a call that keeps
  // failing is still stopped on its fifth attempt.
  const tracker = createTracker(cfg)
  const edit = {
    name: 'edit',
    arguments: { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' },
    agent: A,
  }
  assert.deepEqual(run(tracker, edit).hits, [], 'attempt 1 is allowed (and fails)')
  assert.deepEqual(run(tracker, edit).hits, [], 'the retry of the identical call must be allowed')
  for (let i = 2; i < CAP - 1; i += 1) {
    assert.deepEqual(run(tracker, edit).hits, [], `attempt ${i + 1} is still inside the cap`)
  }
  assert.ok(run(tracker, edit).hits.length > 0, 'a call that keeps failing is still blocked')
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

test('T4c: iterating on one file is never blocked — a file action is identified by POSITION', () => {
  const tracker = createTracker(cfg)
  // Editing the same file repeatedly at DIFFERENT positions is ordinary work.
  // The reference deployment hit a path-only cap on the third consecutive edit
  // of a single document (a SKILL.md) minutes after installing 0.2.0, and a
  // path-only cap of 2 on re-reading a file it was already editing.
  for (let i = 0; i < 8; i += 1) {
    const step = {
      name: 'edit',
      arguments: { file_path: '/w/skill.md', old_string: `a${i}`, new_string: `b${i}` },
      agent: A,
    }
    assert.deepEqual(run(tracker, step).hits, [], `edit #${i + 1} must be allowed`)
  }
  // ...and so is reading one file at different offsets.
  for (const offset of [0, 200, 400, 600]) {
    const reader = { name: 'read', arguments: { file_path: '/w/skill.md', offset, limit: 50 }, agent: A }
    assert.deepEqual(run(tracker, reader).hits, [], `read at offset ${offset} must be allowed`)
  }
  // The SAME position with the SAME arguments is the same action, and is denied.
  const again = {
    name: 'edit',
    arguments: { file_path: '/w/skill.md', old_string: 'a3', new_string: 'b3' },
    agent: A,
  }
  const deny = runUntilDenied(tracker, again)
  assert.ok(deny.hits.length > 0, 'a byte-identical re-edit is still caught')
  assert.ok(hit(deny.hits, 'exact:'), 'the position-aware fingerprint is exact:')
  assert.ok(deny.attempts <= CAP, `it must take no more than ${CAP} repeats to be caught`)
})

// ---------------------------------------------------------------------------
// T5 / T8 — transport-level equivalence
// ---------------------------------------------------------------------------

test('T5: curl and wget fetching the same URL into the same file collide', () => {
  const tracker = createTracker(cfg)
  const spellings = [
    'curl -s https://x.example.com/f --max-time 20 -o out.bin',
    'wget -O out.bin https://x.example.com/f',
    'curl -s -o out.bin https://x.example.com/f',
  ]
  let last
  for (let i = 0; i < CAP; i += 1) {
    last = run(tracker, bash(spellings[i % spellings.length]))
    if (i < CAP - 1) assert.deepEqual(last.hits, [], `fetch ${i + 1} must be allowed`)
  }
  assert.ok(hit(last.hits, 'net:'), `expected net: hit, got ${JSON.stringify(last.hits)}`)
  assert.ok(hit(last.hits, 'sink:'), 'expected sink: hit')
  assert.ok(last.fps.includes('family:http-fetch'), 'wget must join the http-fetch family')
})

test('T8: volatile flags do not change the cmd: fingerprint', () => {
  const a = fingerprints(bash('curl -sS --max-time 60 --retry 3 https://a.example.com/x -o f'), cfg).fps
  const b = fingerprints(bash('curl --max-time 30 --retry 0 https://a.example.com/x -o f'), cfg).fps
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
    const { fps } = fingerprints(exec, cfg)
    assert.equal(isTracked(exec.name, cfg), false, 'the caller (guard) must skip it before this point')
    void fps
  }
  assert.deepEqual(tracker.slot(A).calls, [])
})

test('T7: agents have independent budgets', () => {
  const tracker = createTracker(cfg)
  const a = bash(SAME_COMMAND, {}, A)
  const b = bash(SAME_COMMAND, {}, B)
  for (let i = 0; i < CAP - 1; i += 1) {
    assert.deepEqual(run(tracker, a).hits, [], `A call ${i + 1} must be allowed`)
  }
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

test('T9b: normUrl folds spelling, keeps the query, drops tracking params', () => {
  const plain = normUrl('https://Example.COM:443/a/b/?q=1#frag', cfg.hostAliases)
  assert.deepEqual(plain, {
    host: 'example.com',
    path: '/a/b',
    site: 'example.com',
    href: 'example.com/a/b?q=1',
  })
  assert.equal(normUrl('https://example.com', cfg.hostAliases).path, '/')

  // A page number is the resource; a tracking parameter is not.
  const page1 = normUrl('https://api.github.com/repos/o/r/commits?per_page=100&page=1', {})
  const page2 = normUrl('https://api.github.com/repos/o/r/commits?page=2&per_page=100', {})
  assert.notEqual(page1.href, page2.href, 'pagination must be a different resource')
  assert.equal(
    normUrl('https://api.github.com/repos/o/r/commits?per_page=100&page=1&utm_source=x', {}).href,
    page1.href,
    'a tracking parameter must not launder a repeat',
  )
  assert.equal(page1.href, 'api.github.com/repos/o/r/commits?page=1&per_page=100', 'params are sorted')
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

test('T9f: limitFor resolves exact keys, kinds, and a disabled cap', () => {
  assert.equal(limitFor('net:a/b', cfg.limits), CAP)
  assert.equal(limitFor('site:canada.ca', cfg.limits), Number.POSITIVE_INFINITY, 'volume caps ship off')
  assert.equal(limitFor('family:http-fetch', cfg.limits), Number.POSITIVE_INFINITY)
  assert.equal(limitFor('verb:ls', cfg.limits), Number.POSITIVE_INFINITY)
  // ...but a profile that wants a crawl budget can still set one.
  assert.equal(limitFor('site:canada.ca', { site: 20 }), 20)
  assert.equal(limitFor('family:http-fetch', { 'family:http-fetch': 40 }), 40)
})

// ---------------------------------------------------------------------------
// T10 / T11 — read paths and deny bookkeeping
// ---------------------------------------------------------------------------

test('T10: the same file at the same position twice is denied, a new position is not', () => {
  const tracker = createTracker(cfg)
  const read = (extra = {}) => ({ name: 'read', arguments: { file_path: '/w/README.md', ...extra }, agent: A })
  assert.deepEqual(run(tracker, read()).hits, [])
  // Different position -> different arguments -> different action.
  assert.deepEqual(run(tracker, read({ offset: 120 })).hits, [], 'a new position is a new action')
  // The SAME position keeps spending the same budget, and is denied at the cap.
  const repeat = runUntilDenied(tracker, read({ offset: 120 }))
  assert.ok(hit(repeat.hits, 'exact:'), `expected an exact: hit, got ${JSON.stringify(repeat.hits)}`)
})

test('T11: a denied call still consumes its budget (hammering stays blocked)', () => {
  const tracker = createTracker(cfg)
  const call = bash('curl -s https://blocked.example.com/x -o f')
  let last
  for (let i = 0; i < CAP; i += 1) {
    last = run(tracker, call)
    if (i < CAP - 1) assert.deepEqual(last.hits, [], `attempt ${i + 1} must be allowed`)
  }
  assert.ok(last.hits.length > 0, `attempt ${CAP} is denied`)
  // "Parallel" duplicates in the same step all see the deny path's commit.
  assert.ok(run(tracker, call).hits.length > 0, 'hammering a denied call stays denied')
  assert.ok(run(tracker, call).hits.length > 0)
})

test('T11b: a denied call does NOT spend budget for resources it never touched', () => {
  const tracker = createTracker(cfg)
  // Fill the shared output file's budget with DISTINCT urls, so the next call is
  // denied purely on sink: — and its own (never-fetched) URL must not be charged
  // to net:.
  for (let i = 0; i < CAP - 1; i += 1) {
    assert.deepEqual(run(tracker, bash(`curl -s https://a.example.com/${i} -o /tmp/shared.bin`)).hits, [])
  }
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
/**
 * A context double.
 *
 * `web: false` (the default) models a profile with NO web service: `inject` never
 * calls back, so `web_fetch_file` never registers — and, because the HTTP block is
 * fail-safe, shell HTTP is then NOT blocked either. `web: true` models the shipped
 * deployment, where the tool exists and the block therefore applies.
 */
function fakeCtx({ web = false } = {}) {
  const guards = []
  const handlers = new Map()
  const tools = {
    guard: (fn) => { guards.push(fn); return () => {} },
    register: (definition) => { tools.registered.push(definition); return () => {} },
    registered: [],
  }
  const ctx = {
    tools,
    on: (event, fn) => { handlers.set(event, fn); return () => {} },
    get: () => undefined,
    inject: web
      ? (_deps, callback) => { callback({ web: { fetch: async () => ({}) }, tools }); return () => {} }
      : () => () => {},
  }
  return { ctx, guards, handlers, registered: tools.registered }
}

test('T12: apply() wires a synchronous guard that denies a repeat with a usable message', async () => {
  assert.equal(PLUGIN_NAME, 'repeat-tool-breaker')
  const { ctx, guards, handlers } = fakeCtx()
  const dispose = apply(ctx, { blockShellHttp: false,})
  assert.equal(guards.length, 1)

  const call = bash(SAME_COMMAND, { description: '1st' })
  assert.equal(guards[0](call), undefined, 'the value returned from a guard must be undefined to allow')

  let denied
  for (let i = 0; i < CAP; i += 1) {
    denied = guards[0](bash(SAME_COMMAND, { description: `decorated ${i}` }))
  }
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
  const dispose = apply(ctx, { blockShellHttp: false,})
  const call = bash(SAME_COMMAND)
  for (let i = 0; i < CAP - 1; i += 1) assert.equal(guards[0](call), undefined)
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
  assert.throws(() => apply(ctx, { blockShellHttp: false, denyAfter: 3 }), /removed in 0\.2\.0/)
  assert.throws(() => apply(ctx, { blockShellHttp: false, window: 3 }), /window/)
  assert.throws(() => apply(ctx, { blockShellHttp: false, limits: { net: 1 } }), /must be a finite number >= 2/)
  assert.equal(typeof apply(ctx, { blockShellHttp: false, limits: { net: null } }), 'function', 'null is the documented "disable this cap"')
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

test('T14: shipped defaults are the 0.4.2 table', () => {
  assert.equal(DEFAULTS.window, 16)
  assert.deepEqual(DEFAULTS.limits, {
    exact: 12,
    cmd: 12,
    net: 12,
    sink: 12,
    host: 16,
    site: null,
    'family:http-fetch': null,
    'verb:curl': null,
    'verb:wget': null,
  })
  // The gate asks by default because asking is FAIL-CLOSED: every unattended
  // approval outcome is a denial, so a headless profile denies by itself and
  // nobody has to write a patch to get the prompt on a profile with a UI.
  assert.equal(DEFAULTS.onLimit, 'ask', 'the gate must work without a hand-written patch')
  // Asking is no longer a local-only concern, so `localHosts` no longer has `ask`.
  assert.equal(DEFAULTS.localHosts, 'deny')
  assert.equal(DEFAULTS.warnAt, 7)
  assert.equal(DEFAULTS.summarizeAt, 11)
  assert.equal(DEFAULTS.includeLocal, false)
  assert.deepEqual(DEFAULTS.exclude, ['todo_write'])
  // Removed in 0.2.4: the key only ever fed the path-only file fingerprints, which
  // 0.2.2 deleted. A config that still lists it is accepted and inert.
  assert.ok(!('pathAliases' in DEFAULTS), 'pathAliases must not come back as dead config')
  assert.equal(limitFor('writepath:/w', cfg.limits), Number.POSITIVE_INFINITY)
})

test('T14d: a stage is disabled by 0, a negative number, or null — not an error', () => {
  for (const value of [0, -1, null]) {
    const off = validateCfg(mergeDefaults({ warnAt: value, summarizeAt: value }))
    assert.equal(off.warnAt, null, `warnAt ${String(value)} must disable the stage silently`)
    assert.equal(off.summarizeAt, null)
  }
  assert.equal(validateCfg(mergeDefaults({ warnAt: 4 })).warnAt, 4, 'a positive integer survives')
  assert.throws(() => validateCfg(mergeDefaults({ warnAt: 'soon' })), /must be a number/)
})

test('T14e: no setting is compared with another', () => {
  // Inverted stages are legal: the stronger message simply fires first.
  const inverted = validateCfg(mergeDefaults({ warnAt: 9, summarizeAt: 3 }))
  assert.equal(inverted.warnAt, 9)
  assert.equal(inverted.summarizeAt, 3)
  // A limits entry below a stage is legal too — it says "no escalation for this
  // measure", which is a deliberate choice rather than a mistake to catch.
  const low = validateCfg(mergeDefaults({ warnAt: 3, summarizeAt: 6, limits: { exact: 2 } }))
  assert.equal(low.limits.exact, 2)
})

test('T14f: `localHosts: ask` fails loud and points at onLimit', () => {
  assert.throws(
    () => validateCfg(mergeDefaults({ localHosts: 'ask' })),
    /localHosts: ask[\s\S]*removed in 0\.4\.0[\s\S]*onLimit: ask/,
  )
})

test('T14b: DOCUMENTED BEHAVIOR — volume is not a loop signal, so a batch always survives', () => {
  const tracker = createTracker(cfg)
  // Twelve DIFFERENT urls inside one window: real work must never be stopped by
  // volume. Three earlier releases tried to cap this and every setting produced a
  // false positive on a real session (see CHANGELOG 0.3.2).
  for (let i = 0; i < 12; i += 1) {
    const call = bash(`curl -s -o /dev/null https://host${i}.example.com/p`)
    assert.deepEqual(run(tracker, call).hits, [], `fetch #${i + 1} must be allowed`)
  }
  // What IS still stopped is the same resource over and over.
  const repeat = bash('curl -s -o /dev/null https://host0.example.com/p')
  for (let i = 0; i < CAP - 1; i += 1) run(tracker, repeat)
  assert.ok(run(tracker, repeat).hits.length > 0, 'repeating one resource is still a loop')
})

test('T14c: pagination — net: stays distinct, host: is the convergence measure', () => {
  const tracker = createTracker(cfg)
  const page = (n) => bash(`curl -sL "https://api.github.com/repos/o/r/commits?per_page=100&page=${n}"`)
  for (let n = 1; n < HOST_CAP; n += 1) {
    const { hits, fps } = run(tracker, page(n))
    assert.deepEqual(hits, [], `page ${n} must be allowed`)
    assert.equal(fps.filter((fp) => fp.startsWith('net:')).length, 1, 'one net: fingerprint per call')
  }

  // Eight DISTINCT pages never collide on `net:` — the 0.3.2 guarantee, and it still
  // holds: the query is part of the fingerprint, so `?page=2` is a different
  // resource from `?page=1`.
  //
  // They are, however, requests to ONE host, so `host:` has reached HOST_CAP - 1 and
  // the next call to that host is the cap-th. That is the DESIGN, not a leftover of
  // 0.3.2: `net:` stops punishing pagination, and `host:` bounds how many requests one
  // target receives — with the two advisory stages underneath, where a paging model is
  // told to use a larger per-batch amount instead of walking many small ones. A model
  // that takes that advice finishes well under the gate; one that ignores it is exactly
  // what the gate is for. The advice is deliberately backend-agnostic — the same shape
  // appears when an agent reads a file line by line.
  const ninth = run(tracker, page(HOST_CAP))
  assert.ok(
    ninth.hits.some((entry) => entry.fp === 'host:api.github.com'),
    `expected host: to accumulate across pages, got ${JSON.stringify(ninth.hits)}`,
  )
  assert.ok(
    !ninth.hits.some((entry) => entry.fp.startsWith('net:')),
    'and net: must NOT be what blocks: every page is a different resource',
  )
})

// ---------------------------------------------------------------------------
// T17+ — local addresses, and the gate (`onLimit`)
//
// A call is LOCAL when it mentions at least one URL and every URL it mentions is
// local. Since 0.4.0 locality only decides whether target fingerprints are
// emitted at all (`localHosts: allow`) and whether the `host:` measure applies
// (`includeLocal`); asking the operator is no longer a local concern.
// ---------------------------------------------------------------------------

/** A call to one local path whose COMMAND differs per variant (so `net:` is what accumulates). */
const localCall = (path, variant = 0) =>
  bash(`curl -s -w 'code-${variant}' -o /dev/null http://127.0.0.1:18999/${path}`)

test('T17: isLocalHost covers loopback, private ranges, and link-local', () => {
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.9.9.9', '::1',
    '10.1.2.3', '192.168.111.90', '172.16.0.1', '172.31.255.255', '169.254.1.1',
    '0.0.0.0', 'fd00::1', 'fe80::1']) {
    assert.equal(isLocalHost(host), true, `${host} is local`)
  }
  for (const host of ['example.com', 'open.canada.ca', '8.8.8.8', '172.32.0.1', '172.15.0.1',
    '192.169.0.1', '2606:4700::1111']) {
    assert.equal(isLocalHost(host), false, `${host} is not local`)
  }
})

test('T17b: a call is local only when EVERY url it mentions is local', () => {
  assert.equal(fingerprints(bash('curl -s http://127.0.0.1:18999/x -o /tmp/o'), cfg).local, true)
  assert.equal(fingerprints(bash('curl -s https://example.com/x'), cfg).local, false)
  assert.equal(
    fingerprints(bash('curl -s http://127.0.0.1:18999/x https://example.com/y'), cfg).local,
    false,
    'one public url makes the whole call non-local',
  )
  assert.equal(fingerprints(bash('ls -la'), cfg).local, false, 'a call with no url is not a local call')
})

test('T25: the host: measure — public hosts yes, local hosts no by default', () => {
  const pub = fingerprints(bash('curl -s "https://api.weather.gc.ca/v1/x?STN_ID=1"'), cfg)
  assert.ok(pub.fps.includes('host:api.weather.gc.ca'), `expected a host: measure, got ${pub.fps}`)
  assert.ok(pub.fps.includes('site:gc.ca'), 'site: still collapses to the last two labels')
  // The host is what distinguishes targets: two different paths on one host share
  // the measure, which is exactly the convergence signal.
  const pub2 = fingerprints(bash('curl -s "https://api.weather.gc.ca/v1/y?STN_ID=2"'), cfg)
  assert.ok(pub2.fps.includes('host:api.weather.gc.ca'))
  assert.ok(!pub2.fps.some((fp) => pub.fps.includes(fp) && fp.startsWith('net:')), 'net: differs by query')

  const loc = fingerprints(bash('curl -s http://127.0.0.1:18999/p'), cfg)
  assert.ok(!loc.fps.some((fp) => fp.startsWith('host:')), 'local hosts are excluded by default')

  const withLocal = validateCfg(mergeDefaults({ includeLocal: true }))
  const loc2 = fingerprints(bash('curl -s http://127.0.0.1:18999/p'), withLocal)
  assert.ok(loc2.fps.includes('host:127.0.0.1'), 'includeLocal opts them back in')
})

test('T18: localHosts=deny counts and blocks local calls like any other', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny', localHosts: 'deny' })
  for (let i = 0; i < CAP - 1; i += 1) {
    assert.equal(guards[0](localCall('p', i)), undefined, `local call ${i + 1} is inside the cap`)
  }
  const message = guards[0](localCall('p', CAP - 1))
  assert.equal(typeof message, 'string')
  assert.match(message, /REPEAT_TOOL_BLOCKED/)
})

test('T19: localHosts=allow never fingerprints a local host', () => {
  const allow = validateCfg(mergeDefaults({ localHosts: 'allow' }))
  const { fps, local } = fingerprints(bash('curl -s http://127.0.0.1:18999/x -o /tmp/o'), allow)
  assert.equal(local, false, 'an already-exempt call needs no further treatment')
  assert.ok(!fps.some((fp) => fp.startsWith('net:127.')), `no local net: fingerprint: ${fps}`)
  assert.ok(!fps.some((fp) => fp.startsWith('site:127.')), 'no local site: fingerprint')
  assert.ok(!fps.some((fp) => fp.startsWith('host:127.')), 'no local host: fingerprint')
  assert.ok(fps.some((fp) => fp.startsWith('exact:')), 'the action is still identified')
  const tracker = createTracker(allow)
  for (let i = 0; i < 12; i += 1) {
    assert.deepEqual(run(tracker, localCall('p', i), allow).hits, [], `local call ${i + 1} must be allowed`)
  }
})

test('T26: an exemption covers only the measures that hit', () => {
  const offending = [{ fp: 'host:a.example.com', next: 9, cap: 9 }]
  assert.deepEqual(blockingHits(offending, new Set(['host:a.example.com'])), [], 'the exempted measure passes')
  assert.deepEqual(
    blockingHits(offending, new Set(['host:b.example.com'])),
    offending,
    'a different measure is untouched by that exemption',
  )
  assert.deepEqual(blockingHits(offending, new Set()), offending, 'no exemption blocks everything')
})

test('T24: the three stages fire at warnAt, summarizeAt and the cap', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  // onLimit: deny isolates the two advisory stages from the gate.
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const call = () => bash('curl -s "https://api.example.com/v1/items?page=1"')
  const observed = []

  for (let i = 1; i <= CAP; i += 1) {
    const exec = call()
    const denial = guards[0](exec)
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    const advisory = (decision?.additionalContexts ?? [])
      .filter((message) => message.source?.kind === 'plugin')
      .map((message) => message.content[0].text)
      .join('\n')
    observed.push({ i, denied: typeof denial === 'string', denial, advisory })
  }
  const at = (n) => observed[n - 1]

  assert.equal(at(1).advisory, '', 'nothing on the first call')
  assert.equal(at(WARN - 1).advisory, '', `nothing before stage 1 (${WARN})`)
  assert.match(
    at(WARN).advisory,
    /^CONVERGENCE_CHECK: you are repeating yourself/,
    `stage 1 at ${WARN}`,
  )
  assert.equal(at(WARN + 1).advisory, '', 'the stage fires once per crossing, not on every later call')
  assert.equal(at(SUMMARIZE - 1).advisory, '', `nothing between the stages (${WARN + 1}..${SUMMARIZE - 1})`)
  assert.match(at(SUMMARIZE).advisory, /summarise your progress/, `stage 2 at ${SUMMARIZE}`)
  assert.match(at(SUMMARIZE).advisory, /larger per-batch amount/, 'and it names the batching lever')
  assert.doesNotMatch(
    at(SUMMARIZE).advisory,
    /paging|per_page|page size/i,
    'the advice must stay backend-agnostic: the same failure shows up reading a file line by line',
  )
  for (let i = SUMMARIZE + 1; i < CAP; i += 1) {
    assert.equal(at(i).advisory, '', `nothing between stage 2 and the gate (call ${i})`)
  }
  assert.equal(at(CAP).denied, true, 'the cap-th call is the gate')
  assert.match(at(CAP).denial, /REPEAT_TOOL_BLOCKED/)
  assert.doesNotMatch(at(CAP).denial, /budget/i, 'no invented budget figure')
  // No advisory message may look like a tool-call template.
  for (const entry of observed) {
    assert.doesNotMatch(entry.advisory, /<tool_call>|<function=/, 'no template-looking text')
  }
})

test('T27: a disabled stage is simply never delivered', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny', warnAt: 0, summarizeAt: null })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const call = () => bash('curl -s "https://api.example.com/v1/items?page=1"')
  for (let i = 1; i < CAP; i += 1) {
    const exec = call()
    guards[0](exec)
    const decision = await post(exec, { content: [] }, noop)
    assert.equal(decision?.additionalContexts, undefined, `no advisory on call ${i}`)
  }
})

test('T20: the gate asks, and approving stops counting that measure for the turn', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'ask' })
  const pre = handlers.get('tools/pre-execute')
  const noop = async () => ({ kind: 'allow' })

  for (let i = 0; i < CAP - 1; i += 1) guards[0](localCall('p', i))

  // The cap-th fetch of the same local resource would block on `net:` — so it is
  // asked about instead.
  const askable = localCall('p', CAP - 1)
  const decision = await pre(askable, noop)
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /about to be blocked as a repeat/)
  assert.match(decision.reason, /REST OF THIS TURN/)

  // Approved: the guard sees the very execution that was asked about.
  assert.equal(guards[0](askable), undefined, 'an approved ask must not be denied by the guard')

  // The measure that hit is exempt AND no longer counted, so later identical ones
  // ride along without ever reaching a stage again.
  for (let i = CAP; i < CAP + 12; i += 1) {
    assert.equal(guards[0](localCall('p', i)), undefined, `local call ${i + 1} rides along`)
  }
})

test('T21: the gate is not local-only — any measure can be asked about', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'ask' })
  const pre = handlers.get('tools/pre-execute')
  const noop = async () => ({ kind: 'allow' })

  // Fill a shared sink and one public host with DIFFERENT urls, then gate on it.
  for (let i = 0; i < CAP - 1; i += 1) {
    guards[0](bash(`curl -s https://a.example.com/${i} -o /tmp/shared.bin`))
  }
  const mixed = bash('curl -s http://127.0.0.1:18999/x https://a.example.com/0 -o /tmp/shared.bin')
  assert.equal(fingerprints(mixed, cfg).local, false, 'one public url makes the call non-local')
  const decision = await pre(mixed, noop)
  assert.equal(decision.kind, 'ask', 'asking is no longer restricted to local targets')
  assert.match(decision.reason, /sink:\/tmp\/shared\.bin/)
})

test('T22: a declined ask stops asking and denies that measure for the turn', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'ask' })
  const pre = handlers.get('tools/pre-execute')
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })

  for (let i = 0; i < CAP - 1; i += 1) guards[0](localCall('p', i))
  const denied = localCall('p', CAP - 1)
  assert.equal((await pre(denied, noop)).kind, 'ask')

  // Rejected: the guard never sees it, but post-execute does.
  await post(denied, { isError: true, content: [{ type: 'text', text: 'denied by operator' }] }, noop)

  // No further prompts this turn...
  assert.equal((await pre(localCall('p', 3), noop)).kind, 'allow')
  // ...and the denial explains what happened to the model.
  const message = guards[0](localCall('p', 3))
  assert.equal(typeof message, 'string')
  assert.match(message, /was NOT granted/)

  // A new human turn clears the refusal.
  const preStep = handlers.get('agent/pre-step')
  await preStep({ agent: A, messages: [{ source: { kind: 'user' } }] }, () => undefined)
  for (let i = 0; i < CAP - 1; i += 1) guards[0](localCall('q', i))
  assert.equal(
    (await pre(localCall('q', CAP - 1), noop)).kind,
    'ask',
    'asking resumes after a human message',
  )
})

test('T23: a human turn clears the exemption and the window', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'ask' })
  const pre = handlers.get('tools/pre-execute')
  const noop = async () => ({ kind: 'allow' })

  for (let i = 0; i < CAP - 1; i += 1) guards[0](localCall('p', i))
  const asked = localCall('p', CAP - 1)
  assert.equal((await pre(asked, noop)).kind, 'ask')
  assert.equal(guards[0](asked), undefined, 'approved -> exempt for this turn')
  assert.equal(guards[0](localCall('p', 3)), undefined, 'and later calls to that measure ride along')

  const preStep = handlers.get('agent/pre-step')
  await preStep({ agent: A, messages: [{ source: { kind: 'user' } }] }, () => undefined)

  for (let i = 0; i < CAP - 1; i += 1) {
    assert.equal(guards[0](localCall('q', i)), undefined, `the new turn's local call ${i + 1} fits`)
  }
  assert.equal(
    (await pre(localCall('q', CAP - 1), noop)).kind,
    'ask',
    'the cap-th local call of the new turn asks again instead of sailing through',
  )
})

test('T28: a measure with no cap never escalates — the stages live BELOW the cap', async () => {
  // Regression: `stageAdvisory` originally ignored `limits` entirely, so the volume
  // measures that ship DISABLED (`site:`, `family:*`, `verb:*` are all `null`) still
  // fired advisories. One `curl` emits four of them at once, so a single action could
  // produce up to four near-identical messages — observed in production as
  // `verb:cd has come up 3 times` and `family:http-fetch has now come up 6 times`.
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false,})
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const agent = { id: 'uncapped-agent' }

  // WARN different urls: `verb:curl` and `family:http-fetch` climb to WARN, but both
  // are null-capped, so nothing may be delivered. The loop must reach the stage
  // threshold exactly -- a shorter one would pass trivially and prove nothing.
  for (let i = 1; i <= WARN; i += 1) {
    const exec = bash(`curl -s https://host${i}.example.com/p`)
    guards[0](exec)
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    assert.equal(decision?.additionalContexts, undefined, `no advisory may fire on call ${i}`)
  }

  // A CAP the operator turns ON makes the same measure escalate.
  const on = fakeCtx()
  apply(on.ctx, { blockShellHttp: false, limits: { 'verb:curl': CAP } })
  const onPost = on.handlers.get('tools/post-execute')
  const agent2 = { id: 'capped-agent' }
  const seen = []
  for (let i = 1; i <= WARN; i += 1) {
    const exec = bash(`curl -s https://host${i}.example.com/p`)
    on.guards[0](exec)
    const decision = await onPost(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    for (const message of decision?.additionalContexts ?? []) seen.push(message.content[0].text)
  }
  assert.equal(seen.length, 1, `the now-capped verb escalates exactly once, at ${WARN}`)
  assert.match(seen[0], new RegExp(`verb:curl has come up ${WARN} times`))
})

test('T29: when several measures cross together, the message names the useful one', async () => {
  // Identical calls cross `exact:`, `net:`, `site:` and `host:` at the same count.
  // Naming `exact:` quotes a truncated command line; the target is what the model can
  // act on.
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false,})
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const agent = { id: 'tie-agent' }
  const command = 'curl -s "https://api.example.com/v1/items?page=1"'
  const seen = []
  for (let i = 1; i <= WARN; i += 1) {
    const exec = bash(command)
    guards[0](exec)
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    for (const message of decision?.additionalContexts ?? []) seen.push(message.content[0].text)
  }
  assert.equal(seen.length, 1)
  assert.match(
    seen[0],
    new RegExp(`host:api\\.example\\.com has come up ${WARN} times`),
    `named: ${seen[0].split('\n')[0]}`,
  )
  assert.doesNotMatch(seen[0], /exact:bash/, 'must not dump the command line')
})

// ---------------------------------------------------------------------------
// T30+ — the failure track (0.5.0)
//
// A second escalation track on CONSECUTIVE FAILURES of one fingerprint. It shares
// the gate, the exemptions and the measure set with the occurrence track, and it
// differs in the one thing that matters: `isError` is NOT the failure definition.
//
// Every test here therefore uses the SAME target repeatedly. A per-fingerprint
// streak only grows when one fingerprint keeps failing; varying the host makes each
// fingerprint fail once, which is not a streak at all.
// ---------------------------------------------------------------------------

/** The failure track's thresholds, read from the shipped defaults. */
const FAIL_WARN = cfg.failWarnAt
const FAIL_LIMIT = cfg.failLimit

/** A settled bash result. The structured `value` is what the classifier reads. */
const result = (value, extra = {}) => ({
  isError: false,
  content: [{ type: 'text', text: 'some output' }],
  value,
  ...extra,
})
/** A command that ran and exited non-zero — NOT an `isError`. */
const failed = (code = 1) => result({ kind: 'foreground', exitCode: code, signal: null, timedOut: false })
/** A fetch that completed with an error status — NOT an `isError`. */
const httpFailed = (status) => result({ url: 'https://x.example.com/', statusCode: status, truncated: false })
const okResult = () => result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false })

/** Drive one call through the real guard + post-execute pair. */
async function drive(guards, post, exec, res, noop) {
  const denial = guards[0](exec)
  const decision = await post(exec, res, noop)
  const advisory = (decision?.additionalContexts ?? [])
    .filter((message) => message.source?.kind === 'plugin')
    .map((message) => message.content[0].text)
    .join('\n')
  return { denial, advisory }
}

/** Only the failure track's advisory, so the occurrence track cannot be mistaken for it. */
const isFailureAdvice = (text) => /has failed \d+ times in a row/.test(text)

test('T30: consecutive failures warn, and isError is not the failure test', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  // One target, failing. The command is identical each time, but the OCCURRENCE
  // track's first stage is warnAt (7) — well above FAIL_WARN — so anything seen at
  // FAIL_WARN comes from the failure track alone. `exitCode: 1` is not an isError.
  const target = 'curl -s "https://api.flaky.example.com/v1/items"'

  const seen = []
  for (let i = 1; i <= FAIL_WARN; i += 1) {
    seen.push(await drive(guards, post, bash(target), failed(1), noop))
  }
  for (let i = 1; i < FAIL_WARN; i += 1) {
    assert.equal(seen[i - 1].advisory, '', `nothing before ${FAIL_WARN} failures (call ${i})`)
  }
  const advice = seen[FAIL_WARN - 1].advisory
  assert.ok(isFailureAdvice(advice), `expected the failure advisory, got: ${advice.slice(0, 80)}`)
  assert.match(advice, new RegExp(`has failed ${FAIL_WARN} times in a row`))
  assert.match(advice, /exited 1/, 'the failure detail is quoted')
  assert.doesNotMatch(advice, /exact:bash/, 'no command line dump')
  assert.doesNotMatch(advice, /has come up \d+ times this turn/, 'that is the other track')
})

test('T31: the failure gate blocks the failing target, not the recovery call', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const target = 'curl -s "https://api.does-not-exist.invalid/v1/items"'

  for (let i = 1; i <= FAIL_LIMIT; i += 1) {
    const { denial } = await drive(guards, post, bash(target), httpFailed(404), noop)
    assert.equal(denial, undefined, `call ${i} must be allowed (${i} failures, limit ${FAIL_LIMIT})`)
  }

  // The next attempt at the SAME target is blocked...
  const blocked = await drive(guards, post, bash(target), httpFailed(404), noop)
  assert.equal(typeof blocked.denial, 'string', 'the target that keeps failing is blocked')
  assert.match(blocked.denial, /REPEAT_TOOL_BLOCKED/)
  assert.match(blocked.denial, /consecutive failures/)
  assert.match(blocked.denial, /404/, 'the status is named')

  // ...but the recovery action is NOT. Blocking it is how a guard turns a stuck
  // model into a wedged one.
  const recovery = bash('grep -rn "does-not-exist" /workspace/src')
  const allowed = await drive(guards, post, recovery, okResult(), noop)
  assert.equal(allowed.denial, undefined, 'diagnosing must not be blocked')

  const other = bash('curl -s "https://api.example.com/v1/items"')
  const otherCall = await drive(guards, post, other, okResult(), noop)
  assert.equal(otherCall.denial, undefined, 'a different target must not be blocked')
})

test('T32: a success clears the streak; a success of something else does not', async () => {
  const target = 'curl -s "https://api.flaky.example.com/v1/items"'
  const noop = async () => ({ kind: 'allow' })

  // Part 1, on a fresh instance: FAIL_WARN - 1 failures, a success, then a failure.
  // The streak restarted at 1, so nothing fires.
  {
    const { ctx, guards, handlers } = fakeCtx()
    apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
    const post = handlers.get('tools/post-execute')
    for (let i = 1; i < FAIL_WARN; i += 1) await drive(guards, post, bash(target), failed(1), noop)
    await drive(guards, post, bash(target), okResult(), noop)
    const after = await drive(guards, post, bash(target), failed(1), noop)
    assert.equal(after.advisory, '', 'the streak restarted from 1')
  }

  // Part 2, on another fresh instance: a success of a DIFFERENT target must not
  // clear it — a read is not progress on the thing that keeps failing.
  {
    const { ctx, guards, handlers } = fakeCtx()
    apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
    const post = handlers.get('tools/post-execute')
    let advice = ''
    for (let i = 1; i <= FAIL_WARN; i += 1) {
      const step = await drive(guards, post, bash(target), failed(1), noop)
      if (isFailureAdvice(step.advisory)) advice = step.advisory
      if (i === 1) await drive(guards, post, bash('ls -la /tmp'), okResult(), noop)
    }
    assert.match(
      advice,
      new RegExp(`has failed ${FAIL_WARN} times in a row`),
      'an unrelated success must not reset another fingerprint',
    )
  }
})

test('T33: the plugin never counts its own denial as a failure', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const target = 'curl -s "https://api.does-not-exist.invalid/v1/items"'

  for (let i = 1; i <= FAIL_LIMIT; i += 1) {
    await drive(guards, post, bash(target), httpFailed(404), noop)
  }

  // Feed the gate its own denial 20 times. If the plugin counted those, the streak
  // would climb without limit — the guard feeding itself — and the reported count
  // would drift far above failLimit.
  let lastDenial = ''
  for (let i = 0; i < 20; i += 1) {
    const exec = bash(target)
    const denial = guards[0](exec)
    assert.equal(typeof denial, 'string', 'still blocked')
    lastDenial = denial
    await post(exec, { isError: true, content: [{ type: 'text', text: denial }] }, noop)
  }
  const reported = Number(/(\d+) consecutive failures/.exec(lastDenial)?.[1])
  assert.equal(reported, FAIL_LIMIT, 'the streak did not grow from our own denials')

  // And a call that does not carry the blocked fingerprint is still fine.
  const other = await drive(guards, post, bash('echo hello'), okResult(), noop)
  assert.equal(other.denial, undefined)
})

test('T34: the failure track ignores measures the operator disabled', async () => {
  // The corpus showed the longest failure streaks sitting on the null-capped
  // volume measures (9 on `family:http-fetch`, 8 on `verb:curl`). Counting them
  // here would reintroduce the 0.4.0 bug through a new channel.
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })

  // Distinct hosts: only `verb:curl` and `family:http-fetch` accumulate, and both
  // are null-capped, so no failure advisory may ever be delivered.
  for (let i = 1; i <= FAIL_LIMIT + 3; i += 1) {
    const exec = bash(`curl -s "https://h${i}.example.com/p"`)
    const { advisory } = await drive(guards, post, exec, failed(1), noop)
    assert.equal(advisory, '', `no advisory from a disabled measure (call ${i})`)
  }
})

test('T35: failLimit null keeps the advisory and drops the gate', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny', failLimit: null })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const target = 'curl -s "https://api.does-not-exist.invalid/v1/items"'

  let failureAdvices = 0
  for (let i = 1; i <= FAIL_LIMIT + 4; i += 1) {
    const { denial, advisory } = await drive(guards, post, bash(target), httpFailed(404), noop)
    assert.equal(denial, undefined, `no gate when failLimit is null (call ${i})`)
    if (isFailureAdvice(advisory)) failureAdvices += 1
  }
  assert.equal(failureAdvices, 1, 'the advisory still fires exactly once')
})

test('T36: failWarnAt 0 disables the advisory but not the gate', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny', failWarnAt: 0 })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const target = 'curl -s "https://api.does-not-exist.invalid/v1/items"'

  for (let i = 1; i <= FAIL_LIMIT; i += 1) {
    const { denial, advisory } = await drive(guards, post, bash(target), httpFailed(404), noop)
    assert.equal(isFailureAdvice(advisory), false, 'the failure advisory is off')
    assert.equal(denial, undefined, `call ${i} allowed`)
  }
  const blocked = await drive(guards, post, bash(target), httpFailed(404), noop)
  assert.equal(typeof blocked.denial, 'string', 'the gate is independent of the advisory')
})

test('T37: failLimit validation is fail-loud, failWarnAt follows the stage rule', () => {
  assert.throws(() => validateCfg(mergeDefaults({ failLimit: 1 })), /failLimit/)
  assert.throws(() => validateCfg(mergeDefaults({ failLimit: 'soon' })), /failLimit/)
  assert.equal(validateCfg(mergeDefaults({ failLimit: null })).failLimit, null)
  for (const value of [0, -1, null]) {
    assert.equal(validateCfg(mergeDefaults({ failWarnAt: value })).failWarnAt, null)
  }
  assert.equal(validateCfg(mergeDefaults({ failWarnAt: 4 })).failWarnAt, 4)
})

// ---------------------------------------------------------------------------
// T38+ — the failure shapes a real spin actually produces (0.5.1)
//
// Reported from a live run: five failing calls against one host, and the failure
// track saw none of them. Not because the signals were missing but because the
// shapes were: a shell PIPELINE exits with its last command's status, and a script
// that catches its own HTTP error exits 0. Both leave the failure in the text only.
// ---------------------------------------------------------------------------

test('T38: a shell pipeline that masks its exit code is still a failure', () => {
  // The real text, from the run that motivated this: `curl … | python3 … | head`
  // exits 0, so `exitCode` is 0 and `isError` is false.
  const pythonCrash = result({
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
  }, {
    content: [{ type: 'text', text: '[stderr]\nTraceback (most recent call last):\n  File "/tmp/ym.py", line 3\n    with urllib.request.urlopen(url) as r:\nurllib.error.URLError: <urlopen error [Errno -2]>' }],
  })
  const failure = classifyFailure(pythonCrash, { shell: true })
  assert.notEqual(failure, null, 'a traceback under exit code 0 must be a failure')
  assert.equal(failure.reason, 'exception')
  assert.match(describeFailure(failure), /URLError/)

  // A syntax error is reported with no traceback header at all.
  const syntaxError = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
    content: [{ type: 'text', text: '[stderr]\n  File "<string>", line 1\n    import sys,json; d=json.load(sys.stdin\nSyntaxError: unexpected EOF while parsing' }],
  })
  assert.equal(classifyFailure(syntaxError, { shell: true })?.reason, 'exception')

  // An HTTP error the script caught and printed itself.
  const caught = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
    content: [{ type: 'text', text: 'daily=snowfall -> HTTP Error 400: Bad Request {"error":true}' }],
  })
  assert.equal(classifyFailure(caught, { shell: true })?.reason, 'http')

  // curl's own diagnostics.
  const curlFail = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
    content: [{ type: 'text', text: '[stderr]\ncurl: (6) Could not resolve host: nope.invalid' }],
  })
  assert.equal(classifyFailure(curlFail, { shell: true })?.reason, 'curl')
})

test('T39: a clean shell result stays a success', () => {
  const clean = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
    content: [{ type: 'text', text: "['latitude', 'longitude']\nn_days = 32" }],
  })
  assert.equal(classifyFailure(clean, { shell: true }), null)
  // Prose that merely mentions an error word must not match: the exception pattern
  // is anchored to the start of a line.
  const prose = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
    content: [{ type: 'text', text: 'The docs say a ValueError: is raised when the input is bad.' }],
  })
  assert.equal(classifyFailure(prose, { shell: true }), null)
})

test('T40: the text fallback is reached even when `result.value` is absent entirely', () => {
  // The report asked this directly. A profile that never populates `result.value`
  // must not be permanently blind: with no structured value at all, a shell result
  // still falls through to the text.
  const noValue = {
    isError: false,
    content: [{ type: 'text', text: 'Traceback (most recent call last):\n  File "x.py", line 1\nRuntimeError: boom' }],
  }
  assert.equal(classifyFailure(noValue, { shell: true })?.reason, 'exception')
  assert.equal(classifyFailure(noValue, { shell: false }), null, 'but only for a shell tool')
})

test('T41: a successful fetch is never re-read as text', () => {
  // A fetched page can contain the words "HTTP Error 400" or a traceback. A status
  // code is definitive in BOTH directions, so the text must not be consulted.
  const page = result({ url: 'https://x.example.com/', statusCode: 200, truncated: false }, {
    content: [{ type: 'text', text: 'Fetched https://x.example.com/ (HTTP 200)\n\nA post about Traceback (most recent call last) and HTTP Error 400.' }],
  })
  assert.equal(classifyFailure(page, { shell: false }), null)
  assert.equal(classifyFailure(page, { shell: true }), null, 'the status wins for a shell too')

  const notFound = result({ url: 'https://x.example.com/', statusCode: 404, truncated: false })
  assert.equal(classifyFailure(notFound, { shell: false })?.reason, 'http')
})

test('T42: the failure track catches the reported spin, end to end', async () => {
  // The live trajectory: five failing calls, all textually different, all exit 0,
  // all against one host. The occurrence track sees nothing repeated; the failure
  // track must fire at failWarnAt.
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { blockShellHttp: false, onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })

  // The real shape: a DIFFERENT script each time (so `exact:`/`cmd:` never repeat)
  // that all talk to the SAME host. The URL has to be IN the command — a script whose
  // URL lives in a file on disk is invisible to any fingerprint, which is a real
  // limitation of the measure, not of the failure track.
  const texts = [
    '{"error":true,"reason":"Invalid value: Cannot initialize ForecastVariableDaily"}',
    '[stderr]\n  File "<string>", line 1\nSyntaxError: unexpected EOF while parsing',
    '[stderr]\nTraceback (most recent call last):\n  File "/tmp/ym.py", line 3\nurllib.error.URLError: <urlopen error>',
    'daily=snowfall -> HTTP Error 400: Bad Request {"error":true}',
    '[stderr]\nTraceback (most recent call last):\n  File "/tmp/ym3.py", line 10\nKeyError: \'time\'',
  ]
  let advice = ''
  for (let i = 0; i < texts.length; i += 1) {
    const exec = bash(
      `python3 - <<'EOF'\nimport urllib.request\nurl="https://archive-api.open-meteo.com/v1/archive?daily=probe${i}"\nEOF`,
    )
    const res = result({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false }, {
      content: [{ type: 'text', text: texts[i] }],
    })
    const step = await drive(guards, post, exec, res, noop)
    if (isFailureAdvice(step.advisory)) advice = step.advisory
  }
  assert.match(advice, new RegExp(`has failed ${FAIL_WARN} times in a row`), `got: ${advice.slice(0, 100)}`)
  assert.match(advice, /host:archive-api\.open-meteo\.com/, 'the host carries the streak')
  assert.doesNotMatch(advice, /exact:bash/, 'and not the command line')
})

test('T43: no failure description contains a doubled space', () => {
  // `suffix` used to carry its own leading space and be prefixed again, which read as
  // "the script raised  urllib.error.URLError" and "(code  6)". Every reason is
  // checked, with and without a detail, because the bug hid in the branches nobody read.
  const reasons = ['exit', 'http', 'timeout', 'signal', 'sandbox', 'error', 'exception', 'curl', 'other']
  for (const reason of reasons) {
    for (const detail of ['', '7']) {
      const text = describeFailure({ reason, detail })
      assert.ok(text.length > 0, `${reason} must describe something`)
      assert.doesNotMatch(text, / {2}/, `doubled space in: ${JSON.stringify(text)}`)
      assert.doesNotMatch(text, /\(\s|\s\)/, `stray parenthesis spacing in: ${JSON.stringify(text)}`)
    }
  }
  assert.equal(describeFailure(null), '')
})

// ---------------------------------------------------------------------------
// T47+ — the shell HTTP block
//
// With HTTP from the shell refused, every fetch goes through a tool whose status is
// a structured field, which is what makes the failure track's input a FACT rather
// than an inference from text. That is why the `-w` detection was removed: it is
// unreachable once this block is in place.
// ---------------------------------------------------------------------------

/** Drive one call through the guard, returning its verdict. */
function verdict(guards, exec) {
  return guards[0](exec)
}

test('T47: the block is SEMANTIC — it does not care how the fetch is made', () => {
  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  const blocked = [
    'curl -s https://weather.gc.ca/x',
    'wget -q -O - https://weather.gc.ca/x',
    '/usr/bin/curl -s https://weather.gc.ca/x',
    'python3 -c "import urllib.request;urllib.request.urlopen(\'https://weather.gc.ca/x\')"',
    'node -e "fetch(\'https://weather.gc.ca/x\')"',
    'echo start; curl -s https://weather.gc.ca/x',
  ]
  for (const command of blocked) {
    const out = verdict(guards, bash(command))
    assert.equal(typeof out, 'string', `must be blocked: ${command}`)
    assert.match(out, /SHELL_HTTP_BLOCKED/)
  }
})

test('T47b: the KNOWN HOLE of a command-level rule, asserted rather than pretended', () => {
  // A guard sees the command text and nothing else. A destination that is not IN that
  // text — the URL lives in a file the script reads, or is assembled at runtime — is
  // invisible, and no amount of pattern work fixes that. This is the boundary of what
  // a command-level block can promise, so it is asserted here rather than left to be
  // discovered: closing it needs the capability removed (a sandbox without egress),
  // not a better rule.
  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  for (const command of [
    'bash /tmp/fetch.sh', // an HTTP verb inside a file: the verb here is `bash`
    'python3 /tmp/probe.py', // likewise, with `python3`
    'sh ./download',
  ]) {
    assert.equal(verdict(guards, bash(command)), undefined, `not detectable from the command text: ${command}`)
  }

  // The hole is NARROWER than it first looks, and worth pinning down so it is not
  // described as wider than it is. An HTTP verb blocks even with no URL in sight,
  // and an inline literal is visible even after a variable assignment, because the
  // text still contains it.
  for (const command of [
    'curl -s "$TARGET"', // an HTTP verb, destination from the environment
    'X=https://weather.gc.ca; curl -s "$X"', // the literal is still in the text
    'wget -q -O - "$URL"',
  ]) {
    assert.equal(typeof verdict(guards, bash(command)), 'string', `must be blocked: ${command}`)
  }
})

test('T48: local addresses, allowlisted verbs and ordinary commands are untouched', () => {
  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  const allowed = [
    // local: the fetch tool inherits the SSRF guard and CANNOT reach these, so
    // blocking them would be a lost capability rather than a redirect
    'curl -s http://127.0.0.1:3080/',
    'curl -s http://192.168.111.90:3080/healthz',
    // incidental network use with no fetch-to-file equivalent — and these two are the
    // EVIDENCE-LED default, reproducible with `tools/shell-http-allowlist-scan.mjs`:
    // over 225 logs / 27,539 shell calls, the only verbs that ever carried a remote URL
    // were `curl` (3424 segments), `git` (370) and `docker` (12), plus `wget` (7) — which
    // is NOT exempt, because it has the same fetch-to-file equivalent `curl` does.
    'git clone https://github.com/a/b /tmp/b',
    'docker run --rm alpine sh -c "true"',
    // not a fetch at all
    'grep -rn foo /workspace/src',
    'ls -la /tmp',
  ]
  for (const command of allowed) {
    assert.equal(verdict(guards, bash(command)), undefined, `must be allowed: ${command}`)
  }
})

test('T48b: a verb is exempt BECAUSE it is listed, and adding one is the point', () => {
  // `npm i git+https://…` is NOT in the evidence-led default, so it is refused — and
  // that is deliberate rather than an oversight: the corpus never showed it, and
  // guessing an exemption for a verb nobody used is speculation. Adding it is a
  // settings change, which is what the Settings → Plugins box is for.
  const strict = fakeCtx({ web: true })
  apply(strict.ctx, {})
  assert.equal(typeof verdict(strict.guards, bash('npm i git+https://github.com/a/b')), 'string')

  const extended = fakeCtx({ web: true })
  apply(extended.ctx, { shellHttpAllow: ['git', 'docker', 'npm'] })
  assert.equal(verdict(extended.guards, bash('npm i git+https://github.com/a/b')), undefined)
})

test('T48c: a regex-escaped URL is read as the address it spells', () => {
  // Found in production, on this plugin's own maintainer: a post-restart verification
  // command that grepped for a loopback token URL was refused by the block. The URL
  // pattern stops at a backslash (it cannot appear in a URL), so the match truncated:
  // `http://127\.0\.0\.1:3080/` extracted as `http://127`, and WHATWG reads a bare
  // `127` as the IPv4 NUMBER 0.0.0.127 — not loopback. So a LOCAL address spelled as a
  // grep pattern was classified as remote. The pattern form is exactly what a
  // verification command looks like, which is why this was hit immediately.
  assert.deepEqual(extractUrls('http://127\\.0\\.0\\.1:3080/'), ['http://127.0.0.1:3080/'])
  assert.deepEqual(extractUrls('http://127\\.0\\.0\\.1:3080/\\?token=abc'), [
    'http://127.0.0.1:3080/?token=abc',
  ])
  // an escaped colon and an escaped scheme separator unescape too
  assert.deepEqual(extractUrls('http\\:\\/\\/127\\.0\\.0\\.1\\:3080/'), ['http://127.0.0.1:3080/'])
  assert.equal(normUrl('http://127.0.0.1:3080/', {}).host, '127.0.0.1')

  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  const allowed = [
    "grep -oE 'http://127\\.0\\.0\\.1:3080/\\?token=[A-Za-z0-9_-]+'",
    'curl -s http://127\\.0\\.0\\.1:3080/\\?token=abc',
    'grep -rn http://192\\.168\\.111\\.90:3080/healthz /var/log',
  ]
  for (const command of allowed) {
    assert.equal(verdict(guards, bash(command)), undefined, `must be allowed: ${command}`)
  }

  // The escape is unescaped, not ignored: an escaped REMOTE address is still remote.
  // `curl` is the verb here on purpose — `grep` is exempt (T48f), so a grep carrying a
  // remote URL would be allowed and would prove nothing about the classification.
  const refused = [
    'curl -s https://api\\.example\\.com/v1/x',
    'wget -q https://api\\.example\\.com/v1/x',
  ]
  for (const command of refused) {
    assert.equal(typeof verdict(guards, bash(command)), 'string', `must be blocked: ${command}`)
  }
  // …and the same address in the same escaped spelling is simply an address, so a verb
  // that CAN fetch is refused whether or not the shell escaped it.
  assert.equal(isLocalHost(normUrl('https://api.example.com/v1/x', {}).host), false)
})

test('T48d: a bracketed IPv6 literal is judged by its address, not its brackets', () => {
  // `URL.hostname` keeps an IPv6 literal's brackets, and the locality test compared
  // `[::1]` against `::1` — so `curl http://[::1]:8080/` was refused, while the
  // refusal message told the operator that `::1` is exempt. The message was lying.
  // Every IPv6 URL carries brackets, so this was the ONLY spelling that reached the
  // classifier and it was the one spelling that failed.
  for (const [host, local] of [
    ['http://[::1]:3080/', true],
    ['http://[0:0:0:0:0:0:0:1]:3080/', true],
    ['http://[fe80::1]:8080/', true],
    ['http://[fd00::1]:8080/', true],
    ['http://[2001:db8::1]:8080/', false],
  ]) {
    assert.equal(isLocalHost(normUrl(host, {}).host), local, host)
  }
  // The brackets are dropped from the identity itself, not only from the decision, so
  // the `host:` measure and `site:` cannot see two spellings of one address.
  assert.equal(normUrl('http://[::1]:3080/x', {}).host, '::1')
  assert.equal(isLocalHost('[::1]'), true, 'a raw bracketed host is accepted too')

  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  for (const command of ['curl -s http://[::1]:3080/healthz', 'curl -s http://[fe80::1]/x']) {
    assert.equal(verdict(guards, bash(command)), undefined, `must be allowed: ${command}`)
  }
  assert.equal(typeof verdict(guards, bash('curl -s http://[2001:db8::1]:8080/x')), 'string')
})

test('T48e: unescaping a URL does not rewrite anything else in the command', () => {
  // The unescape runs on the copy the URL pattern reads, and only before the handful of
  // characters a URL contains. A Windows path separator and a line continuation are the
  // two backslashes that must survive, because both are ordinary shell text.
  assert.deepEqual(extractUrls('cd C:\\dir\\file.txt; ls'), [])
  assert.deepEqual(extractUrls('curl \\\n  https://example.com/x'), ['https://example.com/x'])
  // A dot before a non-URL token is still not a URL.
  assert.deepEqual(extractUrls('sed -e "s/\\./X/g" file.txt'), [])
  // And a command with no URL at all is unchanged.
  assert.deepEqual(extractUrls('ls -la /tmp'), [])
})

test('T48f: a PATTERN-POSITION tool is exempt, and the residual is asserted', () => {
  // `grep` takes a regex as its primary argument, so a URL inside a grep command is a
  // pattern being searched for, not a destination. Exempting it is not a grant of network
  // access — grep has none — and refusing it does not redirect a fetch, it blocks a read.
  // The refusal message would also be FALSE: it states that the call fetches over HTTP.
  const { ctx, guards } = fakeCtx({ web: true })
  apply(ctx, {})
  const allowed = [
    "grep -rn 'https://api.example.com/v1/x' config/",
    "rg 'https://api.example.com/v1/x' config/",
    "grep -c http://example.com/index.html /var/log/access.log",
    "cat access.log | grep -oE 'https://[a-z]+\\\\.example\\\\.com/' | sort | uniq -c",
  ]
  for (const command of allowed) {
    assert.equal(verdict(guards, bash(command)), undefined, `must be allowed: ${command}`)
  }

  // The exemption is PER SEGMENT, so a grep in the same command as a real fetch does not
  // launder it: the curl segment carries its own address and is refused on its own.
  const refused = [
    "grep -rn 'https://api.example.com/x' f && curl -s https://api.example.com/y",
    "rg 'https://api.example.com/x' f; wget -q https://api.example.com/y",
  ]
  for (const command of refused) {
    assert.equal(typeof verdict(guards, bash(command)), 'string', `must be blocked: ${command}`)
  }

  // The line is PATTERN POSITION, not "any verb without a network stack". `echo` is NOT
  // exempt, because the corpus contains commands where an echo merely PRINTS a URL that a
  // later segment downloads — there the exemption would swallow a real fetch. Measured
  // with tools/allowlist-candidate-scan.mjs: every `echo`/`head` refusal that would flip
  // to allowed also names a downloader.
  assert.equal(typeof verdict(guards, bash("echo 'https://api.example.com/x'")), 'string')

  // KNOWN RESIDUAL, asserted rather than pretended (the sibling of T47b). This one IS new:
  // with grep exempt, the only segment carrying an address is the grep, so letting a
  // downloader consume it through a pipe slips past the URL rule — and `xargs` is not an
  // HTTP verb, so it slips past the no-URL rule too. The block is a steering mechanism
  // rather than a containment boundary, and this is the price of not refusing a read.
  assert.equal(verdict(guards, bash("grep -oE 'https://api.example.com/x' f | xargs curl -s")), undefined)
  assert.equal(verdict(guards, bash("rg 'https://api.example.com/x' f | xargs wget -q -O -")), undefined)

  // The neighbouring variable form is NOT a residual: it is refused, and by the OTHER
  // clause. The command names an HTTP verb while carrying no literal URL, so the rule
  // falls back to the string's own first verb — `U=$(grep`, which is in nobody's list.
  // Worth asserting, because it is the clause that keeps the pipe above narrow.
  const indirect = verdict(guards, bash("U=$(grep -oE 'https://api.example.com/x' f); curl -s \"$U\""))
  assert.equal(typeof indirect, 'string')
  assert.match(indirect, /SHELL_HTTP_BLOCKED/)
})

test('T49: the block is a flat refusal — it never asks, and it fires on the FIRST call', () => {
  const { ctx, guards, handlers } = fakeCtx({ web: true })
  apply(ctx, { onLimit: 'ask' })
  // First call, no count behind it: a flat deny, not an escalation.
  const out = verdict(guards, bash('curl -s https://weather.gc.ca/x'))
  assert.equal(typeof out, 'string')
  assert.match(out, /stopped before executing/)
  assert.doesNotMatch(out, /REPEAT_TOOL_BLOCKED/, 'that is the escalation gate, not this')
  assert.ok(handlers.get('tools/pre-execute') !== undefined)
})

test('T50: FAIL-SAFE — no replacement tool means no block', () => {
  // Refusing a fetch when the replacement is absent is not a redirect, it is a lost
  // capability: the network, gone. So a profile without `ctx.web` must keep shell HTTP.
  const noWeb = fakeCtx()
  apply(noWeb.ctx, {})
  for (const command of ['curl -s https://weather.gc.ca/x', 'wget -q -O - https://x.example.com/']) {
    assert.equal(verdict(noWeb.guards, bash(command)), undefined, `must NOT block without the tool: ${command}`)
  }

  // With the service present the tool registers, and the same call is then refused —
  // and the denial names the tool, because the guard only blocks when it exists.
  const withWeb = fakeCtx({ web: true })
  apply(withWeb.ctx, {})
  assert.equal(withWeb.registered.length, 1, 'the tool must register')
  assert.equal(withWeb.registered[0].name, 'web_fetch_file')
  const denial = verdict(withWeb.guards, bash('curl -s https://weather.gc.ca/x'))
  assert.equal(typeof denial, 'string')
  assert.match(denial, /Use `web_fetch_file` instead/)
  assert.match(denial, /1\. web_fetch_file\(url\)/, 'the two-step shape must be spelled out')
  assert.match(denial, /still work/, 'and it must say what still works')
})

test('T51: the block is configurable, and off is genuinely off', () => {
  const off = fakeCtx({ web: true })
  apply(off.ctx, { blockShellHttp: false })
  for (const command of [
    'curl -s https://weather.gc.ca/x',
    'python3 -c "import urllib.request;urllib.request.urlopen(\'https://x/\')"',
  ]) {
    assert.equal(verdict(off.guards, bash(command)), undefined, `unblocked when off: ${command}`)
  }

  // `blockLocalHttp` is the switch that gives the capability up deliberately.
  const strict = fakeCtx({ web: true })
  apply(strict.ctx, { blockLocalHttp: true })
  assert.equal(typeof verdict(strict.guards, bash('curl -s http://127.0.0.1:3080/')), 'string')

  // An empty allowlist stops exempting package managers.
  const noAllow = fakeCtx({ web: true })
  apply(noAllow.ctx, { shellHttpAllow: [] })
  assert.equal(typeof verdict(noAllow.guards, bash('git clone https://github.com/a/b /tmp/b')), 'string')
})

test('T52: a blocked fetch is not counted as a failure of the model', () => {
  // The guard refuses the call, so nothing ran. If the failure track counted its own
  // refusal, the block would feed the gate and the model would be punished for a
  // call that never happened.
  const { ctx, guards, handlers } = fakeCtx({ web: true })
  apply(ctx, { onLimit: 'deny' })
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  return (async () => {
    for (let i = 0; i < 6; i += 1) {
      const exec = bash('curl -s https://weather.gc.ca/x')
      const denial = guards[0](exec)
      assert.equal(typeof denial, 'string')
      await post(exec, { isError: true, content: [{ type: 'text', text: denial }] }, noop)
    }
    // A different, allowed call still behaves normally.
    const ok = bash('echo hello')
    assert.equal(guards[0](ok), undefined)
  })()
})

test('T53: the block honours the fail-loud configuration contract', () => {
  assert.throws(() => validateCfg(mergeDefaults({ blockShellHttp: 'yes' })), /blockShellHttp/)
  assert.throws(() => validateCfg(mergeDefaults({ blockLocalHttp: 1 })), /blockLocalHttp/)
  assert.throws(() => validateCfg(mergeDefaults({ shellHttpAllow: 'git' })), /shellHttpAllow/)
  assert.deepEqual(DEFAULTS.shellHttpAllow.filter((v) => v === 'git'), ['git'])
})
