import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchFileToolState } from '../lib/fetch-file.js'
import fetchFileComponent, {
  name as COMPONENT_NAME,
  inject as COMPONENT_INJECT,
  Config as COMPONENT_CONFIG,
  apply as applyFetchFile,
} from '../lib/fetch-file-component.js'
import { apply as applyBreaker } from '../index.js'

function fakeCtx(options = {}) {
  const registered = []
  const guards = []
  const events = new Map()

  return {
    registered,
    guards,
    ctx: {
      tools: {
        register: (tool) => {
          registered.push(tool)
          return () => {
            const idx = registered.indexOf(tool)
            if (idx !== -1) registered.splice(idx, 1)
          }
        },
        // The real registry answers lookups by name (`dsh-tools` NamedEntries.get), and
        // `registerFetchFileTool` uses exactly that to notice a tool the OTHER row already
        // registered. A fake without it cannot express the collision at all — which is how the
        // first version of this test passed while proving nothing.
        get: (name) => registered.find((tool) => tool.name === name),
        guard: (g) => {
          guards.push(g)
          return () => {
            const idx = guards.indexOf(g)
            if (idx !== -1) guards.splice(idx, 1)
          }
        },
      },
      on: (event, handler) => {
        if (!events.has(event)) events.set(event, [])
        events.get(event).push(handler)
        return () => {
          const list = events.get(event)
          const idx = list.indexOf(handler)
          if (idx !== -1) list.splice(idx, 1)
        }
      },
      inject: (deps, callback) => {
        if (options.web) callback({ web: {} })
      },
      get: (service) => (service === 'web' && options.web ? {} : undefined),
    },
  }
}

function bash(command) {
  return {
    name: 'bash',
    arguments: { command },
    agent: {},
  }
}

function verdict(guards, exec) {
  for (const guard of guards) {
    const res = guard(exec)
    if (res !== undefined) return res
  }
  return undefined
}

test('web-fetch-file: exports expected Cordis component interface', () => {
  assert.equal(COMPONENT_NAME, 'web-fetch-file')
  assert.deepEqual(COMPONENT_INJECT, ['tools'])
  assert.equal(typeof applyFetchFile, 'function')
  assert.ok(COMPONENT_CONFIG, 'Config schema must be exported')
  assert.equal(fetchFileComponent.name, 'web-fetch-file')
  assert.equal(fetchFileComponent.Config, COMPONENT_CONFIG)
})

test('web-fetch-file: apply registers tool and teardown unregisters cleanly', () => {
  const env = fakeCtx()
  assert.equal(fetchFileToolState.registered, false)

  const teardown = applyFetchFile(env.ctx, { fetchWithCurl: true })
  assert.equal(env.registered.length, 1)
  assert.equal(env.registered[0].name, 'web_fetch_file')
  assert.equal(fetchFileToolState.registered, true)

  teardown()
  assert.equal(env.registered.length, 0)
  assert.equal(fetchFileToolState.registered, false)
})

test('component decoupling: repeat-tool-breaker with embedFetchFile: false coordinates with web-fetch-file', () => {
  const env = fakeCtx()

  // 1. Mount breaker alone with embedFetchFile: false
  const breakerTeardown = applyBreaker(env.ctx, { embedFetchFile: false })
  assert.equal(env.registered.length, 0, 'breaker must not register web_fetch_file when embedFetchFile is false')

  // Since web_fetch_file is not registered, shell HTTP must NOT be blocked (fail-safe)
  const cmd = 'curl -s https://example.com/data.json'
  assert.equal(verdict(env.guards, bash(cmd)), undefined, 'must allow shell HTTP while tool is absent')

  // 2. Mount web-fetch-file component
  const fetchTeardown = applyFetchFile(env.ctx, { fetchWithCurl: true })
  assert.equal(env.registered.length, 1)
  assert.equal(env.registered[0].name, 'web_fetch_file')

  // Now that the tool is available, breaker actively blocks shell HTTP and redirects to it
  const blocked = verdict(env.guards, bash(cmd))
  assert.equal(typeof blocked, 'string')
  assert.match(blocked, /Use `web_fetch_file` instead/)

  // 3. Turn off web-fetch-file component
  fetchTeardown()
  assert.equal(env.registered.length, 0)

  // Fail-safe immediately reactivates: shell HTTP is permitted again
  assert.equal(verdict(env.guards, bash(cmd)), undefined, 'must safely allow shell HTTP once tool component is unmounted')

  breakerTeardown()
})


test('component decoupling: the DEFAULT breaker config does not register the tool', () => {
  // The bundle declares the dedicated row, so the default is NOT to embed. A profile patch that
  // reconfigures the breaker row (warnAt, failWarnAt) used to drop the bundle's explicit
  // `embedFetchFile: false` and put the embed back, which is how the collision below was reached
  // in a real instance.
  const env = fakeCtx()

  const breakerTeardown = applyBreaker(env.ctx, {})
  assert.equal(env.registered.length, 0, 'the default mount must leave the tool to its own row')

  const fetchTeardown = applyFetchFile(env.ctx, { fetchWithCurl: true })
  assert.equal(env.registered.length, 1, 'exactly one registration across both rows')
  assert.equal(env.registered[0].name, 'web_fetch_file')

  const blocked = verdict(env.guards, bash('curl -s https://example.com/data.json'))
  assert.equal(typeof blocked, 'string', 'once the dedicated row provides the tool, the block runs')

  // And a breaker that ALSO embeds (the standalone mount) must not collide with the row.
  const env2 = fakeCtx()
  const standalone = applyBreaker(env2.ctx, { embedFetchFile: true })
  assert.equal(env2.registered.length, 1)
  const second = applyFetchFile(env2.ctx, { fetchWithCurl: true })
  assert.equal(env2.registered.length, 1, 'the later registrant stands down instead of throwing')
  second()
  standalone()
  breakerTeardown()
  fetchTeardown()
})
