import { Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The Airtable bundle as the loader will find it: `vite build` with this
 * package's config writes dist/bundle.mjs and dist/manifest.json.
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

describe('the airtable bundle', () => {
  it('imports @spaces/sdk and effect and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect'])
    expect(bundle).not.toMatch(/node_modules/)
  })
})

describe('the airtable manifest.json', () => {
  it('parses under manifestSchema: one file job, granted Import and Log, accepting an export name', () => {
    const parsed = Schema.decodeUnknownSync(manifestSchema)(emitted)
    expect(parsed.id).toBe('airtable')
    expect(parsed.sdk).toBe('^2.0')
    expect(parsed.roles).toEqual(['import'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.jobs).toEqual({
      stage: {
        trigger: 'file',
        uses: ['Import', 'Log'],
        accepts: { filename: '-[^\\\\/]+ view(?: \\(\\d+\\))?\\.csv$' },
      },
    })
  })

  it('accepts Airtable export names and nothing else', () => {
    const pattern =
      Schema.decodeUnknownSync(manifestSchema)(emitted).jobs.stage.accepts
        ?.filename
    if (pattern === undefined) throw new Error('no accepts')
    const accepts = (name: string) => new RegExp(pattern, 'i').test(name)
    expect(accepts('Companies-Grid view.csv')).toBe(true)
    expect(accepts('Deal flow-Kanban view (1).csv')).toBe(true)
    expect(accepts('companies.csv')).toBe(false)
    expect(accepts('Companies-Grid view.xlsx')).toBe(false)
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
