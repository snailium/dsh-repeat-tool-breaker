/**
 * The plugin's browser half: the card that appears under Settings → Plugins.
 *
 * ## Why this file exists
 *
 * The Plugins page renders the INTERSECTION of two ledgers: the settings namespaces a
 * live Host plugin registered, and the cards a browser bundle registered under the same
 * key. The Host half registers `repeat-tool-breaker` (`lib/settings.js`); nothing renders
 * until a bundle claims that key on `settings.plugin.item`. Exporting a `Config` from the
 * Host entry does NOT produce a card — the four built-in cards are hard-coded inside
 * `@deepseek-ai/dsh-client-ui-settings-plugins`, so a third-party plugin must ship its own.
 *
 * ## Why it is hand-written rather than built
 *
 * A client bundle is a lazy-CJS factory behind `window.__ModuleLoader__.load`: the bundle
 * only REGISTERS the factory, and the module body — styles included — runs on first
 * materialization. That contract is small enough to author directly, so this plugin stays
 * build-free: no TypeScript, no tsdown, no generated artifact to keep in sync. The single
 * require is `react`; every service (`slots`, `locale`, `settingsScope`) arrives through
 * injection, exactly as it does for the built-in cards.
 *
 * ## What the card shows
 *
 * The same seven fields the namespace declares, in the same order. The look is reproduced
 * from the built-in card's own CSS module (same custom properties, own class prefix) so the
 * card is indistinguishable from a shipped one. Values are STAGED: nothing is written until
 * Save, and a rejected write keeps the draft rather than silently dropping the edit.
 */

