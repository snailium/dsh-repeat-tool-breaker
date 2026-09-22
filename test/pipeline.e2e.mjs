/**
 * Real-pipeline check: drives the GENUINE `@deepseek-ai/dsh-tools` ToolRuntime —
 * the same pre-execute → guard → execute → post-execute pipeline a live agent
 * uses — with a registered `bash` tool whose body records every invocation.
 *
 * Unlike `npm test`, this needs the dsh packages to be resolvable, so it is NOT
 * part of the CI suite. Run it manually:
 *
 *   DSH_NODE_MODULES=/path/to/@deepseek-ai/dsh/node_modules/@deepseek-ai \
 *     node test/pipeline.e2e.mjs
 *
 * (`DSH_NODE_MODULES` is the directory that contains `dsh-tools/`,
 * `dsh-system-prompt/`, and `cordis/`.) With no packages available the script
 * exits 0 with SKIPPED, so it is safe to wire into a script that may not have
 * them.
 *
 * What it proves, with no model and no LLM endpoint involved — the tool body is
 * a stub, so it runs anywhere, including offline:
 *
 *   1. a first call is ALLOWED and its body IS invoked;
 *   2. a second call that differs only in `description`/`timeoutMs` is DENIED by
 *      the guard, and its body is NEVER invoked;
 *   3. an unrelated command is ALLOWED;
 *   4. the user's real loop — four `curl` calls alternating the host spelling and
 *      the `--max-time` value into the same output file — is denied from the
 *      second call onwards.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECT = new URL('..', import.meta.url).href

async function loadDsh() {
  const roots = []
  if (process.env.DSH_NODE_MODULES) roots.push(process.env.DSH_NODE_MODULES)
  const specs = [
    ...roots.map((root) => pathToFileURL(join(root, 'cordis/lib/index.js')).href),
    '@deepseek-ai/cordis',
  ]
  let cordis = null
  for (const spec of specs) {
    try {
      cordis = await import(spec)
      break
    } catch {
      /* try the next candidate */
    }
  }
  const toolSpecs = [
    ...roots.map((root) => pathToFileURL(join(root, 'dsh-tools/lib/index.js')).href),
    '@deepseek-ai/dsh-tools',
  ]
  const promptSpecs = [
    ...roots.map((root) => pathToFileURL(join(root, 'dsh-system-prompt/lib/index.js')).href),
    '@deepseek-ai/dsh-system-prompt',
  ]
  let tools = null
  let systemPrompt = null
  for (const spec of toolSpecs) {
    try {
      tools = await import(spec)
      break
    } catch {
      /* try the next candidate */
    }
  }
  for (const spec of promptSpecs) {
    try {
      systemPrompt = await import(spec)
      break
    } catch {
      /* try the next candidate */
    }
  }
  return cordis && tools && systemPrompt ? { cordis, tools, systemPrompt } : null
}

const loaded = await loadDsh()
if (loaded === null) {
  console.log('SKIPPED: @deepseek-ai/cordis, dsh-tools and dsh-system-prompt are not resolvable.')
  console.log('Set DSH_NODE_MODULES=/path/to/dsh/node_modules/@deepseek-ai to run this check.')
  process.exit(0)
}

const { Context } = loaded.cordis
const tools = loaded.tools
const systemPrompt = loaded.systemPrompt
const breaker = await import(`${PROJECT}index.js`)

const { DEFAULTS } = await import(`${PROJECT}lib/defaults.js`)
/** The cap is read from the plugin's own defaults, so a retuned cap is tracked. */
const CAP = DEFAULTS.limits.exact

/**
 * Build a fresh runtime with the breaker applied at `config`.
 * @param config - plugin config for this run.
 * @returns `{ bodies, call }` — the commands that actually executed, and a caller.
 */
