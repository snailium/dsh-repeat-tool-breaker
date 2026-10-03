import { NAMESPACE, PACKAGE_NAME, LOCALE_NS, FIELD_LAYOUT, BREAKER_FIELD_LAYOUT, FETCH_FILE_FIELD_LAYOUT, CARD_LAYOUT, CARD_SPECS, ROWS, rowConfigKey } from './constants.js'
import { en, zh } from './locales.js'
import { CardController } from './form.js'
import { Card } from './card.js'

export const name = 'repeat-tool-breaker-client'
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx) {
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
              Card,
            ),
          ),
        ),
      `${row.rowId}: settings page`,
    )
  }
}

export { NAMESPACE, PACKAGE_NAME, LOCALE_NS, FIELD_LAYOUT, BREAKER_FIELD_LAYOUT, FETCH_FILE_FIELD_LAYOUT, CARD_LAYOUT, CARD_SPECS, ROWS, rowConfigKey }
