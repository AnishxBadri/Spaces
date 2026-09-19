import { describe, expect, it } from 'vitest'
import { resolveTestDatabaseUrl } from './test-db.ts'

/**
 * The derivation, and the two refusals (SPA-143). Pure — no database, no
 * environment — which is the reason `resolveTestDatabaseUrl` takes its env as
 * an argument instead of reading `process.env`: the rule that decides which
 * database the whole suite writes to should be provable without running the
 * suite.
 */

const DEV = 'postgresql://spaces:spaces@localhost:5432/spaces'

describe('resolveTestDatabaseUrl', () => {
  it('suffixes _test onto the database name and changes nothing else', () => {
    const url = new URL(resolveTestDatabaseUrl({ DATABASE_URL: DEV }))
    expect(url.pathname).toBe('/spaces_test')
    expect(url.host).toBe('localhost:5432')
    expect(url.username).toBe('spaces')
  })

  it('lets DATABASE_URL_TEST override the derived default', () => {
    const override = 'postgresql://spaces:spaces@localhost:5432/somewhere_else'
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: DEV,
        DATABASE_URL_TEST: override,
      }),
    ).toBe(override)
  })

  it('refuses an override that names the database the app is showing', () => {
    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL: DEV, DATABASE_URL_TEST: DEV }),
    ).toThrow(/same database as DATABASE_URL/)
  })

  it('refuses when there is nothing to derive from', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(
      /neither DATABASE_URL_TEST nor DATABASE_URL/,
    )
  })
})
