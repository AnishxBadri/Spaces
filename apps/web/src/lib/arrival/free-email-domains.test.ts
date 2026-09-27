import { describe, expect, it } from 'vitest'
import {
  FREE_MAIL_DOMAINS,
  registrableDomain,
} from '@spaces/core/entities/normalize'
import { FREE_EMAIL_DOMAINS, isFreeEmailDomain } from './free-email-domains'

/**
 * D34's data file, held to the shape its lookup depends on. No Postgres.
 */

describe('the free email provider list', () => {
  const list = [...FREE_EMAIL_DOMAINS]

  it('carries the providers D34 names, and more', () => {
    for (const d of [
      'gmail.com',
      'outlook.com',
      'yahoo.com',
      'proton.me',
      'icloud.com',
    ]) {
      expect(FREE_EMAIL_DOMAINS.has(d)).toBe(true)
    }
    expect(list.length).toBeGreaterThanOrEqual(35)
  })

  it('every entry is lowercase, trimmed and its own registrable domain', () => {
    for (const d of list) {
      expect(d).toBe(d.trim().toLowerCase())
      // The lookup reduces a host to its registrable domain; an entry that is
      // not one could never be reached.
      expect(registrableDomain(d)).toBe(d)
    }
  })

  it('is a superset of the list core refuses to key a company on', () => {
    const missing = [...FREE_MAIL_DOMAINS].filter(
      (d) => !FREE_EMAIL_DOMAINS.has(d),
    )
    expect(missing).toEqual([])
  })

  it('judges a host on its registrable domain', () => {
    expect(isFreeEmailDomain('Gmail.com')).toBe(true)
    expect(isFreeEmailDomain('mail.yahoo.co.uk')).toBe(true)
    expect(isFreeEmailDomain('acme.io')).toBe(false)
    // A lookalike is not the provider.
    expect(isFreeEmailDomain('gmail.com.acme.io')).toBe(false)
    expect(isFreeEmailDomain('notgmail.com')).toBe(false)
  })
})
