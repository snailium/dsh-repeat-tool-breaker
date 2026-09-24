/**
 * The client half's suite: the browser bundle that puts the card under Settings → Plugins.
 *
 * These tests are deliberately about the SEAM, not the pixels. The card renders only when
 * the Host registered the same namespace the bundle claims, and it edits only fields that
 * namespace declares — two agreements that no compiler checks, because the two halves are
 * different packages on different sides of the wire. Both are asserted here against the
 * Host's own declarations, so the halves cannot drift apart silently: a drift renders
 * nothing at all, which is exactly the failure that is expensive to notice.
 *
 * React is stubbed. The point is that the bundle's face, its registration, and its staged
 * form behave; a DOM assertion would test React, not this plugin.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DEFAULTS, mergeDefaults, validateCfg } from '../lib/defaults.js'
import { SETTINGS_NAMESPACE, buildSettingsSchema } from '../lib/settings.js'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the bundle the way the browser does. The bundle is a classic script that only
 * REGISTERS a factory behind `window.__ModuleLoader__.load`; materializing that factory is
 * what runs the module body. So the source is evaluated in a context carrying that one
 * global — no `document`, matching the guard `ensureStyles` relies on.
 *
 * @param options - `react` overrides the stub; `allowed` is the set of specifiers the
 *   factory is permitted to require, so an added dependency fails loudly here.
 * @returns the module face, its registration, and the specifiers the factory required.
 */
function loadBundle(options = {}) {
  const required = []
  const registration = { id: undefined, factory: undefined }
  // runInThisContext, not a new realm: the bundle's objects then carry the host's
  // prototypes, so a deepEqual on the values it builds compares values rather than realms.
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        registration.id = next.id
        registration.factory = next.factory
      },
    },
  }
  try {
    vm.runInThisContext(CLIENT_SOURCE, { filename: 'lib/client.js' })
  } finally {
    globalThis.window = previousWindow
  }
  assert.equal(typeof registration.factory, 'function', 'the bundle must register a factory')

  const allowed = options.allowed ?? ['react']
  const react = options.react ?? stubReact()
  const face = registration.factory((specifier) => {
    required.push(specifier)
    if (!allowed.includes(specifier)) {
      throw new Error(`client bundle required an unexpected specifier: ${specifier}`)
    }
    return react
  })
  return { face, registration, required }
}

/** The smallest React the card's hooks need. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: (effect) => {
      effect()
    },
  }
}

/**
 * A settings scope that records writes, shaped like the one the shell binds.
 *
 * @param options - `status` gates `available`; `user` is the user layer the card reads
 *   overrides from; `base` is what a reset stages back to.
 * @returns the scope plus the calls it received.
 */
function fakeScope(options = {}) {
  const calls = { set: [], unset: [], subscribed: 0 }
  let snapshot = {
    status: options.status ?? 'ready',
    writable: options.writable ?? true,
    value: options.value ?? { ...DEFAULTS },
    base: options.base ?? { ...DEFAULTS },
    user: options.user ?? {},
  }
  return {
    calls,
    snapshot: () => snapshot,
    set: async (field, value) => {
      calls.set.push([field, value])
      snapshot = { ...snapshot, user: { ...snapshot.user, [field]: value }, value: { ...snapshot.value, [field]: value } }
    },
    unset: async (field) => {
      calls.unset.push(field)
      const user = { ...snapshot.user }
      delete user[field]
      snapshot = { ...snapshot, user, value: { ...snapshot.value, [field]: snapshot.base[field] } }
    },
    subscribe: () => {
      calls.subscribed += 1
      return () => {}
    },
    getSnapshot: () => snapshot,
  }
}

/**
 * A client context that captures what `apply` claimed.
 *
 * @param scope - the scope `settingsScope.bind` should answer.
 * @returns the context plus the captured registrations and effects.
 */
