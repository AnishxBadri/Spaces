import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROVIDERS as CONNECTION_PROVIDERS } from '@spaces/core/providers/registry'
import { KEYED_PROVIDERS } from '@spaces/core/providers/keyed'
import { PROVIDERS as LLM_PROVIDERS } from '#/lib/ai/providers/ids'
import { PluginMark } from './integrations/integration-ledger'
import { ProviderMark, brandOf } from './provider-mark'
import type { Brand } from './provider-mark'

const web = fileURLToPath(new URL('../../', import.meta.url))
const plugins = fileURLToPath(new URL('../../../../plugins/', import.meta.url))

/** Every brand, spelled once; `satisfies` fails the build on a missing one. */
const BRANDS = Object.keys({
  google: true,
  box: true,
  airtable: true,
  gmail: true,
  apollo: true,
  exa: true,
  granola: true,
  anthropic: true,
  openai: true,
  openrouter: true,
  ollama: true,
  googleCalendar: true,
  googleDrive: true,
} satisfies Record<Brand, true>).filter((b): b is Brand => brandOf(b) !== null)

/** The name in each shipped plugin's manifest, the one its rows print. */
const pluginNames = readdirSync(plugins, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => {
    const manifest = readFileSync(
      join(plugins, d.name, 'src/manifest.ts'),
      'utf8',
    )
    const name = /^ {2}name: '([^']+)'/m.exec(manifest)?.[1]
    if (name === undefined) throw new Error(`${d.name}: no manifest name`)
    return name
  })

/** Every provider or plugin name the app draws a mark beside. */
const NAMED = [
  ...pluginNames,
  ...Object.values(LLM_PROVIDERS).map((p) => p.label),
  ...Object.values(CONNECTION_PROVIDERS).map((p) => p.label),
  ...Object.values(KEYED_PROVIDERS).map((p) => p.label),
]

describe('ProviderMark', () => {
  it('knows every brand by its own name', () => {
    expect(BRANDS).toHaveLength(13)
  })

  it.each(BRANDS)(
    'draws %s in its own colours, never the text colour',
    (brand) => {
      const html = renderToStaticMarkup(<ProviderMark brand={brand} />)
      expect(html).toContain(`data-provider-mark="${brand}"`)
      expect(html).not.toContain('currentColor')
      expect(html).not.toContain('<text')
      expect(html).toContain('size-4')
      const src = /src="(\/brands\/[a-z]+\.png)"/.exec(html)?.[1]
      if (src === undefined) {
        expect(html).toMatch(/role="img" aria-label="[^"]+"/)
        expect(html).toMatch(/<path fill="#[0-9A-F]{6}"/)
      } else {
        // An app icon is served by the app itself, never fetched elsewhere.
        expect(existsSync(join(web, 'public', src))).toBe(true)
        expect(html).toMatch(/alt="[^"]+"/)
        expect(html).toContain('rounded-[3px]')
      }
    },
  )

  it('keeps a call site’s size', () => {
    const html = renderToStaticMarkup(
      <ProviderMark brand="granola" className="size-6" />,
    )
    expect(html).toContain('size-6')
    expect(html).not.toContain('size-4')
  })

  it.each(NAMED)('draws %s with its brand mark, not the fallback', (name) => {
    expect(brandOf(name), name).not.toBeNull()
    for (const offered of [false, true]) {
      const html = renderToStaticMarkup(
        <PluginMark name={name} offered={offered} />,
      )
      expect(html).toContain('data-provider-mark=')
      expect(html).not.toContain('bg-foreground')
      expect(html).not.toContain('bg-rule')
    }
  })

  it('draws an unknown plugin as its initial on a square', () => {
    expect(brandOf('Echo')).toBeNull()
    const html = renderToStaticMarkup(<PluginMark name="Echo" />)
    expect(html).not.toContain('data-provider-mark')
    expect(html).toContain('>E</span>')
  })
})
