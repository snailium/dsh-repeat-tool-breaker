/**
 * Field specs and converters for boolean, number, and CSV settings.
 */

export const booleanField = (field) => ({
  field,
  format: (value) => (value === true ? 'true' : 'false'),
  parse: (text) =>
    text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
})

export const numberField = (field, options = {}) => ({
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

export const csvField = (field) => ({
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

export const stringField = (field) => ({
  field,
  format: (value) => (typeof value === 'string' ? value : ''),
  parse: (text) => {
    const trimmed = text.trim()
    return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
  },
})
