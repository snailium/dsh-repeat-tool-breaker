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
