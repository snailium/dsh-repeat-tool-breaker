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
    const h = React.createElement

    //#region styles
    /**
     * The card's stylesheet. Class names are transcribed from the built-in card's CSS
     * module with a local prefix: the same theme custom properties, so light and dark
     * follow the shell, and no collision with the package that owns the originals.
     */
    const CSS = [
      '.rtb_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}',
      '.rtb_card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.rtb_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.rtb_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.rtb_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.rtb_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.rtb_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.rtb_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.rtb_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px}',
      '.rtb_chevronOpen{transform:rotate(180deg)}',
      '.rtb_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.rtb_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      '.rtb_pending{flex:none}',
      '.rtb_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.rtb_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.rtb_discard,.rtb_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.rtb_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.rtb_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.rtb_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.rtb_discard:disabled,.rtb_save:disabled{opacity:.4;cursor:default}',
      '.rtb_discard:focus-visible,.rtb_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.rtb_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.rtb_field+.rtb_field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.rtb_head{align-items:center;gap:8px;display:flex}',
      '.rtb_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.rtb_badges{align-items:center;gap:8px;display:inline-flex}',
      '.rtb_tag{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.5}',
      '.rtb_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
      '.rtb_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.rtb_reset:disabled{cursor:default}',
      '.rtb_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
      '.rtb_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.rtb_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.rtb_inputInvalid{border-color:var(--dsw-alias-label-error)}',
      '.rtb_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
      '.rtb_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
    ].join('')

    /** The stylesheet's identity, so a remount cannot append a second copy. */
    const CSS_TAG_ID = 'dsh-repeat-tool-breaker/client.css'

    /** Install the stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-repeat-tool-breaker'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

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
          invalid: plan.some((item) => item.run === undefined),
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
        const writes = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]))
        if (plan.length === 0 || this.saving || writes.length !== plan.length) return
        this.saving = true
        this.failed = false
        this.publish()
        let landed = true
        try {
          for (const write of writes) landed = (await write()) && landed
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
            if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
            continue
          }
          if (staged.text === spec.format(this.sectionValue(field))) continue
          const write = spec.parse(staged.text)
          if (write === undefined) plan.push({ field, run: undefined })
          else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
          else plan.push({ field, run: () => this.store(field, write.value) })
        }
        return plan
      }

      async clear(field) {
        await this.scope.unset(field)
        return !this.stored(field)
      }

      async store(field, value) {
        await this.scope.set(field, value)
        return this.userLayer()?.[field] === value
      }

      stage(field, edit) {
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
      csvField('shellHttpAllow'),
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
      { field: 'shellHttpAllow' },
      { field: 'warnAt', numeric: true },
      { field: 'summarizeAt', numeric: true },
      { field: 'failWarnAt', numeric: true },
      { field: 'failLimit', numeric: true },
    ]
    //#endregion

    //#region components
    /**
     * A staged value field: the label, whether saving would leave an override, the reset
     * that stages a clear back to the composition layer, and the control itself. Nothing
     * here writes — the card's save is the single point where a draft becomes a mutation.
     * @param props - the field's copy, its staged text, and the edit actions.
     * @returns the labelled control.
     */
    function ValueField(props) {
      const disabled = props.disabled === true
      const invalid = props.invalid === true
      return h(
        'div',
        { className: 'rtb_field' },
        h(
          'div',
          { className: 'rtb_head' },
          h('label', { className: 'rtb_label', htmlFor: props.id }, props.label),
          props.overridden
            ? h(
                'span',
                { className: 'rtb_badges' },
                h('span', { className: 'rtb_tag' }, props.overriddenLabel),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'rtb_reset',
                    disabled,
                    onClick: props.onReset,
                  },
                  props.resetLabel,
                ),
              )
            : null,
        ),
        h('input', {
          id: props.id,
          className: invalid ? 'rtb_inputInvalid rtb_input' : 'rtb_input',
          type: 'text',
          ...(props.numeric === true ? { inputMode: 'numeric' } : {}),
          ...(invalid ? { 'aria-invalid': true } : {}),
          value: props.text,
          placeholder: props.placeholder ?? '',
          disabled,
          onChange: (event) => {
            props.onEdit(event.target.value)
          },
        }),
        h('p', { className: invalid ? 'rtb_invalid' : 'rtb_hint' }, invalid ? props.invalidLabel : props.hint),
      )
    }

    /**
     * The card: a header naming the plugin and what its settings govern, disclosing the
     * controls in place, with the save that writes them.
     *
     * The header is its own button, and disclosure is card-local state: which card a user
     * has open is a reading gesture, not something the Host has any stake in. Staged edits
     * outlive collapsing, so the header marks a card holding unsaved edits.
     *
     * A card renders NOTHING while its namespace is unavailable — a deployment that does
     * not compose the owning plugin should show no trace of it rather than a disabled card
     * the user cannot act on.
     * @param props - locale copy, the card snapshot, and its form actions.
     * @returns the card, or nothing when the namespace is unavailable.
     */
    function Card(props) {
      const { t } = props
      const state = props.useRepeatToolBreaker((snapshot) => snapshot)
      const [open, setOpen] = React.useState(false)
      const saveStarted = React.useRef(false)

      React.useEffect(() => {
        if (state.saving) {
          saveStarted.current = true
          return
        }
        if (!saveStarted.current) return
        saveStarted.current = false
        if (!state.dirty && !state.failed) setOpen(false)
      }, [state.dirty, state.failed, state.saving])

      if (!state.available) return null

      const title = t('title')
      const disabled = !state.writable
      const blocked = !state.dirty || state.invalid || state.saving

      return h(
        'li',
        { className: open ? 'rtb_card rtb_cardOpen' : 'rtb_card' },
        h(
          'button',
          {
            type: 'button',
            className: 'rtb_header',
            'aria-expanded': open,
            'aria-label': t(open ? 'collapse' : 'expand') + ': ' + title,
            onClick: () => {
              setOpen(!open)
            },
          },
          h(
            'span',
            { className: 'rtb_headText' },
            h('span', { className: 'rtb_name' }, title),
            h('span', { className: 'rtb_description' }, t('description')),
          ),
          state.dirty ? h('span', { className: 'rtb_tag rtb_pending' }, t('unsaved')) : null,
          h('span', { className: open ? 'rtb_chevron rtb_chevronOpen' : 'rtb_chevron' }, '\u25be'),
        ),
        open
          ? h(
              'div',
              { className: 'rtb_body' },
              !state.writable ? h('p', { className: 'rtb_readOnly', role: 'status' }, t('readOnly')) : null,
              ...FIELD_LAYOUT.map((field) =>
                h(ValueField, {
                  key: field.field,
                  id: 'plugin-config-repeat-tool-breaker-' + field.field,
                  label: t(field.field),
                  hint: t(field.field + 'Hint'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  invalidLabel: t('invalidNumber'),
                  numeric: field.numeric === true,
                  disabled,
                  ...state.fields[field.field],
                  onEdit: (text) => {
                    props.edit(field.field, text)
                  },
                  onReset: () => {
                    props.resetField(field.field)
                  },
                }),
              ),
              h(
                'div',
                { className: 'rtb_footer' },
                state.failed ? h('p', { className: 'rtb_failed', role: 'status' }, t('saveFailed')) : null,
                h(
                  'button',
                  { type: 'button', className: 'rtb_discard', disabled: !state.dirty || state.saving, onClick: props.discard },
                  t('discard'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'rtb_save', disabled: blocked, onClick: props.save },
                  t(state.saving ? 'saving' : 'save'),
                ),
              ),
            )
          : null,
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
      shellHttpAllow: 'Shell verbs left alone',
      shellHttpAllowHint:
        'Comma-separated verbs whose network use is incidental, such as git and docker. Everything else is refused.',
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
      shellHttpAllow: '\u4e0d\u62e6\u622a\u7684 shell \u547d\u4ee4',
      shellHttpAllowHint:
        '\u9017\u53f7\u5206\u9694\u3002\u8fd9\u4e9b\u547d\u4ee4\u7684\u8054\u7f51\u884c\u4e3a\u662f\u9644\u5e26\u7684\uff0c\u5982 git \u4e0e docker\uff1b\u5176\u4f59\u4e00\u5f8b\u62d2\u7edd\u3002',
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
    const inject = ['slots', 'locale', 'settingsScope']

    /**
     * Claim `settings.plugin.item` for this plugin's namespace.
     * @param ctx - the client cordis context.
     * @returns nothing.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'repeat-tool-breaker: card dictionaries')

      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      const controller = new CardController(scope)
      ctx.effect(
        () => () => {
          controller.dispose?.()
        },
        'repeat-tool-breaker: card controller',
      )

      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NAMESPACE,
            id: NAMESPACE,
            locale: LOCALE_NS,
            inject: () => controller.inject(),
          },
          Card,
        ),
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