window.__ModuleLoader__.load({
  id: 'dsh-repeat-tool-breaker',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    //#region store
    /**
     * The snapshot store a card's component reads through its bound selector. This is
     * the `useSyncExternalStore` shape: the slot system subscribes to `subscribe` and
     * renders `selector(getSnapshot())`.
     * @param initial - the first projection.
     * @returns the store.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          snapshot = next
          for (const listener of listeners) listener()
        },
      }
    }
    //#endregion

    //#region field specs
    /**
     * A boolean field, rendered as the literal `true`/`false` the settings document uses.
     * A draft that is neither blocks the save instead of being guessed at.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    const booleanField = (field) => ({
      field,
      format: (value) => (value === true ? 'true' : 'false'),
      parse: (text) =>
        text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
    })

    /**
     * A whole-number field. An empty draft clears the field; any other draft that is not
     * a finite integer blocks the save.
     * @param field - field name inside the namespace section.
     * @param options - accepted range.
     * @returns the field's conversion spec.
     */
    const numberField = (field, options = {}) => ({
      field,
      format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
      parse(text) {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) return undefined
        if (options.integer === true && !Number.isInteger(parsed)) return undefined
        if (options.min !== undefined && parsed < options.min) return undefined
        if (options.max !== undefined && parsed > options.max) return undefined
        return { kind: 'set', value: parsed }
      },
    })

    /**
     * A comma-separated list field. Duplicates and blanks are dropped, so the control can
     * be typed loosely; an empty draft clears the field.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    const csvField = (field) => ({
      field,
      format: (value) =>
        Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : '',
      parse(text) {
        const values = [
          ...new Set(
            text
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ]
        return values.length === 0 ? { kind: 'clear' } : { kind: 'set', value: values }
      },
    })
    //#endregion

    //#region form
    /**
     * One card's staged form over one settings namespace.
     *
     * A settings write is a durable, revision-fenced document mutation, so a control that
     * committed as it settled would turn one keystroke into a write the user never asked
     * for. Staging makes what is on screen exactly what a save would store.
     *
     * A field shows its effective value — the user layer over the composition layer over
     * the schema default — and whether the USER LAYER carries it. That presence, not a
     * value comparison, is what marks a field overridden: an override equal to the
     * composition default is still an override.
     */
    class CardForm {
      /**
       * @param scope - the bound settings scope for this card's namespace.
       * @param specs - the section fields this card edits.
       */
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

      /** Detach from the scope, so a disposed card stops republishing. */
      dispose() {
        this.unsubscribe()
        this.listeners.clear()
      }

      /**
       * Publish a projection of this form, rebuilt whenever the scope or a draft changes.
       * @param project - build the card's state from the form's current reads.
       * @returns the store the card's component reads through its bound selector.
       */
      bind(project) {
        const store = createStore(project())
        this.listeners.add(() => {
          store.set(project())
        })
        return store
      }

      /**
       * Read the card-level state: what the Host serves, and what a save would do.
       * @returns the form state every card shares.
       */
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

      /**
       * Read one control's state.
       * @param field - field name inside the namespace section.
       * @returns the draft text, whether a save would leave an override, and whether it is invalid.
       */
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

      /**
       * Build the edit, reset, save, and discard actions bound to this form.
       * @returns the actions a card's slot entry injects.
       */
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

      /**
       * Write every staged edit, then re-seed from what the Host accepted.
       *
       * The Host is the only authority on whether a value was accepted, so the outcome is
       * read back from the section rather than predicted here. A save that did not land
       * keeps its drafts, so the user can correct them instead of retyping.
       * @returns settlement after every write and the read-back.
       */
      async save() {
        const plan = this.plan()
        const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]))
        if (plan.length === 0 || this.saving || ops.length !== plan.length) return
        this.saving = true
        this.failed = false
        this.publish()
        let landed = true
        try {
          // 0.1.7 writes through ONE fenced mutation — `mutate(ops, revision)` — instead of
          // a `set`/`unset` pair per field. The revision is the one the draft was read at,
          // so a concurrent change is REFUSED rather than overwritten.
          landed = await this.scope.mutate(ops, this.baseline?.revision)
        } catch {
          // A rejected write is a failed save, not an escaping rejection: the Host may
          // refuse a value, and the card's answer to that is to keep the draft and say so.
          landed = false
        }
        if (landed) this.staged.clear()
        this.saving = false
        this.failed = !landed
        this.publish()
      }

      /**
       * Every staged edit a save would write. An entry whose draft is not a value its
       * field accepts carries no write: the form is still dirty, and the save refuses
       * rather than dropping the edit.
       * @returns the planned writes, in the order the fields were staged.
       */
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
        // The revision a draft is fenced by: captured once, at the first edit of this draft.
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
    //#endregion

    //#region controller
    /**
     * Namespace of this plugin's user-owned settings. Spelled here rather than imported:
     * a client package must not depend on a Host package, and the Host registers the same
     * literal. A mismatch renders nothing rather than a broken card — the scope never
     * reaches `ready` — which is why the two are asserted equal by the test suite.
     */
    const NAMESPACE = 'repeat-tool-breaker'

    /** Every field the card edits, in render order. */
    const FIELD_SPECS = [
      booleanField('blockShellHttp'),
      booleanField('blockLocalHttp'),
      csvField('shellHttpBlock'),
      numberField('warnAt', { min: 1, integer: true }),
      numberField('summarizeAt', { min: 1, integer: true }),
      numberField('failWarnAt', { min: 1, integer: true }),
      numberField('failLimit', { min: 1, integer: true }),
    ]

    /** Bridges the `repeat-tool-breaker` scope onto the card's staged form. */
    class CardController {
      /** @param scope - the bound settings scope for the `repeat-tool-breaker` namespace. */
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

      /**
       * Build the face the card's slot registration injects.
       * @returns the card's snapshot and its form actions.
       */
      inject() {
        return {
          hooks: { repeatToolBreaker: this.store },
          ...this.form.actions(),
        }
      }

      /** Tear the card down: the form detaches from the scope. */
      dispose() {
        this.form.dispose()
      }
    }

    /**
     * Render order and control hints, kept beside the specs so a field cannot be added to
     * one and forgotten in the other.
     */
    const FIELD_LAYOUT = [
      { field: 'blockShellHttp' },
      { field: 'blockLocalHttp' },
      { field: 'shellHttpBlock' },
      { field: 'warnAt', numeric: true },
      { field: 'summarizeAt', numeric: true },
      { field: 'failWarnAt', numeric: true },
      { field: 'failLimit', numeric: true },
    ]
    //#endregion

    //#region components
    /**
     * Copy the shared form chrome expects, under this card's dictionary.
     * @param t - the card's translator.
     * @returns the labels `SettingsForm` renders.
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * Render this plugin's one-liner or its settings form, as the Plugins page asks.
     *
     * `props.view === 'summary'` is not optional: the page renders the card's summary as the
     * row's description, and without it the list falls back to the package description —
     * which is how this card first appeared, styled nothing like its neighbours.
     *
     * The chrome is NOT this component's job. 0.1.7 supplies the card frame (title from the
     * slot's `label`, the disclosure) and `SettingsForm` (fields container, footer, the
     * read-only and save-failed notices). Rendering a second frame here produced exactly the
     * doubled, mis-styled card this replaced — and an inner header button that swallowed the
     * platform's clicks.
     *
     * @param props - the requested view, locale copy, the form snapshot, and its actions.
     * @returns the one-liner, or the form.
     */
    function Card(props) {
      const { t } = props
      const state = props.useRepeatToolBreaker((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable
      return h(
        primitives.SettingsForm,
        { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
        ...FIELD_LAYOUT.map((entry) =>
          h(primitives.SettingsValueField, {
            key: entry.field,
            id: 'plugin-config-repeat-tool-breaker-' + entry.field,
            label: t(entry.field),
            hint: t(entry.field + 'Hint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: entry.numeric === true,
            disabled,
            ...state.fields[entry.field],
            onEdit: (text) => {
              props.edit(entry.field, text)
            },
            onReset: () => {
              props.resetField(entry.field)
            },
          }),
        ),
      )
    }
    //#endregion

    //#region locales
    /** The card's locale namespace. */
    const LOCALE_NS = 'repeat-tool-breaker.card'

    const en = {
      title: 'Repeat tool breaker',
      description: 'Interrupts a stuck turn: repeats of the same call, and runs of consecutive failures.',
      collapse: 'Collapse',
      expand: 'Expand',
      unsaved: 'Unsaved',
      unavailable: 'These settings are unavailable in this deployment.',
      readOnly: 'This deployment serves these settings read-only.',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'A whole number is required.',
      save: 'Save',
      saving: 'Saving\u2026',
      discard: 'Discard',
      saveFailed: 'The Host refused part of the change. Drafts were kept; check the logs.',

      blockShellHttp: 'Block HTTP from the shell',
      blockShellHttpHint:
        'Refuse a shell command that fetches over HTTP and send the model to web_fetch_file instead.',
      blockLocalHttp: 'Also block local fetches',
      blockLocalHttpHint:
        'Extend the block to loopback and private addresses. Off, because web_fetch_file cannot reach them either.',
      shellHttpBlock: 'Commands to refuse',
      shellHttpBlockHint:
        'Comma-separated commands the block refuses, such as curl and wget. An interpreter program naming a request API is refused too.',
      warnAt: 'Advisory threshold',
      warnAtHint: 'Repeats of one call before the light advisory that says to change approach.',
      summarizeAt: 'Summary threshold',
      summarizeAtHint: 'Repeats before the call is asked to summarize its progress first.',
      failWarnAt: 'Failure advisory threshold',
      failWarnAtHint: 'Consecutive failures before the advisory that says to stop retrying.',
      failLimit: 'Failure block threshold',
      failLimitHint: 'Consecutive failures before the call is refused outright.',
    }

    const zh = {
      title: '\u91cd\u590d\u5de5\u5177\u65ad\u8def\u5668',
      description:
        '\u4e2d\u65ad\u5361\u4f4f\u7684\u56de\u5408\uff1a\u540c\u4e00\u8c03\u7528\u7684\u91cd\u590d\uff0c\u4ee5\u53ca\u8fde\u7eed\u5931\u8d25\u3002',
      collapse: '\u6536\u8d77',
      expand: '\u5c55\u5f00',
      unsaved: '\u672a\u4fdd\u5b58',
      unavailable: '\u672c\u90e8\u7f72\u4e2d\u8fd9\u4e9b\u8bbe\u7f6e\u4e0d\u53ef\u7528\u3002',
      readOnly: '\u672c\u90e8\u7f72\u4ee5\u53ea\u8bfb\u65b9\u5f0f\u63d0\u4f9b\u8fd9\u4e9b\u8bbe\u7f6e\u3002',
      overridden: '\u5df2\u8986\u76d6',
      reset: '\u91cd\u7f6e',
      invalidNumber: '\u9700\u8981\u4e00\u4e2a\u6574\u6570\u3002',
      save: '\u4fdd\u5b58',
      saving: '\u4fdd\u5b58\u4e2d\u2026',
      discard: '\u653e\u5f03',
      saveFailed:
        '\u4e3b\u673a\u62d2\u7edd\u4e86\u90e8\u5206\u4fee\u6539\u3002\u8349\u7a3f\u5df2\u4fdd\u7559\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002',

      blockShellHttp: '\u62e6\u622a shell \u4e2d\u7684 HTTP',
      blockShellHttpHint:
        '\u62d2\u7edd\u4efb\u4f55\u5728 shell \u91cc\u53d1\u8d77 HTTP \u6293\u53d6\u7684\u547d\u4ee4\uff0c\u6539\u7528 web_fetch_file\u3002',
      blockLocalHttp: '\u540c\u65f6\u62e6\u622a\u672c\u5730\u6293\u53d6',
      blockLocalHttpHint:
        '\u5c06\u62e6\u622a\u6269\u5c55\u5230\u56de\u73af\u4e0e\u5185\u7f51\u5730\u5740\u3002\u9ed8\u8ba4\u5173\u95ed\uff0c\u56e0\u4e3a web_fetch_file \u4e5f\u5230\u4e0d\u4e86\u90a3\u91cc\u3002',
      shellHttpBlock: '\u8981\u62d2\u7edd\u7684\u547d\u4ee4',
      shellHttpBlockHint:
        '\u9017\u53f7\u5206\u9694\u3002\u5217\u5728\u8fd9\u91cc\u7684\u547d\u4ee4\u4f1a\u88ab\u62d2\u7edd\uff0c\u5982 curl \u4e0e wget\uff1b\u89e3\u91ca\u5668\u7a0b\u5e8f\u91cc\u51fa\u73b0\u8bf7\u6c42 API \u4e5f\u4e00\u6837\u3002',
      warnAt: '\u63d0\u9192\u9608\u503c',
      warnAtHint: '\u540c\u4e00\u8c03\u7528\u91cd\u590d\u591a\u5c11\u6b21\u540e\uff0c\u8f7b\u5ea6\u63d0\u9192\u6362\u4e00\u6761\u8def\u3002',
      summarizeAt: '\u6c47\u603b\u9608\u503c',
      summarizeAtHint: '\u91cd\u590d\u591a\u5c11\u6b21\u540e\uff0c\u8981\u6c42\u5148\u6c47\u603b\u8fdb\u5c55\u3002',
      failWarnAt: '\u5931\u8d25\u63d0\u9192\u9608\u503c',
      failWarnAtHint:
        '\u8fde\u7eed\u5931\u8d25\u591a\u5c11\u6b21\u540e\uff0c\u63d0\u9192\u4e0d\u8981\u518d\u91cd\u8bd5\u3002',
      failLimit: '\u5931\u8d25\u963b\u65ad\u9608\u503c',
      failLimitHint: '\u8fde\u7eed\u5931\u8d25\u591a\u5c11\u6b21\u540e\uff0c\u76f4\u63a5\u62d2\u7edd\u8c03\u7528\u3002',
    }
    //#endregion

    //#region module face
    /** This bundle's module id, matching the package name in the boot graph. */
    const name = 'repeat-tool-breaker-client'

    /** Client services this bundle needs before `apply` runs. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Claim `settings.plugin.item` for this plugin's namespace.
     * @param ctx - the client cordis context.
     * @returns nothing.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'repeat-tool-breaker: card dictionaries')

      const t = ctx.locale.bind(LOCALE_NS)
      const scope = ctx.configForms.get(NAMESPACE)
      const controller = new CardController(scope)
      ctx.effect(
        () => () => {
          controller.dispose?.()
        },
        'repeat-tool-breaker: card controller',
      )

      // The page mounts only while the Host serves this entry's namespace, and it registers
      // into `plugins.item` — the 0.1.7 slot, whose options are `id`/`order`/`label` rather
      // than the old `key`.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NAMESPACE], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: NAMESPACE,
                  order: 20,
                  label: () => t('title'),
                  locale: LOCALE_NS,
                  inject: () => controller.inject(),
                },
                Card,
              ),
            ),
          ),
        'repeat-tool-breaker: settings page',
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.NAMESPACE = NAMESPACE
    exports.LOCALE_NS = LOCALE_NS
    exports.FIELD_LAYOUT = FIELD_LAYOUT
    return module.exports
  },
})
