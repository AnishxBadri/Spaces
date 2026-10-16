import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Effect, Layer } from 'effect'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import type { StorageSourceProvider } from '@spaces/sdk'
import {
  ConfigTest,
  HttpFetchTest,
  LogTest,
  SecretsTest,
  makeFakeBoxApi,
} from '@spaces/sdk/testing'
import { build } from 'vite'
import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import { manifest } from './manifest.ts'

/**
 * The box bundle as the loader will find it: `vite build` with
 * this package's config writes dist/bundle.mjs and dist/manifest.json.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) =>
  readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')

let bundle = ''
let emitted: unknown

beforeAll(async () => {
  await build({ root, configFile: `${root}vite.config.ts`, logLevel: 'silent' })
  bundle = read('bundle.mjs')
  emitted = JSON.parse(read('manifest.json'))
}, 60_000)

describe('the box bundle', () => {
  it('imports @spaces/sdk, effect and zod and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect', 'zod'])
    expect(bundle).not.toMatch(/node_modules/)
  })

  it('exports a storageSource the host can build over its ports', async () => {
    const exported = z
      .object({
        default: z.object({
          storageSource: z.custom<StorageSourceProvider>((value) =>
            Effect.isEffect(value),
          ),
        }),
      })
      .parse(
        await import(
          /* @vite-ignore */ pathToFileURL(`${root}dist/bundle.mjs`).href
        ),
      )
    const api = makeFakeBoxApi()
    const source = await Effect.runPromise(
      Effect.provide(
        exported.default.storageSource,
        // The four ports the host binds a provider to.
        Layer.mergeAll(
          HttpFetchTest(api.fetch).layer,
          SecretsTest({ accessToken: api.accessToken }).layer,
          ConfigTest({}).layer,
          LogTest().layer,
        ),
      ),
    )
    const page = await Effect.runPromise(source.listFolder('1001'))
    expect(page.entries).toHaveLength(5)
  })
})

describe('the box manifest.json', () => {
  it('provides a storage source over a root_readonly connection, with one schedule job', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.id).toBe('box')
    expect(parsed.roles).toEqual(['files'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.provides).toBe('storage-source')
    expect(parsed.requires).toEqual({
      connection: { provider: 'box', scopes: ['root_readonly'] },
    })
    expect(parsed.jobs).toEqual({
      list: {
        trigger: 'schedule',
        schedule: '0 6 * * *',
        uses: ['Config', 'Http', 'Secrets', 'Log'],
      },
    })
  })

  it('carries the folder as one scalar setting', () => {
    expect(manifestSchema.parse(emitted).settings).toMatchObject({
      type: 'object',
      properties: {
        folderId: { type: 'string', pattern: '^\\d+$', title: 'Folder id' },
      },
      required: ['folderId'],
    })
    expect(z.safeParse(manifest.settings, { folderId: '1001' }).success).toBe(
      true,
    )
    expect(z.safeParse(manifest.settings, { folderId: 'abc' }).success).toBe(
      false,
    )
  })

  it('has the version the package declares', () => {
    const pkg = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ),
      )
    expect(manifestSchema.parse(emitted).version).toBe(pkg.version)
  })
})
