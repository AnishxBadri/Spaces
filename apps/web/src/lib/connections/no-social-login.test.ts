import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A data grant is never a login: connecting Google or Box goes through
 * `/api/connections`, and better-auth stays email-and-password only.
 */
describe('better-auth', () => {
  const source = readFileSync(new URL('../auth.ts', import.meta.url), 'utf8')

  it('configures no social provider', () => {
    expect(source).not.toMatch(/socialProviders|genericOAuth|oAuthProxy/)
  })

  it('keeps email and password', () => {
    expect(source).toMatch(/emailAndPassword:\s*\{\s*enabled:\s*true/)
  })
})
