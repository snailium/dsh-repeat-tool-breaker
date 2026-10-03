import { booleanField, numberField, csvField, stringField } from './specs.js'

export const NAMESPACE = 'repeat-tool-breaker'
export const PACKAGE_NAME = 'dsh-repeat-tool-breaker'
export const LOCALE_NS = 'repeat-tool-breaker.card'

export const rowConfigKey = (rowId) => `${PACKAGE_NAME}#${rowId}`

export const ROWS = [
  {
    rowId: 'repeat-tool-breaker',
    role: 'breaker',
  },
  {
    rowId: 'web-fetch-file',
    role: 'fetch-file',
  },
]

export const BREAKER_FIELD_SPECS = [
  booleanField('blockShellHttp'),
  booleanField('blockLocalHttp'),
  csvField('shellHttpBlock'),
  numberField('warnAt', { min: 1, integer: true }),
  numberField('summarizeAt', { min: 1, integer: true }),
  numberField('failWarnAt', { min: 1, integer: true }),
  numberField('failLimit', { min: 1, integer: true }),
]

export const BREAKER_FIELD_LAYOUT = [
  { field: 'blockShellHttp' },
  { field: 'blockLocalHttp' },
  { field: 'shellHttpBlock' },
  { field: 'warnAt', numeric: true },
  { field: 'summarizeAt', numeric: true },
  { field: 'failWarnAt', numeric: true },
  { field: 'failLimit', numeric: true },
]

export const FETCH_FILE_FIELD_SPECS = [
  booleanField('fetchWithCurl'),
  stringField('outputDir'),
  numberField('maxBytes', { min: 1, integer: true }),
  numberField('timeoutMs', { min: 1, integer: true }),
  numberField('maxRedirects', { min: 1, integer: true }),
  booleanField('allowPrivateHosts'),
  booleanField('cookieJar'),
]

export const FETCH_FILE_FIELD_LAYOUT = [
  { field: 'fetchWithCurl' },
  { field: 'outputDir' },
  { field: 'maxBytes', numeric: true },
  { field: 'timeoutMs', numeric: true },
  { field: 'maxRedirects', numeric: true },
  { field: 'allowPrivateHosts' },
  { field: 'cookieJar' },
]

export const CARD_SPECS = {
  breaker: BREAKER_FIELD_SPECS,
  'fetch-file': FETCH_FILE_FIELD_SPECS,
}

export const CARD_LAYOUT = {
  breaker: BREAKER_FIELD_LAYOUT,
  'fetch-file': FETCH_FILE_FIELD_LAYOUT,
}

export const FIELD_SPECS = BREAKER_FIELD_SPECS
export const FIELD_LAYOUT = BREAKER_FIELD_LAYOUT

export function formLabels(t) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}
