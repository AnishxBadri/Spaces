import { readFile } from 'node:fs/promises'
import { test as base } from '@playwright/test'
import { Client } from 'pg'
import { ENV, fromEnv } from './shared.ts'
import type { EnvName } from './shared.ts'

type Target = {
  /** Where the instance answers, `http://localhost:<port>`. */
  readonly url: string
  /** `select count(*) from "user"` on the instance's own database. */
  readonly userCount: () => Promise<number>
  /**
   * Marks the server log where it ends now; the returned function reads
   * what the server has written since. Better Auth answers every hook
   * refusal with one generic `FAILED_TO_CREATE_USER` and logs the hook's own
   * error beside it, so the log is where a spec tells *which* check refused
   * — the setup-token hook, the closed-signup hook, or something else
   * entirely (the CSRF origin check, the rate limiter) that would make a
   * refusal pass for the wrong reason.
   */
  readonly logMark: () => Promise<() => Promise<string>>
}

function target(urlVar: EnvName, logVar: EnvName, dbVar: EnvName): Target {
  const url = fromEnv(urlVar)
  const logFile = fromEnv(logVar)
  const connectionString = fromEnv(dbVar)
  return {
    url,
    logMark: async () => {
      const at = (await readFile(logFile, 'utf8')).length
      return async () => (await readFile(logFile, 'utf8')).slice(at)
    },
    userCount: async () => {
      const client = new Client({ connectionString })
      await client.connect()
      try {
        const res = await client.query<{ n: string }>(
          'select count(*)::text as n from "user"',
        )
        return Number(res.rows.at(0)?.n ?? 0)
      } finally {
        await client.end()
      }
    },
  }
}

/**
 * The two instances global setup booted: `main` has an admin, `firstRun`
 * has nobody. A spec names the one it needs; nothing is shared implicitly
 * through `baseURL`, because the two answer on different ports.
 */
// The fixture callback is named `provide`, not Playwright's usual `use`: the
// react-hooks lint rule reads any call to `use()` as React's hook.
export const test = base.extend<{ main: Target; firstRun: Target }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  main: async ({}, provide) => {
    await provide(target(ENV.mainUrl, ENV.mainLog, ENV.mainDb))
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  firstRun: async ({}, provide) => {
    await provide(target(ENV.firstrunUrl, ENV.firstrunLog, ENV.firstrunDb))
  },
})

export { expect } from '@playwright/test'
