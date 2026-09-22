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
  const dispose = apply(ctx, {})
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

test('T14: shipped defaults are the 0.4.0 table', () => {
  assert.equal(DEFAULTS.window, 16)
  assert.deepEqual(DEFAULTS.limits, {
    exact: 9,
    cmd: 9,
    net: 9,
    sink: 9,
    host: 9,
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
  assert.equal(DEFAULTS.warnAt, 3)
  assert.equal(DEFAULTS.summarizeAt, 6)
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
  for (let n = 1; n <= 8; n += 1) {
    const { hits, fps } = run(tracker, page(n))
    assert.deepEqual(hits, [], `page ${n} must be allowed`)
    assert.equal(fps.filter((fp) => fp.startsWith('net:')).length, 1, 'one net: fingerprint per call')
  }

  // Eight DISTINCT pages never collide on `net:` — the 0.3.2 guarantee, and it still
  // holds: the query is part of the fingerprint, so `?page=2` is a different
  // resource from `?page=1`.
  //
  // They are, however, eight requests to ONE host, so `host:` has reached 8 and the
  // next call to that host is the cap-th. That is the DESIGN, not a leftover of 0.3.2:
  // `net:` stops punishing pagination, and `host:` bounds how many requests one target
  // receives — with stage 1 at 3 and stage 2 at 6 underneath, where a paging model is
  // told to use a larger per-batch amount instead of walking many small ones. A model
  // that takes that advice finishes well under the gate; one that ignores it is exactly
  // what the gate is for. The advice is deliberately backend-agnostic — the same shape
  // appears when an agent reads a file line by line.
  const ninth = run(tracker, page(9))
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
  apply(ctx, { onLimit: 'deny', localHosts: 'deny' })
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

test('T24: the three stages fire at 3, 6 and 9 on one measure', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  // onLimit: deny isolates the two advisory stages from the gate.
  apply(ctx, { onLimit: 'deny' })
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
  assert.equal(at(2).advisory, '')
  assert.match(at(3).advisory, /^CONVERGENCE_CHECK: you are repeating yourself/, 'stage 1 at 3')
  assert.equal(at(4).advisory, '', 'the stage fires once per crossing, not on every later call')
  assert.equal(at(5).advisory, '')
  assert.match(at(6).advisory, /summarise your progress/, 'stage 2 at 6')
  assert.match(at(6).advisory, /larger per-batch amount/, 'and it names the batching lever')
  assert.doesNotMatch(
    at(6).advisory,
    /paging|per_page|page size/i,
    'the advice must stay backend-agnostic: the same failure shows up reading a file line by line',
  )
  assert.equal(at(7).advisory, '')
  assert.equal(at(8).advisory, '')
  assert.equal(at(9).denied, true, 'the cap-th call is the gate')
  assert.match(at(9).denial, /REPEAT_TOOL_BLOCKED/)
  assert.doesNotMatch(at(9).denial, /budget/i, 'no invented budget figure')
  // No advisory message may look like a tool-call template.
  for (const entry of observed) {
    assert.doesNotMatch(entry.advisory, /<tool_call>|<function=/, 'no template-looking text')
  }
})

test('T27: a disabled stage is simply never delivered', async () => {
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, { onLimit: 'deny', warnAt: 0, summarizeAt: null })
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
  apply(ctx, { onLimit: 'ask' })
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
  apply(ctx, { onLimit: 'ask' })
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
  apply(ctx, { onLimit: 'ask' })
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
  apply(ctx, { onLimit: 'ask' })
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
  apply(ctx, {})
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const agent = { id: 'uncapped-agent' }

  // Six DIFFERENT urls: `verb:curl` and `family:http-fetch` climb to 6, but both are
  // null-capped, so nothing may be delivered.
  for (let i = 1; i <= 6; i += 1) {
    const exec = bash(`curl -s https://host${i}.example.com/p`)
    guards[0](exec)
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    assert.equal(decision?.additionalContexts, undefined, `no advisory may fire on call ${i}`)
  }

  // A CAP the operator turns ON makes the same measure escalate.
  const on = fakeCtx()
  apply(on.ctx, { limits: { 'verb:curl': 9 } })
  const onPost = on.handlers.get('tools/post-execute')
  const agent2 = { id: 'capped-agent' }
  const seen = []
  for (let i = 1; i <= 3; i += 1) {
    const exec = bash(`curl -s https://host${i}.example.com/p`)
    on.guards[0](exec)
    const decision = await onPost(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    for (const message of decision?.additionalContexts ?? []) seen.push(message.content[0].text)
  }
  assert.equal(seen.length, 1, 'the now-capped verb escalates exactly once, at 3')
  assert.match(seen[0], /verb:curl has come up 3 times/)
})

test('T29: when several measures cross together, the message names the useful one', async () => {
  // Identical calls cross `exact:`, `net:`, `site:` and `host:` at the same count.
  // Naming `exact:` quotes a truncated command line; the target is what the model can
  // act on.
  const { ctx, guards, handlers } = fakeCtx()
  apply(ctx, {})
  const post = handlers.get('tools/post-execute')
  const noop = async () => ({ kind: 'allow' })
  const agent = { id: 'tie-agent' }
  const command = 'curl -s "https://api.example.com/v1/items?page=1"'
  const seen = []
  for (let i = 1; i <= 3; i += 1) {
    const exec = bash(command)
    guards[0](exec)
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, noop)
    for (const message of decision?.additionalContexts ?? []) seen.push(message.content[0].text)
  }
  assert.equal(seen.length, 1)
  assert.match(seen[0], /host:api\.example\.com has come up 3 times/, `named: ${seen[0].split('\n')[0]}`)
  assert.doesNotMatch(seen[0], /exact:bash/, 'must not dump the command line')
})
