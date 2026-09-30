import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { manifestSchema, satisfiesSdk, settingsJsonSchema } from '@spaces/sdk'
import { packPlugin, readTar } from '@spaces/sdk/pack'
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
    expect(Object.keys(parsed.jobs)).toEqual(['echo', 'enrich'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
  })

  it('carries settings as the JSON Schema of the authored zod schema', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.settings).toEqual(settingsJsonSchema(manifest.settings))
  })
})

describe('the echo tarball (sdk-21a)', () => {
  it('round-trips through the packer: signed, and unpacking to the same bytes', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const out = mkdtempSync(path.join(tmpdir(), 'spaces-echo-pack-'))
    const packed = await packPlugin({
      distDir: path.join(root, 'dist'),
      outDir: out,
      privateKey,
    })
    expect(path.basename(packed.tarball)).toBe('echo-0.1.0.tgz')
    const tgz = readFileSync(packed.tarball)
    expect(
      verify(null, tgz, publicKey, Buffer.from(packed.sig ?? '', 'base64')),
    ).toBe(true)
    const files = readTar(gunzipSync(tgz))
    expect(files.map((f) => f.path)).toEqual(['bundle.mjs', 'manifest.json'])
    for (const f of files) {
      expect(new TextDecoder().decode(f.data)).toBe(read(f.path))
    }
  })
})
