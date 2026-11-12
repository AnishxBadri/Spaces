import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * `effect/io-is-effect`, through the workspace's own eslint config (the root
 * shim) at paths inside and outside its zone: a `lib/` module that imports
 * the `db` value imports `effect`. The lint gate runs it over the real tree;
 * this holds what it reports and what it leaves alone. Nothing is written to
 * disk, and only this rule runs, without type information.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url))

const eslint = new ESLint({
  cwd: root,
  ruleFilter: ({ ruleId }) => ruleId === 'effect/io-is-effect',
  overrideConfig: {
    languageOptions: {
      parserOptions: { project: null, projectService: false },
    },
  },
})

const lint = async (code: string, filePath = 'apps/web/src/lib/x/probe.ts') => {
  const result = (await eslint.lintText(code, { filePath })).at(0)
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`)
}

const QUERY = 'export const rows = () => db.select().from(entity)\n'

describe('effect/io-is-effect', () => {
  it.each([
    "import { db } from '@spaces/db'",
    "import { db } from '#/db'",
    "import { db as database } from '@spaces/db'",
    "import * as data from '@spaces/db'",
  ])('refuses %s without effect', async (line) => {
    const found = await lint(`${line}\n${QUERY}`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(
      /^effect\/io-is-effect: This module imports the `db` value and nothing from `effect`/,
    )
  })

  it('refuses a dynamic import of the db module', async () => {
    expect(
      await lint(
        "export const rows = async () => (await import('@spaces/db')).db\n",
      ),
    ).toHaveLength(1)
  })

  it('refuses when effect arrives as types only', async () => {
    for (const line of [
      "import type { Effect } from 'effect'",
      "import { type Effect } from 'effect'",
    ])
      expect(
        await lint(`${line}\nimport { db } from '@spaces/db'\n${QUERY}`),
        line,
      ).toHaveLength(1)
  })

  it('passes a db module that imports effect', async () => {
    for (const line of [
      "import { Effect } from 'effect'",
      "import { Schema } from 'effect'",
      "import { Schema } from 'effect/Schema'",
    ])
      expect(
        await lint(`${line}\nimport { db } from '@spaces/db'\n${QUERY}`),
        line,
      ).toEqual([])
  })

  it('leaves type-only and schema imports alone', async () => {
    for (const line of [
      "import type { db } from '@spaces/db'",
      "import { type db } from '@spaces/db'",
      "import { entity } from '@spaces/db/schema'",
      "import type { EntityValues } from '@spaces/db/schema/entities'",
    ])
      expect(await lint(`${line}\n`), line).toEqual([])
  })

  it('reaches only non-test files under apps/web/src/lib', async () => {
    const code = `import { db } from '@spaces/db'\n${QUERY}`
    expect(await lint(code, 'apps/web/src/lib/x/probe.test.ts')).toEqual([])
    expect(await lint(code, 'apps/web/src/db/probe.ts')).toEqual([])
    expect(await lint(code, 'apps/web/src/lib/x/probe.tsx')).toHaveLength(1)
  })

  it('honours a stated exemption on the import', async () => {
    expect(
      await lint(
        `// eslint-disable-next-line effect/io-is-effect -- builds SQL and runs none\nimport { db } from '@spaces/db'\n${QUERY}`,
      ),
    ).toEqual([])
  })
})
