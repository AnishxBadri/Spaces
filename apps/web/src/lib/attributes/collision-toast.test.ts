import { describe, expect, it } from 'vitest'
import { collisionToast } from './collision-toast'

/**
 * SPA-97. The toast fires on the client, so the wiring is proven by typing
 * (both server fns now return `identity`/`identityValues`) and the decision
 * itself is proven here: which outcome speaks, what it says, and the three
 * that stay quiet.
 *
 * Pure — no database, no React, no `sonner`.
 */
describe('collisionToast', () => {
  it('names the object singular and the normalized value, and points at the inbox in prose', () => {
    expect(
      collisionToast(
        {
          identity: { domain: 'suggested_duplicate' },
          identityValues: { domain: 'acme.com' },
        },
        'Fund',
      ),
    ).toEqual({
      title: 'Another Fund claims acme.com',
      description: 'Both records exist. Review the pair in the review inbox.',
    })
  })

  it('carries no action and no link — the precedent is title plus description', () => {
    const toast = collisionToast(
      {
        identity: { domain: 'suggested_duplicate' },
        identityValues: { domain: 'acme.com' },
      },
      'Fund',
    )
    expect(Object.keys(toast ?? {}).sort()).toEqual(['description', 'title'])
  })

  it('says the value the index compared, not the one that was typed', () => {
    // `https://Acme.com/` normalizes to `acme.com` before the claim is
    // made; the sentence has to match the row in the inbox.
    expect(
      collisionToast(
        {
          identity: { website: 'suggested_duplicate' },
          identityValues: { website: 'acme.com' },
        },
        'Vendor',
      )?.title,
    ).toBe('Another Vendor claims acme.com')
  })

  it("keeps the operator's casing — an object named LP never reads 'lp'", () => {
    expect(
      collisionToast(
        {
          identity: { domain: 'suggested_duplicate' },
          identityValues: { domain: 'acme.com' },
        },
        'LP',
      )?.title,
    ).toBe('Another LP claims acme.com')
  })

  it.each(['added', 'already_own', 'released'] as const)(
    'stays silent on %s',
    (outcome) => {
      expect(
        collisionToast(
          {
            identity: { domain: outcome },
            identityValues: { domain: 'acme.com' },
          },
          'Fund',
        ),
      ).toBeNull()
    },
  )

  it('stays silent when the write asserted no identity key at all', () => {
    expect(
      collisionToast({ identity: {}, identityValues: {} }, 'Fund'),
    ).toBeNull()
  })

  it('finds the collision among slugs that succeeded', () => {
    expect(
      collisionToast(
        {
          identity: { linkedin: 'added', domain: 'suggested_duplicate' },
          identityValues: {
            linkedin: 'linkedin.com/company/acme',
            domain: 'acme.com',
          },
        },
        'Fund',
      )?.title,
    ).toBe('Another Fund claims acme.com')
  })
})
