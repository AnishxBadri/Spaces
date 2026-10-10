import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __unstable__loadDesignSystem } from 'tailwindcss'

/**
 * What the app's Tailwind build emits for a class, compiled from the real
 * `styles.css` — theme, `@utility` blocks and all — so a test can assert the
 * declarations a class string produces rather than the tokens it spells.
 * - The fonts, `tw-animate-css` and the typography plugin load empty: none of
 *   them declares a utility the assertions read.
 * - Tailwind's design-system loader is the language server's entry point; an
 *   upgrade that renames it fails here, loudly.
 */
const src = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const tailwindDir = dirname(require.resolve('tailwindcss/package.json'))

function sheet(path: string) {
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
}

const designSystem = __unstable__loadDesignSystem(
  readFileSync(`${src}/styles.css`, 'utf8'),
  {
    base: src,
    loadStylesheet: async (id, base) => {
      if (id === 'tailwindcss') return sheet(`${tailwindDir}/index.css`)
      if (id.startsWith('.')) return sheet(resolve(base, id))
      return { path: id, base, content: '' }
    },
    loadModule: async (id, base) => ({ path: id, base, module: () => {} }),
  },
)

/** The CSS each class compiles to, in order; '' for a class Tailwind does
 *  not know. */
export async function classCss(
  classes: ReadonlyArray<string>,
): Promise<Array<string>> {
  const ds = await designSystem
  return ds.candidatesToCss([...classes]).map((css) => css ?? '')
}

/** Every value one property is given across a class string's CSS. */
export async function declared(
  className: string,
  property: string,
): Promise<Array<string>> {
  const css = (await classCss(className.split(/\s+/).filter(Boolean))).join(
    '\n',
  )
  const re = new RegExp(`(?:^|[\\s;{])${property}\\s*:\\s*([^;]+);`, 'g')
  return [...css.matchAll(re)].map((m) => m[1].trim())
}
