import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * The two dependency fences, proved on the real packages (SPA-191). Until
 * this slice `SDK_IMPORTS_NOTHING_INTERNAL` and `PLUGIN_IMPORTS_SDK_ONLY`
 * (packages/config/eslint.base.js) were proved against placeholder fixture
 * directories; now @spaces/sdk and plugins/_fixtures/echo exist, so the
 * failing case runs where it matters. This lints source text through the
 * workspace's own eslint config (the root shim), at a path inside each
 * package, and expects the zone's message — nothing is written to disk.
 *
 * Only `no-restricted-imports` runs, and without type information: the
 * files do not exist, so the type-aware parser has no program to put them
 * in, and the zone is a pattern match on the specifier that needs none.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))

const eslint = new ESLint({
  cwd: root,
  ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
  overrideConfig: {
    languageOptions: {
      parserOptions: { project: null, projectService: false },
    },
  },
})

const lint = async (filePath: string, code: string) => {
  const result = (await eslint.lintText(code, { filePath })).at(0)
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`)
}

describe('the sdk fence', () => {
  it.each([
    "import { fmtMoney } from '@spaces/core/portfolio/format'",
    "import { db } from '@spaces/db'",
    "import { entity } from '@spaces/db/schema'",
    "import { x } from '../../core/src/format.ts'",
  ])('refuses %s in packages/sdk', async (line) => {
    const found = await lint('packages/sdk/src/leak.ts', `${line}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(
      /^no-restricted-imports: .*@spaces\/sdk imports effect, zod and tldts and nothing internal/,
    )
  })

  it('allows effect and zod', async () => {
    const found = await lint(
      'packages/sdk/src/fine.ts',
      "import { Effect } from 'effect'\nimport { z } from 'zod'\n",
    )
    expect(found).toEqual([])
  })
})

describe('the plugin fence', () => {
  it.each([
    "import { db } from '@spaces/db'",
    "import { resolveEntity } from '@spaces/core/writes/entities/resolve'",
    "import { x } from '../../../packages/core/src/format.ts'",
  ])('refuses %s in the echo fixture', async (line) => {
    const found = await lint('plugins/_fixtures/echo/src/leak.ts', `${line}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(
      /^no-restricted-imports: .*A plugin imports @spaces\/sdk only/,
    )
  })

  it('allows @spaces/sdk', async () => {
    const found = await lint(
      'plugins/_fixtures/echo/src/fine.ts',
      "import { definePlugin } from '@spaces/sdk'\n",
    )
    expect(found).toEqual([])
  })
})

describe('the plugin clock rule (sdk-5: Clock is not a port)', () => {
  const clockLint = new ESLint({
    cwd: root,
    ruleFilter: ({ ruleId }) =>
      ruleId === 'no-restricted-properties' ||
      ruleId === 'no-restricted-syntax',
    overrideConfig: {
      languageOptions: {
        parserOptions: { project: null, projectService: false },
      },
    },
  })
  const lintClock = async (code: string) => {
    const result = (
      await clockLint.lintText(code, {
        filePath: 'plugins/_fixtures/echo/src/clock.ts',
      })
    ).at(0)
    return (result?.messages ?? []).map((m) => m.message)
  }

  it.each(['export const t = Date.now()\n', 'export const d = new Date()\n'])(
    'refuses %s in a plugin',
    async (code) => {
      const found = await lintClock(code)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatch(/Plugin code reads time through Effect/)
    },
  )

  it('allows parsing a given date and reading time through Effect', async () => {
    const found = await lintClock(
      "import { Clock } from 'effect'\nexport const at = new Date('2026-09-30')\nexport const now = Clock.currentTimeMillis\n",
    )
    expect(found).toEqual([])
  })
})
