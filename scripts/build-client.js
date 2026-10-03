/**
 * Build script for dsh-repeat-tool-breaker/client.
 *
 * Assembles modular source files in src/client/ into the single distribution file lib/client.js
 * required by the DeepSeek Harness client module loader (__ModuleLoader__.load).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC_DIR = join(ROOT, 'src', 'client')
const OUTPUT_FILE = join(ROOT, 'lib', 'client.js')

export async function buildClientBundle() {
  const [store, specs, constants, form, locales, card, lifecycle] = await Promise.all([
    readFile(join(SRC_DIR, 'store.js'), 'utf8'),
    readFile(join(SRC_DIR, 'specs.js'), 'utf8'),
    readFile(join(SRC_DIR, 'constants.js'), 'utf8'),
    readFile(join(SRC_DIR, 'form.js'), 'utf8'),
    readFile(join(SRC_DIR, 'locales.js'), 'utf8'),
    readFile(join(SRC_DIR, 'card.js'), 'utf8'),
    readFile(join(SRC_DIR, 'lifecycle.js'), 'utf8'),
  ])

  const stripImportsExports = (code) =>
    code
      .replace(/^import\s+.*?;?\s*$/gmu, '')
      .replace(/^export\s+(const|function|class)\s+/gmu, '$1 ')
      .replace(/^export\s*\{[^}]*\};?\s*$/gmu, '')
      .trim()

  const header = `/**
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
`

  const footer = `
    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.NAMESPACE = NAMESPACE
    exports.PACKAGE_NAME = PACKAGE_NAME
    exports.LOCALE_NS = LOCALE_NS
    exports.FIELD_LAYOUT = FIELD_LAYOUT
    return module.exports
  },
})
`

  const indent = (code) =>
    code
      .split('\n')
      .map((line) => (line.length > 0 ? `    ${line}` : line))
      .join('\n')

  const bundleContent = [
    header,
    indent(stripImportsExports(store)),
    '',
    indent(stripImportsExports(specs)),
    '',
    indent(stripImportsExports(constants)),
    '',
    indent(stripImportsExports(form)),
    '',
    indent(stripImportsExports(card)),
    '',
    indent(stripImportsExports(locales)),
    '',
    indent(stripImportsExports(lifecycle)),
    footer,
  ].join('\n')

  await writeFile(OUTPUT_FILE, bundleContent, 'utf8')
  return bundleContent
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildClientBundle().then(() => {
    console.log('Successfully built lib/client.js from src/client/')
  })
}
