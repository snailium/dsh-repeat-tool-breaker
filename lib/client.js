/**
 * The plugin's browser half: the card that appears under Settings → Plugins.
 *
 * Generated from src/client/ by scripts/build-client.js.
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

    /**
     * Snapshot store for useSyncExternalStore in DSH settings cards.
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

    /**
     * Field specs and converters for boolean, number, and CSV settings.
     */

    const booleanField = (field) => ({
      field,
      format: (value) => (value === true ? 'true' : 'false'),
      parse: (text) =>
        text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
    })

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

    const stringField = (field) => ({
      field,
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => {
        const trimmed = text.trim()
        return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
      },
    })

    const NAMESPACE = 'repeat-tool-breaker'
    const PACKAGE_NAME = 'dsh-repeat-tool-breaker'
    const LOCALE_NS = 'repeat-tool-breaker.card'

    const rowConfigKey = (rowId) => `${PACKAGE_NAME}#${rowId}`

    const ROWS = [
      {
        rowId: 'repeat-tool-breaker',
        role: 'breaker',
      },
      {
        rowId: 'web-fetch-file',
        role: 'fetch-file',
      },
    ]

    const BREAKER_FIELD_SPECS = [
      booleanField('blockShellHttp'),
      booleanField('blockLocalHttp'),
      csvField('shellHttpBlock'),
      numberField('warnAt', { min: 1, integer: true }),
      numberField('summarizeAt', { min: 1, integer: true }),
      numberField('failWarnAt', { min: 1, integer: true }),
      numberField('failLimit', { min: 1, integer: true }),
    ]

    const BREAKER_FIELD_LAYOUT = [
      { field: 'blockShellHttp' },
      { field: 'blockLocalHttp' },
      { field: 'shellHttpBlock' },
      { field: 'warnAt', numeric: true },
      { field: 'summarizeAt', numeric: true },
      { field: 'failWarnAt', numeric: true },
      { field: 'failLimit', numeric: true },
    ]

    const FETCH_FILE_FIELD_SPECS = [
      booleanField('fetchWithCurl'),
      stringField('outputDir'),
      numberField('maxBytes', { min: 1, integer: true }),
      numberField('timeoutMs', { min: 1, integer: true }),
      numberField('maxRedirects', { min: 1, integer: true }),
      booleanField('allowPrivateHosts'),
      booleanField('cookieJar'),
    ]

    const FETCH_FILE_FIELD_LAYOUT = [
      { field: 'fetchWithCurl' },
      { field: 'outputDir' },
      { field: 'maxBytes', numeric: true },
      { field: 'timeoutMs', numeric: true },
      { field: 'maxRedirects', numeric: true },
      { field: 'allowPrivateHosts' },
      { field: 'cookieJar' },
    ]

    const CARD_SPECS = {
      breaker: BREAKER_FIELD_SPECS,
      'fetch-file': FETCH_FILE_FIELD_SPECS,
    }

    const CARD_LAYOUT = {
      breaker: BREAKER_FIELD_LAYOUT,
      'fetch-file': FETCH_FILE_FIELD_LAYOUT,
    }

    const FIELD_SPECS = BREAKER_FIELD_SPECS
    const FIELD_LAYOUT = BREAKER_FIELD_LAYOUT

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    class CardForm {
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

    class CardController {
      constructor(scope, specs = FIELD_SPECS, layout = FIELD_LAYOUT) {
        this.specs = specs
        this.layout = layout
        this.form = new CardForm(scope, specs)
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        const state = this.form.shell()
        const fields = {}
        for (const spec of this.specs) fields[spec.field] = this.form.field(spec.field)
        return { ...state, fields }
      }

      inject() {
        return {
          layout: this.layout,
          hooks: { repeatToolBreaker: this.store },
          ...this.form.actions(),
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    function Card(props) {
      const { t } = props
      const role = props.row?.role || (props.layout === FETCH_FILE_FIELD_LAYOUT ? 'fetch-file' : 'breaker')
      if (props.view === 'summary') return t(role === 'fetch-file' ? 'fetchFileDescription' : 'description')
      if (props.view !== 'page') return null
      const layout = props.layout || CARD_LAYOUT[role] || FIELD_LAYOUT
      const state = props.useRepeatToolBreaker((snapshot) => snapshot)
      const disabled = !state.writable
      return h(
        primitives.SettingsForm,
        { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
        ...layout.map((entry) =>
          h(primitives.SettingsValueField, {
            key: entry.field,
            id: 'plugin-config-' + entry.field,
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

    const en = {
      title: 'Repeat tool breaker',
      description: 'Interrupts a stuck turn: repeats of the same call, and runs of consecutive failures.',
      fetchFileDescription:
        'Fetch remote URL content to workspace files, returning only the file path to the model.',
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
        'Extend the block to loopback and private addresses. Off: a local fetch is ordinary work, and web_fetch_file reaches local addresses too when "Fetch with curl" is on.',
      fetchWithCurl: 'Fetch with curl (risk)',
      fetchWithCurlHint:
        'ON by default. RISK: curl saves ANY content type (PDF, image, archive), follows redirects off-origin, shares cookies between fetches of one session, and reaches anything the shell can reach — loopback and RFC1918 included. Turn OFF to fetch through the platform web service instead: text pages only, no cross-origin redirects, and no private addresses.',
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

      outputDir: 'Output directory',
      outputDirHint: 'Directory where fetched files are saved, relative to the workspace root.',
      maxBytes: 'Max body size (bytes)',
      maxBytesHint: 'Maximum body size in bytes to save (default 8MB).',
      timeoutMs: 'Timeout (ms)',
      timeoutMsHint: 'Timeout for curl downloads in milliseconds (default 30,000ms).',
      maxRedirects: 'Max redirects',
      maxRedirectsHint: 'Maximum redirect hops to follow (default 5).',
      allowPrivateHosts: 'Allow private hosts',
      allowPrivateHostsHint: 'Whether loopback and RFC1918 private IP addresses can be fetched by curl.',
      cookieJar: 'Session cookie jar',
      cookieJarHint: 'Share cookies across fetches within the same session.',
    }

    const zh = {
      title: '\u91cd\u590d\u5de5\u5177\u65ad\u8def\u5668',
      description:
        '\u4e2d\u65ad\u5361\u4f4f\u7684\u56de\u5408\uff1a\u540c\u4e00\u8c03\u7528\u7684\u91cd\u590d\uff0c\u4ee5\u53ca\u8fde\u7eed\u5931\u8d25\u3002',
      fetchFileDescription:
        '\u5c06\u8fdc\u7a0b URL \u5185\u5bb9\u6293\u53d6\u5e76\u5199\u5165\u5de5\u4f5c\u533a\u6587\u4ef6\uff0c\u4ec5\u5411\u6a21\u578b\u8fd4\u56de\u6587\u4ef6\u8def\u5f84\u800c\u975e\u5168\u6587\u6b63\u6587\u3002',
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
        '\u5c06\u62e6\u622a\u6269\u5c55\u5230\u56de\u73af\u4e0e\u5185\u7f51\u5730\u5740\u3002\u9ed8\u8ba4\u5173\u95ed\uff1a\u672c\u5730\u6293\u53d6\u662f\u5e38\u89c1\u5de5\u4f5c\uff0c\u800c\u4e14\u5f00\u542f\u201c\u7528 curl \u6293\u53d6\u201d\u540e web_fetch_file \u4e5f\u80fd\u5230\u8fbe\u672c\u5730\u5730\u5740\u3002',
      fetchWithCurl: '\u7528 curl \u6293\u53d6\uff08\u98ce\u9669\uff09',
      fetchWithCurlHint:
        '\u9ed8\u8ba4\u5f00\u542f\u3002\u98ce\u9669\uff1acurl \u4f1a\u4fdd\u5b58\u4efb\u610f\u7c7b\u578b\uff08PDF\u3001\u56fe\u7247\u3001\u538b\u7f29\u5305\uff09\u3001\u8ddf\u968f\u8de8\u6e90\u91cd\u5b9a\u5411\u3001\u5728\u540c\u4e00 session \u5185\u5171\u4eab cookie\uff0c\u5e76\u4e14\u80fd\u8bbf\u95ee shell \u80fd\u8bbf\u95ee\u7684\u4e00\u5207\u2014\u2014\u5305\u62ec\u56de\u73af\u4e0e\u5185\u7f51\u5730\u5740\u3002\u5173\u95ed\u540e\u6539\u8d70\u5e73\u53f0 web \u670d\u52a1\uff1a\u53ea\u80fd\u53d6\u6587\u672c\u9875\u3001\u4e0d\u8ddf\u8de8\u6e90\u91cd\u5b9a\u5411\u3001\u4e0d\u80fd\u89e6\u53ca\u79c1\u6709\u5730\u5740\u3002',
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

      outputDir: '\u4fdd\u5b58\u76ee\u5f55',
      outputDirHint: '\u6293\u53d6\u6587\u4ef6\u7684\u4fdd\u5b58\u76ee\u5f55\uff0c\u76f8\u5bf9\u4e8e\u5de5\u4f5c\u533a\u6839\u76ee\u5f55\u3002',
      maxBytes: '\u6700\u5927\u4fdd\u5b58\u5b57\u8282\u6570',
      maxBytesHint: '\u4fdd\u5b58\u7684\u54cd\u5e94\u6b63\u6587\u6700\u5927\u5b57\u8282\u6570\uff08\u9ed8\u8ba4 8MB\uff09\u3002',
      timeoutMs: '\u8d85\u65f6\u65f6\u95f4\uff08\u6beb\u79d2\uff09',
      timeoutMsHint: 'curl \u4e0b\u8f7d\u7684\u8d85\u65f6\u65f6\u95f4\uff08\u6beb\u79d2\uff0c\u9ed8\u8ba4 30,000ms\uff09\u3002',
      maxRedirects: '\u6700\u5927\u91cd\u5b9a\u5411\u8df3\u6570',
      maxRedirectsHint: '\u8ddf\u968f\u91cd\u5b9a\u5411\u7684\u6700\u5927\u8df3\u8f6c\u6b21\u6570\uff08\u9ed8\u8ba4 5\uff09\u3002',
      allowPrivateHosts: '\u5141\u8bb8\u6293\u53d6\u79c1\u6709\u4e3b\u673a',
      allowPrivateHostsHint: '\u662f\u5426\u5141\u8bb8 curl \u6293\u53d6\u672c\u5730\u56de\u73af\u53ca\u79c1\u6709\u5c40\u57df\u7f51 IP \u5730\u5740\u3002',
      cookieJar: '\u5171\u4eab\u4f1a\u8bdd Cookie',
      cookieJarHint: '\u5728\u540c\u4e00\u4f1a\u8bdd\u5185\u7684\u591a\u6b21\u6293\u53d6\u4e4b\u95f4\u4fdd\u6301\u5e76\u5171\u4eab Cookie\u3002',
    }

    const name = 'repeat-tool-breaker-client'
    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      if (ctx.configForms === undefined || ctx.slots === undefined || ctx.locale === undefined) return
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'repeat-tool-breaker: card dictionaries')

      for (const row of ROWS) {
        const specs = CARD_SPECS[row.role]
        const layout = CARD_LAYOUT[row.role]
        const scope = ctx.configForms.get(row.rowId)
        const controller = new CardController(scope, specs, layout)
        ctx.effect(
          () => () => {
            controller.dispose?.()
          },
          `${row.rowId}: card controller`,
        )

        ctx.effect(
          () =>
            ctx.configForms.whileServed([row.rowId], () =>
              ctx.slots.inject('plugins.row.config', () =>
                ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    key: rowConfigKey(row.rowId),
                    locale: LOCALE_NS,
                    inject: () => controller.inject(),
                  },
                  (props) => Card({ ...props, row, layout }),
                ),
              ),
            ),
          `${row.rowId}: settings page`,
        )
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.NAMESPACE = NAMESPACE
    exports.PACKAGE_NAME = PACKAGE_NAME
    exports.LOCALE_NS = LOCALE_NS
    exports.FIELD_LAYOUT = FIELD_LAYOUT
    exports.BREAKER_FIELD_LAYOUT = BREAKER_FIELD_LAYOUT
    exports.FETCH_FILE_FIELD_LAYOUT = FETCH_FILE_FIELD_LAYOUT
    exports.CARD_LAYOUT = CARD_LAYOUT
    exports.CARD_SPECS = CARD_SPECS
    exports.ROWS = ROWS
    exports.rowConfigKey = rowConfigKey
    return module.exports
  },
})
