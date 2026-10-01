import {
  isRoleEmail,
  normalizeDomain,
  normalizeEmail,
} from '@spaces/sdk/identity'
import { describe, expect, it } from 'vitest'

/**
 * A plugin normalizes an identity claim's keys with the SDK alone (sdk-4b) —
 * the same functions `resolveEntity` runs, since core re-exports these.
 */
describe('identity keys, from @spaces/sdk only', () => {
  it('normalizes a subdomain to its registrable domain', () => {
    expect(normalizeDomain('app.stripe.co.uk')).toBe('stripe.co.uk')
    expect(normalizeDomain('https://www.stripe.co.uk/pricing')).toBe(
      'stripe.co.uk',
    )
  })

  it('refuses to mint a company from a free-mail domain', () => {
    expect(normalizeDomain('gmail.com')).toBeNull()
  })

  it('rejects a role email as a person identity', () => {
    expect(isRoleEmail('careers@stripe.com')).toBe(true)
    expect(isRoleEmail('patrick@stripe.com')).toBe(false)
    expect(normalizeEmail('Patrick@Stripe.com')).toBe('patrick@stripe.com')
  })
})
