import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import { build } from 'vite'
import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The gmail bundle as the loader will find it: `vite build` with
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

describe('the gmail bundle', () => {
  it('imports @spaces/sdk, effect and zod and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect', 'zod'])
    expect(bundle).not.toMatch(/node_modules/)
  })
})

describe('the gmail manifest.json', () => {
  it('is a syncer and a sender over one mail connection', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.id).toBe('gmail')
    expect(parsed.roles).toEqual(['email-calendar'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.provides).toBeUndefined()
    expect(parsed.requires).toEqual({
      connection: {
        provider: 'google',
        scopes: ['gmail.readonly', 'gmail.send'],
      },
    })
    expect(parsed.jobs).toEqual({
      sync: {
        trigger: 'schedule',
        schedule: '*/5 * * * *',
        uses: ['Secrets', 'Http', 'Content', 'Log'],
      },
      send: {
        trigger: 'action',
        input: 'payload',
        interactive: true,
        retry: 0,
        timeout: '120s',
        uses: ['Secrets', 'Http', 'Content', 'Log'],
      },
    })
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
