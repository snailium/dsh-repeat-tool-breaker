import { createStore } from './store.js'
import { FIELD_SPECS } from './constants.js'

export class CardForm {
  constructor(scope, specs) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.listeners = new Set()
    this.saving = false
    this.failed = false
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
    })
  }

  dispose() {
    this.unsubscribe()
    this.listeners.clear()
  }

  bind(project) {
    const store = createStore(project())
    this.listeners.add(() => {
      store.set(project())
    })
    return store
  }

  shell() {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === undefined && item.op === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(field) {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  actions() {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false })
      },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  async save() {
    const plan = this.plan()
    const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]))
    if (plan.length === 0 || this.saving || ops.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      landed = await this.scope.mutate(ops, this.baseline?.revision)
    } catch {
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  plan() {
    const plan = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
      else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  stage(field, edit) {
    if (this.baseline === undefined) this.baseline = this.scope.getSnapshot()
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  spec(field) {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error('repeat-tool-breaker card has no field ' + field)
    return spec
  }

  snapshotOf() {
    return this.scope.getSnapshot()
  }

  sectionValue(field) {
    return this.snapshotOf().value?.[field]
  }

  baseValue(field) {
    return this.snapshotOf().base?.[field]
  }

  userLayer() {
    return this.snapshotOf().user
  }

  stored(field) {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  publish() {
    for (const listener of this.listeners) listener()
  }
}

export class CardController {
  constructor(scope) {
    this.form = new CardForm(scope, FIELD_SPECS)
    this.store = this.form.bind(() => this.projection())
  }

  projection() {
    const state = this.form.shell()
    const fields = {}
    for (const spec of FIELD_SPECS) fields[spec.field] = this.form.field(spec.field)
    return { ...state, fields }
  }

  inject() {
    return {
      hooks: { repeatToolBreaker: this.store },
      ...this.form.actions(),
    }
  }

  dispose() {
    this.form.dispose()
  }
}
