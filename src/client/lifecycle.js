import { NAMESPACE, PACKAGE_NAME, LOCALE_NS, FIELD_LAYOUT } from './constants.js'
import { en, zh } from './locales.js'
import { CardController } from './form.js'
import { Card } from './card.js'

export const name = 'repeat-tool-breaker-client'
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx) {
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

  ctx.effect(
    () =>
      ctx.configForms.whileServed([NAMESPACE], () =>
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: PACKAGE_NAME,
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

export { NAMESPACE, PACKAGE_NAME, LOCALE_NS, FIELD_LAYOUT }
