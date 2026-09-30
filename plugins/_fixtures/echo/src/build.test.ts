import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestSchema, satisfiesSdk, settingsJsonSchema } from '@spaces/sdk'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'
import { manifest } from './manifest.ts'

/**
 * The plugin build, end to end on the first plugin: `vite build` with this
 * package's config (`@spaces/sdk/build`) writes dist/bundle.mjs and
 * dist/manifest.json — exactly what the loader will find under
 * /data/plugins/echo/current/ (docs/spec-plugin-sdk.md §7).
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) =>
  readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')

let bundle = ''
let emitted: unknown

beforeAll(async () => {
  await build({
    root,
    configFile: `${root}vite.config.ts`,
    logLevel: 'silent',
  })
  bundle = read('bundle.mjs')
  emitted = JSON.parse(read('manifest.json'))
}, 60_000)

describe('the echo bundle', () => {
  it('leaves effect, zod and @spaces/sdk as bare imports for the host', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect', 'zod'])
  })

  it('inlines no copy of either runtime', () => {
    // An inlined dependency arrives as a `//#region ../node_modules/…` block;
    // the fixture's own code is two small modules.
    expect(bundle).not.toMatch(/node_modules/)
    expect(bundle).not.toMatch(/\bZodType\b|\bEffectTypeId\b/)
    expect(bundle.length).toBeLessThan(4_000)
  })
})

describe('the echo manifest.json', () => {
  it('parses under manifestSchema', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.id).toBe('echo')
    expect(Object.keys(parsed.jobs)).toEqual(['echo'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
  })

  it('carries settings as the JSON Schema of the authored zod schema', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.settings).toEqual(settingsJsonSchema(manifest.settings))
  })
})
