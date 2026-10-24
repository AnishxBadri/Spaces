//  @ts-check

import { fileURLToPath } from 'node:url'

/** @type {import('prettier').Config} */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  // Both paths absolute: prettier resolves a plugin *name* and a relative
  // stylesheet from the root shim, where the plugin is not installed, so both
  // are resolved from this file.
  // prettier-plugin-astro formats apps/site's .astro files (the marketing
  // site). It comes first: prettier-plugin-tailwindcss must be the last
  // plugin, and it only sorts classes in an .astro file when the astro
  // plugin is loaded ahead of it.
  plugins: [
    fileURLToPath(import.meta.resolve('prettier-plugin-astro')),
    fileURLToPath(import.meta.resolve('prettier-plugin-tailwindcss')),
  ],
  overrides: [{ files: '*.astro', options: { parser: 'astro' } }],
  tailwindStylesheet: fileURLToPath(
    new URL('../../apps/web/src/styles.css', import.meta.url),
  ),
  tailwindFunctions: ['cn', 'cva'],
}

export default config
