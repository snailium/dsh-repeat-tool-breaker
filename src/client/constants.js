import { booleanField, numberField, csvField } from './specs.js'

export const NAMESPACE = 'repeat-tool-breaker'
export const PACKAGE_NAME = 'dsh-repeat-tool-breaker'
export const LOCALE_NS = 'repeat-tool-breaker.card'

export const FIELD_SPECS = [
  booleanField('blockShellHttp'),
  booleanField('blockLocalHttp'),
  booleanField('fetchWithCurl'),
  csvField('shellHttpBlock'),
  numberField('warnAt', { min: 1, integer: true }),
  numberField('summarizeAt', { min: 1, integer: true }),
  numberField('failWarnAt', { min: 1, integer: true }),
  numberField('failLimit', { min: 1, integer: true }),
]

export const FIELD_LAYOUT = [
  { field: 'blockShellHttp' },
  { field: 'blockLocalHttp' },
  { field: 'fetchWithCurl' },
  { field: 'shellHttpBlock' },
  { field: 'warnAt', numeric: true },
  { field: 'summarizeAt', numeric: true },
  { field: 'failWarnAt', numeric: true },
  { field: 'failLimit', numeric: true },
]

export function formLabels(t) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}
