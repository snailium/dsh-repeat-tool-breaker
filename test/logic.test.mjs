// Self-contained deterministic harness for dsh-repeat-tool-breaker's pure guard
// logic. It stubs just enough of cordis to drive apply(): ctx.tools.guard,
// ctx.on('tools/post-execute'), and ctx.on('agent/pre-step').
import mod from '../index.js'

const { name, inject, apply } = mod

function makeFakeResult(text) {
  return { isError: false, content: [{ type: 'text', text }], value: { ok: true }, meta: undefined }
}
// Stable per-agent objects so the plugin's WeakMap<agent,…> state persists
// across calls for the same logical agent — exactly how the real loop passes the
// same live Agent instance every time.
const agents = new Map()
function agentFor(key) {
  let a = agents.get(key)
  if (!a) {
    a = { __k: key }
    agents.set(key, a)
  }
  return a
}

function makeFakeExec(toolName, args, agentKey) {
  // Minimal stand-in for the fields the plugin reads: name, arguments, agent.
  return { name: toolName, arguments: args, agent: agentFor(agentKey) }
}

function makeCtx() {
  const listeners = {
    'tools/post-execute': null,
    'agent/pre-step': null,
  }
  const guardFnRef = { current: null }
  const fakeCtx = {
    tools: {
      guard(fn) {
        guardFnRef.current = fn
        return () => {
          guardFnRef.current = null
        }
      },
    },
    on(event, cb) {
      listeners[event] = cb
      return () => {
        listeners[event] = null
      }
    },
  }
  return { fakeCtx, guardFnRef, listeners }
}

// Drive one call. Returns { verdict: 'allowed'|'denied', reason? , decision }.
async function runCall(ctx, listener, guardFn, exec, result) {
  if (guardFn.current) {
    const reason = guardFn.current(exec)
    if (reason !== undefined) return { verdict: 'denied', reason }
  }
  if (listener['tools/post-execute']) {
    const decision = await listener['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }))
    return { verdict: 'allowed', decision }
  }
  return { verdict: 'allowed', decision: null }
}

function agentPreStepReset(fakeCtx, listeners, agentKey, addUser) {
  const cb = listeners['agent/pre-step']
  if (cb) cb({ agent: agentFor(agentKey), messages: [{ source: { kind: addUser ? 'user' : 'model' } }] }, () => {})
}

let pass = 0
let fail = 0
function check(label, cond) {
  if (cond) {
    pass++
    console.log(`  ok: ${label}`)
  } else {
    fail++
    console.log(`FAIL: ${label}`)
  }
}

const { fakeCtx, guardFnRef, listeners } = makeCtx()
const dispose = apply(fakeCtx, {})

console.log(`plugin name: ${name}; inject: ${JSON.stringify(inject)}`)
check('guard registered', typeof guardFnRef.current === 'function')

// --- Scenario 1: 1st identical read allowed, 2nd identical read denied ---
let r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { path: 'a.ts', limit: 20 }, 'A1'),
  makeFakeResult('contents of a.ts: const x = 1'),
)
check('read#1 allowed', r.verdict === 'allowed')

r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { path: 'a.ts', limit: 20 }, 'A1'),
  makeFakeResult('contents of a.ts: const x = 1'),
)
check('read#2 identical DENIED', r.verdict === 'denied')
check('deny mentions REPEAT_TOOL_BLOCKED', (r.reason || '').includes('REPEAT_TOOL_BLOCKED'))
check('deny references prior result summary', (r.reason || '').includes('const x = 1'))
check('deny names tool read', (r.reason || '').includes('read'))

// --- Scenario 2: property order insensitive => still denied ---
r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { limit: 20, path: 'a.ts' }, 'A1'),
  makeFakeResult('x'),
)
check('key-order-insensitive: #3 (a.ts) still DENIED', r.verdict === 'denied')

// --- Scenario 3: different path allowed ---
r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { path: 'b.ts' }, 'A1'),
  makeFakeResult('contents of b.ts'),
)
check('read b.ts allowed (different args)', r.verdict === 'allowed')

// --- Scenario 4: different tool (write family) blocked identically too ---
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('write', { path: 'c.ts', content: 'x' }, 'A1'), makeFakeResult('wrote c.ts'))
check('write#1 allowed', r.verdict === 'allowed')
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('write', { path: 'c.ts', content: 'x' }, 'A1'), makeFakeResult('wrote c.ts'))
check('write#2 identical DENIED', r.verdict === 'denied')

// --- Scenario 5: todo_write excluded => never denied, does not reset chain ---
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('todo_write', { items: ['a'] }, 'A1'), makeFakeResult('ok'))
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('todo_write', { items: ['a'] }, 'A1'), makeFakeResult('ok'))
check('todo_write repeated twice never denied', r.verdict === 'allowed')
// todo_write isolated from read chain: read d.ts now fresh
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('read', { path: 'd.ts' }, 'A1'), makeFakeResult('d1'))
check('read d.ts after todo_write repeated is treated fresh (allowed)', r.verdict === 'allowed')

// --- Scenario 6: per-agent isolation ---
r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { path: 'a.ts' }, 'B2'),
  makeFakeResult('b-agent sees a.ts'),
)
check('different agent read a.ts allowed (per-agent state)', r.verdict === 'allowed')
r = await runCall(
  fakeCtx,
  listeners,
  guardFnRef,
  makeFakeExec('read', { path: 'a.ts' }, 'B2'),
  makeFakeResult('b-agent sees a.ts'),
)
check('different agent 2nd identical read a.ts DENIED', r.verdict === 'denied')

// --- Scenario 7: user message resets the chain ---
agentPreStepReset(fakeCtx, { ...listeners }, 'B2', true)
r = await runCall(fakeCtx, listeners, guardFnRef, makeFakeExec('read', { path: 'a.ts' }, 'B2'), makeFakeResult('b again'))
check('after user message, same read allowed again', r.verdict === 'allowed')

// --- Scenario 8: same-path cap for varying args (readTools) ---
// Reset agent (fresh chain) then read same path with 4 different limits.
agentPreStepReset(fakeCtx, { ...listeners }, 'C3', true)
const cap = 3
for (let i = 1; i <= cap + 1; i++) {
  r = await runCall(
    fakeCtx,
    listeners,
    guardFnRef,
    makeFakeExec('read', { path: 'same.ts', limit: i }, 'C3'),
    makeFakeResult(`contents ${i}`),
  )
  if (i < cap) {
    check(`varying read same.ts #${i} allowed`, r.verdict === 'allowed')
  } else if (i === cap) {
    check(`varying read same.ts #${cap} allowed (cap met at next)`, r.verdict === 'allowed')
  } else {
    check(`varying read same.ts #${i} DENIED by same-path cap`, r.verdict === 'denied')
    check('path deny mentions name same.ts', (r.reason || '').includes('same.ts'))
  }
}

dispose()
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
