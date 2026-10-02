import { describe, expect, it } from 'vitest'
import { resolveTestDatabaseUrl } from './test-db.ts'

/**
 * The test-database derivation and its two refusals. Pure: that is why
 * `resolveTestDatabaseUrl` takes env as an argument, so the rule deciding
 * which database the suite writes to is provable without a database.
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
