//  @ts-check

import { fileURLToPath } from 'node:url'

/** @type {import('prettier').Config} */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  // Both paths absolute (SPA-180). Prettier loads the root shim and resolves
  // a plugin *name* and a relative stylesheet from there — where the plugin
  // is no longer installed, since it is this package's dependency now — so
  // the plugin is resolved here, from the directory that has it, and the
  // stylesheet is spelled from this file. The same two files from either.
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
