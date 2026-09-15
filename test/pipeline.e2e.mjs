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

const bodies = []

const ctx = new Context()
// ToolRuntime declares `static inject = ['systemPrompt']`, so the prompt service
// has to exist before the tool registry will construct.
ctx.plugin(systemPrompt.default)
await new Promise((resolve) => setTimeout(resolve, 20))
ctx.plugin(tools.ToolRuntime)
await new Promise((resolve) => setTimeout(resolve, 20))
ctx.plugin(breaker)
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

const text = (result) => result.content.map((block) => block.text ?? '').join('\n')

const agent = { id: 'integration-agent' }
const first = await call(
  { command: 'curl -s --max-time 20 -o /tmp/probe.html https://example.com/', description: '1st', timeoutMs: 60000 },
  agent,
)
const second = await call(
  { command: 'curl -s --max-time 20 -o /tmp/probe.html https://example.com/', description: '2nd', timeoutMs: 30000 },
  agent,
)
const third = await call({ command: 'ls -la /tmp', description: '3rd' }, agent)

// The user's real loop: four curl calls alternating the host spelling and the
// timeout, all into one output file, on a FRESH agent.
const looper = { id: 'ping-pong-agent' }
const pingPong = []
for (const [description, command] of [
  ['1st', 'curl -s --max-time 60 -o /workspace/od.bin "https://open-data.canada.ca/x"'],
  ['2nd', 'curl -s --max-time 30 -o /workspace/od.bin "https://open.canada.ca/x"'],
  ['3rd', 'curl -sS --max-time 45 -o /workspace/od.bin "https://www.open-data.canada.ca/x"'],
  ['4th', 'curl -s --max-time 15 -o /workspace/od.bin "https://open.canada.ca/x/"'],
]) {
  const result = await call({ command, description, timeoutMs: 60000 }, looper)
  pingPong.push({ description, isError: result.isError, head: text(result).split('\n')[0].slice(0, 110) })
}

console.log(
  JSON.stringify(
    {
      first: { isError: first.isError, text: text(first).slice(0, 120) },
      second: { isError: second.isError, text: text(second) },
      third: { isError: third.isError, text: text(third).slice(0, 120) },
      pingPong,
      bodiesInvoked: bodies,
    },
    null,
    2,
  ),
)

const ok =
  first.isError === false &&
  second.isError === true &&
  text(second).startsWith('Error: REPEAT_TOOL_BLOCKED') &&
  third.isError === false &&
  bodies.length === 3 &&
  pingPong[0].isError === false &&
  pingPong.slice(1).every((entry) => entry.isError === true)

console.log(ok ? '\nPIPELINE-E2E: PASS' : '\nPIPELINE-E2E: FAIL')
process.exit(ok ? 0 : 1)
