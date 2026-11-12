import { Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The google-calendar bundle as the loader will find it: `vite build` with
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

describe('the google-calendar bundle', () => {
  it('imports @spaces/sdk and effect and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect'])
    expect(bundle).not.toMatch(/node_modules/)
  })
})

describe('the google-calendar manifest.json', () => {
  it('is a syncer: one schedule job over a read-only calendar connection', () => {
    const parsed = Schema.decodeUnknownSync(manifestSchema)(emitted)
    expect(parsed.id).toBe('google-calendar')
    expect(parsed.roles).toEqual(['email-calendar'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.provides).toBeUndefined()
    expect(parsed.requires).toEqual({
      connection: { provider: 'google', scopes: ['calendar.events.readonly'] },
    })
    expect(parsed.jobs).toEqual({
      sync: {
        trigger: 'schedule',
        schedule: '*/15 * * * *',
        uses: ['Secrets', 'Http', 'Content', 'Log'],
      },
    })
  })

  it('has the version the package declares', () => {
    const pkg = Schema.decodeUnknownSync(
      Schema.Struct({ version: Schema.String }),
    )(
      JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ),
    )
    expect(Schema.decodeUnknownSync(manifestSchema)(emitted).version).toBe(
      pkg.version,
    )
  })
})
