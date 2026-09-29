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
  plugins: [fileURLToPath(import.meta.resolve('prettier-plugin-tailwindcss'))],
  tailwindStylesheet: fileURLToPath(
    new URL('../../apps/web/src/styles.css', import.meta.url),
  ),
  tailwindFunctions: ['cn', 'cva'],
}

export default config
