/**
 * The plugin's settings namespace: the knobs a human should be able to change without
 * editing YAML.
 *
 * ## Why a namespace AND a browser bundle
 *
 * The patch config is a deployment decision made by whoever wrote the profile. Some of
 * these values are not: an operator discovering that `git clone` is now refused wants to
 * add `git` to a list, not to restart dsh with an edited YAML. `ctx.settings.register` is
 * the supported route — `dsh-settings` layers the registration's `base` (our patch config)
 * under the stored section, and the default `applies: 'live'` means a change takes effect
 * on the next call rather than at boot.
 *
 * A namespace alone renders NOTHING, though. The Plugins page shows the intersection of
 * two ledgers: the namespaces a live Host plugin registered, and the cards a browser
 * bundle registered under the same key. `dsh-client-ui-settings-plugins` hard-codes its
 * own four cards, so a third-party plugin must ship the other half — `lib/client.js`
 * claims this namespace on `settings.plugin.item`. Registration here without that bundle
 * is silently invisible, which is why the two halves' shared literals are asserted equal
 * by the test suite rather than trusted to stay in step.
 *
 * ## Why the schema is built from a dynamically imported `schemastery`
 *
 * `ctx.settings.register` needs a real schemastery schema: it is CALLED to resolve the
 * value (`schema(mergeLayers(base, section))`) and the client reads the resolved snapshot
 * the scope serves. A hand-written validator would resolve but serve nothing useful. So the
 * dependency is real — but importing it at module scope would make this plugin's own test
 * suite need the harness closure, which it currently does not. The import therefore happens
 * inside the registration callback, and a failure is RECORDED rather than swallowed: a
 * silently missing settings box is exactly the kind of thing that wastes an afternoon.
 *
 * Registration is non-blocking (`ctx.inject`), so a profile without a settings provider
 * keeps working from its patch config alone.
 */

/** Settings namespace. Lowercase-hyphenated, as the registry requires. */
export const SETTINGS_NAMESPACE = 'repeat-tool-breaker'

/**
 * What happened when we tried to register. `registered: false` with a `reason` is a
 * diagnosable state, not a mystery.
 */
export const settingsState = { registered: false, reason: 'not attempted' }

/** Announce a failed registration ONCE, so the reason is visible where it matters. */
function warnOnce(reason) {
  if (settingsState.reason === reason) return
  settingsState.reason = reason
  // A silently missing settings box is exactly the kind of thing that wastes an
  // afternoon, and the state object is only readable from inside the process. So the
  // reason is also said out loud, once.
  console.warn(`[repeat-tool-breaker] settings box not registered: ${reason}`)
}

/**
 * The fields the box exposes. Deliberately the POLICY knobs only: the `limits` table and
 * the fingerprint internals are deployment concerns, and a nested table is a poor
 * settings-box field.
 *
 * The defaults come from the CURRENT config rather than a second hard-coded copy, so
 * the box and `lib/defaults.js` cannot drift apart.
 *
 * @param z - schemastery.
 * @param cfg - the validated configuration.
 * @returns the namespace schema.
 */
export function buildSettingsSchema(z, cfg) {
  return z.object({
    blockShellHttp: z
      .boolean()
      .default(cfg.blockShellHttp)
      .description('Refuse HTTP fetches made from the shell.'),
    blockLocalHttp: z
      .boolean()
      .default(cfg.blockLocalHttp)
      .description('Also refuse local (loopback/RFC1918) fetches. Off, because web_fetch_file cannot reach them.'),
    shellHttpAllow: z
      .array(z.string())
      .default([...cfg.shellHttpAllow])
      .description(
        'Shell verbs the block leaves alone: their network use is incidental, and there is no fetch-to-file equivalent.',
      ),
    warnAt: z.number().default(cfg.warnAt).description('Occurrence stage 1: the light advisory.'),
    summarizeAt: z.number().default(cfg.summarizeAt).description('Occurrence stage 2: the summary demand.'),
    failWarnAt: z
      .number()
      .default(cfg.failWarnAt)
      .description('Failure stage 1: consecutive failures before the advisory.'),
    failLimit: z
      .number()
      .default(cfg.failLimit)
      .description('Failure gate: consecutive failures before the call is blocked.'),
  })
}

/**
 * Register the namespace, once a settings provider exists.
 *
 * @param ctx - cordis context.
 * @param base - the patch-layer values, used as the composition base layer.
 * @param onResolved - called with every resolved value, immediately and on each change.
 * @returns nothing; inspect {@link settingsState}.
 */
export function registerSettings(ctx, cfg, base, onResolved) {
  if (typeof ctx?.inject !== 'function') {
    warnOnce('the context has no scoped inject')
    return
  }
  ctx.inject(['settings'], (settingsCtx) => {
    void (async () => {
      let z
      try {
        ;({ default: z } = await import('@deepseek-ai/schemastery'))
      } catch (error) {
        warnOnce(`schemastery is not resolvable from this install: ${error.message}`)
        return
      }
      try {
        const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, buildSettingsSchema(z, cfg), { base })
        settingsState.registered = true
        settingsState.reason = ''
        onResolved(scope.get())
        // Live: a change in the box takes effect on the next call, not at the next boot.
        scope.watch(() => onResolved(scope.get()))
      } catch (error) {
        warnOnce(`register failed: ${error.message}`)
      }
    })()
  })
}
