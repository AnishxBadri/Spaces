import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { manifestSchema, satisfiesSdk, settingsJsonSchema } from '@spaces/sdk'
import { build } from 'vite'
import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import { manifest } from './manifest.ts'

/**
 * The Apollo bundle as the loader will find it: `vite build` with this
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

describe('the apollo bundle', () => {
  it('imports @spaces/sdk, effect and zod and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual([
      '@spaces/sdk',
      '@spaces/sdk/identity',
      'effect',
      'zod',
    ])
    expect(bundle).not.toMatch(/node_modules/)
    expect(
      [...bundle.matchAll(/^\/\/#region (.+)$/gm)].map((m) => m[1]),
    ).toEqual(['src/map.ts', 'src/manifest.ts', 'src/index.ts'])
  })
})

describe('the apollo manifest.json', () => {
  it('parses under manifestSchema, requiring a workspace enrichment key', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.id).toBe('apollo')
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.requires).toEqual({
      credential: { kind: 'enrichment', scope: 'workspace' },
    })
    expect(parsed.http).toEqual({ rateLimit: { rpm: 50 } })
    expect(Object.keys(parsed.jobs)).toEqual([
      'enrichCompany',
      'enrichPerson',
      'onCompanyCreated',
    ])
    expect(parsed.jobs.onCompanyCreated).toMatchObject({
      trigger: 'event',
      on: ['entity.created'],
    })
    expect(parsed.actions?.map((a) => [a.on, a.job])).toEqual([
      ['company', 'enrichCompany'],
      ['person', 'enrichPerson'],
    ])
    expect(parsed.settings).toEqual(settingsJsonSchema(manifest.settings))
  })

  it('defaults the cache to 90 days, carries a daily credit cap and leaves autoEnrich off', () => {
    expect(z.parse(manifest.settings, {})).toEqual({
      cacheDays: 90,
      dailyCreditCap: 100,
      autoEnrich: false,
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

/**
 * The plugin fence on this package: source text linted through the
 * workspace's eslint config at a path inside plugins/apollo. Nothing is
 * written to disk, so only `no-restricted-imports` runs, untyped.
 */
describe('the plugin fence', { timeout: 60_000 }, () => {
  const eslint = new ESLint({
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
    overrideConfig: {
      languageOptions: {
        parserOptions: { project: null, projectService: false },
      },
    },
  })
  const lint = async (code: string) =>
    (
      (
        await eslint.lintText(code, { filePath: 'plugins/apollo/src/leak.ts' })
      ).at(0)?.messages ?? []
    ).map((m) => m.message)

  it.each([
    "import { db } from '@spaces/db'",
    "import { storeCredential } from '@spaces/core/writes/vault'",
  ])('refuses %s', async (line) => {
    const found = await lint(`${line}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/A plugin imports @spaces\/sdk only/)
  })

  it('allows @spaces/sdk', async () => {
    expect(
      await lint("import { isRoleEmail } from '@spaces/sdk/identity'\n"),
    ).toEqual([])
  })
})
