import { Option, Schema } from 'effect'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { manifestSchema, satisfiesSdk, settingsJsonSchema } from '@spaces/sdk'
import { build } from 'vite'
import { beforeAll, describe, expect, it } from 'vitest'
import { manifest, watchSettings } from './manifest.ts'

/**
 * The Exa bundle as the loader will find it: `vite build` with this
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

describe('the exa bundle', () => {
  it('imports @spaces/sdk and effect and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual([
      '@spaces/sdk',
      '@spaces/sdk/identity',
      'effect',
    ])
    expect(bundle).not.toMatch(/node_modules/)
  })
})

describe('the exa manifest.json', () => {
  it('parses under manifestSchema: a research action and a watch, requiring a workspace search key', () => {
    const parsed = Schema.decodeUnknownSync(manifestSchema)(emitted)
    expect(parsed.id).toBe('exa')
    expect(parsed.roles).toEqual(['research'])
    expect(parsed).not.toHaveProperty('kind')
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.requires).toEqual({
      credential: { kind: 'search', scope: 'workspace' },
    })
    expect(parsed.jobs).toEqual({
      research: {
        trigger: 'action',
        uses: [
          'Config',
          'Secrets',
          'Http',
          'Read',
          'Content',
          'Ai',
          'Judgment',
        ],
      },
      watch: {
        trigger: 'watch',
        uses: [
          'Config',
          'Secrets',
          'Http',
          'Spaces',
          'Discover',
          'Content',
          'Log',
          'Receipts',
        ],
        settings: settingsJsonSchema(watchSettings),
      },
    })
    expect(parsed.actions).toEqual([
      { id: 'research', label: 'Research', on: 'company', job: 'research' },
    ])
    expect(parsed.settings).toEqual(settingsJsonSchema(manifest.settings))
    expect(parsed.mcp).toEqual({
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa',
      auth: { header: 'x-api-key' },
    })
  })

  it('defaults to five pages from the last 90 days', () => {
    expect(Schema.decodeUnknownSync(manifest.settings)({})).toEqual({
      maxResults: 5,
      lookbackDays: 90,
    })
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(manifest.settings)({ maxResults: 0 }),
      ),
    ).toBe(false)
  })

  it('a watch defaults to the space’s criteria and ten companies a run', () => {
    expect(Schema.decodeUnknownSync(watchSettings)({})).toEqual({
      criteria: '',
      cap: 10,
    })
    expect(
      Option.isSome(Schema.decodeUnknownOption(watchSettings)({ cap: 0 })),
    ).toBe(false)
    expect(
      Option.isSome(Schema.decodeUnknownOption(watchSettings)({ cap: 101 })),
    ).toBe(false)
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

/**
 * The plugin fence on this package: source text linted through the
 * workspace's eslint config at a path inside plugins/exa. Nothing is written
 * to disk, so only `no-restricted-imports` runs, untyped.
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
      (await eslint.lintText(code, { filePath: 'plugins/exa/src/leak.ts' })).at(
        0,
      )?.messages ?? []
    ).map((m) => m.message)

  it.each([
    "import { db } from '@spaces/db'",
    "import { complete } from '@spaces/core/ai/complete'",
  ])('refuses %s', async (line) => {
    const found = await lint(`${line}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/A plugin imports @spaces\/sdk only/)
  })

  it('allows @spaces/sdk', async () => {
    expect(await lint("import { Ai } from '@spaces/sdk'\n")).toEqual([])
  })
})