async function makeRuntime(config) {
  const bodies = []
  const ctx = new Context()
  // ToolRuntime declares `static inject = ['systemPrompt']`, so the prompt service
  // has to exist before the tool registry will construct.
  ctx.plugin(systemPrompt.default)
  await new Promise((resolve) => setTimeout(resolve, 20))
  ctx.plugin(tools.ToolRuntime)
  await new Promise((resolve) => setTimeout(resolve, 20))
  ctx.plugin(breaker, config)
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (ctx.tools === undefined) throw new Error('ToolRuntime did not register on ctx.tools')

  ctx.tools.register(
    tools.defineTool({
      name: 'bash',
      description: 'run a shell command',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        bodies.push(args.command)
        return `ran: ${args.command}`
      },
    }),
  )

  let callId = 0
  const call = (args, agent) =>
    ctx.tools.execute({
      callId: `call-${(callId += 1)}`,
      name: 'bash',
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
  return { bodies, call }
}

const text = (result) => result.content.map((block) => block.text ?? '').join('\n')

/**
 * Run the whole scenario against a fresh runtime and report whether every
 * invariant held.
 * @param label - how to name this run in the report.
 * @param config - plugin config.
 * @param denialFragment - a substring the blocked call's text must contain.
 * @returns whether the scenario passed.
 */
async function scenario(label, config, denialFragment) {
  const { bodies, call } = await makeRuntime(config)
  const agent = { id: 'integration-agent' }
  const sameResults = []
  for (let i = 0; i < CAP; i += 1) {
    sameResults.push(
      await call(
        {
          command: 'curl -s --max-time 20 -o /tmp/probe.html https://example.com/',
          description: `attempt ${i + 1}`,
          timeoutMs: 1000 * (i + 1),
        },
        agent,
      ),
    )
  }
  const unrelated = await call({ command: 'ls -la /tmp', description: 'unrelated' }, agent)

  // The user's real loop: cycling the host spelling and the timeout into one output
  // file, on a FRESH agent. It runs CAP rounds so the cap-th is exercised — the
  // cycle length must NOT be tied to the cap, which is the bug this harness had
  // when the cap moved from 5 to 9.
  const looper = { id: 'ping-pong-agent' }
  const SPELLINGS = [
    ['1st', 'curl -s --max-time 60 -o /workspace/od.bin "https://open-data.canada.ca/x"'],
    ['2nd', 'curl -s --max-time 30 -o /workspace/od.bin "https://open.canada.ca/x"'],
    ['3rd', 'curl -sS --max-time 45 -o /workspace/od.bin "https://www.open-data.canada.ca/x"'],
    ['4th', 'curl -s --max-time 15 -o /workspace/od.bin "https://open.canada.ca/x/"'],
  ]
  const pingPong = []
  for (let i = 0; i < CAP; i += 1) {
    const [description, command] = SPELLINGS[i % SPELLINGS.length]
    const result = await call({ command, description, timeoutMs: 60000 }, looper)
    pingPong.push({ description, isError: result.isError, head: text(result).split('\n')[0].slice(0, 110) })
  }

  const deniedText = text(sameResults[CAP - 1])
  const ok =
    sameResults.slice(0, CAP - 1).every((r) => r.isError === false) &&
    sameResults[CAP - 1].isError === true &&
    deniedText.includes(denialFragment) &&
    unrelated.isError === false &&
    // Bodies that actually ran: (CAP-1) identical calls + the unrelated one +
    // (CAP-1) ping-pong rounds. Every denied call must have skipped its body.
    bodies.length === (CAP - 1) * 2 + 1 &&
    pingPong.slice(0, CAP - 1).every((entry) => entry.isError === false) &&
    pingPong.slice(CAP - 1).every((entry) => entry.isError === true)

  console.log(
    JSON.stringify(
      {
        scenario: label,
        config,
        cap: CAP,
        identical: sameResults.map((r, i) => ({ attempt: i + 1, isError: r.isError })),
        blockedText: deniedText.slice(0, 220),
        unrelated: { isError: unrelated.isError, text: text(unrelated).slice(0, 60) },
        pingPong: pingPong.map((entry) => [entry.description, entry.isError]),
        bodiesInvoked: bodies.length,
      },
      null,
      2,
    ),
  )
  return ok
}

// 1. The hard break, asserted exactly.
const denyOk = await scenario('onLimit=deny', { onLimit: 'deny' }, 'REPEAT_TOOL_BLOCKED')
// 2. The shipped default — `onLimit: ask` with NO approver registered, which is
//    exactly a headless profile. It must STILL block: the gate is fail-closed. The
//    model sees the approval-unavailable text rather than REPEAT_TOOL_BLOCKED, and
//    that degradation is the documented behaviour, not a leak.
const askOk = await scenario('onLimit=ask (no approver)', {}, 'about to be blocked as a repeat')

const ok = denyOk && askOk
console.log(ok ? '\nPIPELINE-E2E: PASS' : '\nPIPELINE-E2E: FAIL')
process.exit(ok ? 0 : 1)
