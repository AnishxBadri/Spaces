import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * `NO_ZOD`, through the workspace's own eslint config (the root shim), at a
 * path in every zone that sets `no-restricted-imports` and at one no zone
 * names. A zone block replaces the catch-all's options rather than extending
 * them, so each row also imports what that zone's own fence refuses and
 * expects both messages: the zod ban did not switch the fence off, and the
 * fence did not switch the zod ban off. The sdk and plugin zones are proved
 * by the sdk's fence test. Nothing is written to disk, and only
 * `no-restricted-imports` runs, without type information.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url))

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

const ZOD = /^no-restricted-imports: .*Nothing imports zod — Effect Schema/

// Each zone's path, a line its own fence refuses, and that fence's message.
// The web rows spell the worker as a relative climb: the plugin-bundle scan
// reads every specifier under apps/web/src, these strings included.
const ZONES = [
  {
    path: 'apps/web/src/routes/_app/probe.tsx',
    fenced: "import { Effect } from 'effect'",
    fence: /Effect never crosses into React/,
  },
  {
    path: 'apps/web/src/components/probe.tsx',
    fenced: "import { x } from '../../worker/src/run-job'",
    fence: /The web app imports @spaces\/core and @spaces\/sdk/,
  },
  {
    path: 'apps/web/src/lib/probe/probe.ts',
    fenced: "import { x } from '../../../../worker/src/run-job'",
    fence: /The web app imports @spaces\/core and @spaces\/sdk/,
  },
  {
    path: 'apps/worker/src/jobs/probe.ts',
    fenced: "import { x } from '#web/routes/login'",
    fence: /The worker imports @spaces\/core and @spaces\/sdk/,
  },
  {
    path: 'packages/core/src/probe.ts',
    fenced: "import { x } from '@spaces/web/lib/queue'",
    fence: /@spaces\/core imports @spaces\/db and @spaces\/sdk/,
  },
  {
    path: 'packages/db/src/probe.ts',
    fenced: "import { x } from '@spaces/core/format'",
    fence: /@spaces\/db imports nothing internal/,
  },
  {
    path: 'apps/e2e/specs/probe.ts',
    fenced: "import { db } from '@spaces/db'",
    fence: /@spaces\/e2e imports nothing internal/,
  },
  {
    path: 'apps/site/src/probe.ts',
    fenced: "import { x } from '@spaces/core/format'",
    fence: /@spaces\/site imports nothing internal/,
  },
]

describe('no zod, in every zone', () => {
  it.each(ZONES)(
    'refuses zod beside its own fence in $path',
    async ({ path, fenced, fence }) => {
      const found = await lint(path, `import { z } from 'zod'\n${fenced}\n`)
      expect(found).toHaveLength(2)
      expect(found.filter((m) => ZOD.test(m))).toHaveLength(1)
      expect(found.filter((m) => fence.test(m))).toHaveLength(1)
    },
  )

  it.each([
    "import { z } from 'zod'",
    "import { z } from 'zod/v4'",
    "import type { ZodType } from 'zod'",
    "export { z } from 'zod/mini'",
  ])('refuses %s where no zone reaches', async (line) => {
    const found = await lint('scripts/probe.ts', `${line}\n`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(ZOD)
  })

  it('leaves a name that only starts with zod alone', async () => {
    const found = await lint(
      'apps/web/src/lib/probe/probe.ts',
      "import { x } from 'zod-validation-error'\nimport { Schema } from 'effect'\n",
    )
    expect(found).toEqual([])
  })
})
