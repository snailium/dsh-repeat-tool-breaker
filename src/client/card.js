import { formLabels, FIELD_LAYOUT, CARD_LAYOUT, FETCH_FILE_FIELD_LAYOUT } from './constants.js'

export function Card(props) {
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