function fakeClientCtx(scope) {
  const captured = { bound: undefined, effects: [], slotInjects: [], registrations: [] }
  const ctx = {
    effect(fn, label) {
      captured.effects.push(label)
      return fn()
    },
    locale: { register() {} },
    settingsScope: {
      bind({ namespace }) {
        captured.bound = namespace
        return scope
      },
    },
    slots: {
      inject(name, factory) {
        captured.slotInjects.push(name)
        return factory()
      },
      register(options, component) {
        captured.registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

test('C1: the bundle registers itself under the package name the boot graph uses', async () => {
  const { registration } = await loadBundle()
  assert.equal(registration.id, 'dsh-repeat-tool-breaker', 'the loader id must be the package name')
  assert.equal(typeof registration.factory, 'function')
})

test('C2: the module face is what the client module system requires', async () => {
  const { face } = await loadBundle()
  assert.equal(face.name, 'repeat-tool-breaker-client')
  assert.equal(typeof face.apply, 'function')
  assert.ok(Array.isArray(face.inject), 'inject must be an array of client services')
  assert.deepEqual([...face.inject].sort(), ['locale', 'settingsScope', 'slots'])
})

test('C3: react is the ONLY module the bundle requires', async () => {
  const { face, required } = loadBundle()
  const scope = fakeScope()
  const { ctx } = fakeClientCtx(scope)
  face.apply(ctx)
  // `required` is populated by the factory's own require calls, and any specifier outside
  // the allow list would already have thrown inside the factory.
  assert.deepEqual(required, ['react'], 'the module table surface must stay at react and nothing else')
})

test('C4: the claimed slot key is the namespace the Host registers', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  assert.deepEqual(captured.slotInjects, ['settings.plugin.item'])
  assert.equal(captured.registrations.length, 1)
  assert.equal(captured.registrations[0].options.name, 'settings.plugin.item')
  assert.equal(
    captured.registrations[0].options.key,
    SETTINGS_NAMESPACE,
    'a slot key that does not match the Host namespace renders nothing',
  )
  assert.equal(captured.bound, SETTINGS_NAMESPACE)
  assert.equal(typeof captured.registrations[0].component, 'function')
})

test('C5: the card edits exactly the fields the Host schema declares, and no others', async () => {
  const { face } = await loadBundle()
  const z = (await import('@deepseek-ai/schemastery')).default
  const cfg = validateCfg(mergeDefaults({}))
  const declared = Object.keys(buildSettingsSchema(z, cfg).dict ?? {})
  const edited = face.FIELD_LAYOUT.map((entry) => entry.field)
  assert.deepEqual(
    [...declared].sort(),
    [...edited].sort(),
    'the card and the namespace must expose the same fields; a mismatch silently hides a setting',
  )
})

test('C6: every field the card renders has copy, and every copy key belongs to a field', async () => {
  const { face } = loadBundle()
  const scope = fakeScope()
  let dictionaries
  const { ctx } = fakeClientCtx(scope)
  ctx.locale.register = (_ns, value) => {
    dictionaries = value
  }
  face.apply(ctx)
  assert.ok(dictionaries, 'apply must register the card dictionaries')
  assert.equal(dictionaries.en.title, 'Repeat tool breaker')
  for (const { field } of face.FIELD_LAYOUT) {
    for (const key of [field, `${field}Hint`]) {
      assert.equal(typeof dictionaries.en[key], 'string', `en is missing ${key}`)
      assert.equal(typeof dictionaries.zh[key], 'string', `zh is missing ${key}`)
    }
  }
  const fieldKeys = new Set(face.FIELD_LAYOUT.flatMap(({ field }) => [field, `${field}Hint`]))
  for (const key of Object.keys(dictionaries.en)) {
    assert.equal(typeof dictionaries.zh[key], 'string', `zh is missing ${key}`)
    if (fieldKeys.has(key)) continue
    // Chrome copy (title, save, …) is what the card renders around the fields.
    assert.equal(typeof dictionaries.en[key], 'string')
  }
})

test('C7: an edit is staged, and only a save writes it', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker
  assert.deepEqual(scope.calls.set, [], 'apply itself must write nothing')

  props.edit('warnAt', '9')
  assert.equal(store.getSnapshot().fields.warnAt.text, '9')
  assert.equal(store.getSnapshot().dirty, true)
  assert.deepEqual(scope.calls.set, [], 'staged text must not reach the Host before Save')

  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(scope.calls.set, [['warnAt', 9]])
  assert.equal(store.getSnapshot().dirty, false, 'a landed save clears the drafts')
  assert.equal(store.getSnapshot().failed, false)
})

test('C8: an invalid draft blocks the save instead of being dropped', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  props.edit('warnAt', 'seven')
  assert.equal(store.getSnapshot().fields.warnAt.invalid, true)
  assert.equal(store.getSnapshot().invalid, true)
  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(scope.calls.set.length, 0, 'the save refuses rather than writing part of the plan')
  assert.equal(store.getSnapshot().fields.warnAt.text, 'seven', 'the draft survives for correction')
})

test('C9: discard drops the drafts and leaves the Host untouched', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  props.edit('failLimit', '8')
  assert.equal(store.getSnapshot().dirty, true)
  props.discard()
  assert.equal(store.getSnapshot().dirty, false)
  assert.equal(store.getSnapshot().fields.failLimit.text, String(DEFAULTS.failLimit))
  assert.deepEqual(scope.calls.set, [])
})

