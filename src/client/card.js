import { formLabels, FIELD_LAYOUT } from './constants.js'

export function Card(props) {
  const { t } = props
  if (props.view === 'summary') return t('description')
  if (props.view !== 'page') return null
  const layout = props.layout || FIELD_LAYOUT
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