test('C10: reset stages a clear so the field re-inherits the composition layer', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope({ user: { warnAt: 9 }, value: { ...DEFAULTS, warnAt: 9 } })
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  assert.equal(store.getSnapshot().fields.warnAt.overridden, true, 'the user layer carries it')
  props.resetField('warnAt')
  assert.equal(store.getSnapshot().fields.warnAt.text, String(DEFAULTS.warnAt), 'reset shows the composed default')
  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(scope.calls.unset, ['warnAt'], 'reset clears the user-layer entry rather than writing the default')
})

test('C11: a comma list is normalized, so the control can be typed loosely', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  props.edit('shellHttpAllow', ' git , docker ,git,  ')
  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(scope.calls.set, [['shellHttpAllow', ['git', 'docker']]])
})

test('C12: a boolean field renders the literal the settings document uses', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  assert.equal(store.getSnapshot().fields.blockShellHttp.text, String(DEFAULTS.blockShellHttp))
  props.edit('blockShellHttp', 'false')
  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(scope.calls.set, [['blockShellHttp', false]])
})

test('C13: the card renders nothing until the Host serves the namespace', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope({ status: 'loading' })
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const options = captured.registrations[0].options
  const props = options.inject()
  const store = props.hooks.repeatToolBreaker

  assert.equal(store.getSnapshot().available, false)
  const rendered = captured.registrations[0].component({
    t: (key) => key,
    useRepeatToolBreaker: (selector) => selector(store.getSnapshot()),
    edit() {},
    resetField() {},
    save() {},
    discard() {},
  })
  assert.equal(rendered, null, 'an unserved namespace must leave no trace in the list')
})

test('C14: a served namespace renders the card, collapsed, with the save disabled', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  const rendered = captured.registrations[0].component({
    t: (key) => key,
    useRepeatToolBreaker: (selector) => selector(store.getSnapshot()),
    edit() {},
    resetField() {},
    save() {},
    discard() {},
  })
  assert.ok(rendered, 'a served namespace renders the card')
  assert.equal(rendered.type, 'li')
  assert.equal(rendered.props.className, 'rtb_card', 'a fresh card starts collapsed')
})

test('C15: a failing write keeps the draft and reports the failure', async () => {
  const { face } = await loadBundle()
  const scope = fakeScope()
  scope.set = async () => {
    throw new Error('host refused')
  }
  const { ctx, captured } = fakeClientCtx(scope)
  face.apply(ctx)
  const props = captured.registrations[0].options.inject()
  const store = props.hooks.repeatToolBreaker

  props.edit('failWarnAt', '4')
  props.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(store.getSnapshot().failed, true)
  assert.equal(store.getSnapshot().dirty, true, 'the draft survives a refused save')
  assert.equal(store.getSnapshot().fields.failWarnAt.text, '4')
})
