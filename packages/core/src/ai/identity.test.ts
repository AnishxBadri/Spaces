import { describe, expect, it } from 'vitest'
import { identityPayloadOf, readIdentityPayload } from './identity'

/** SPA-105 — the identity suggestion's payload, decoded once. */
describe('the identity payload', () => {
  it('reads a claim and drops what is not a person key', () => {
    expect(
      identityPayloadOf({ name: 'Ada', role: 'CEO', email: undefined }),
    ).toEqual({ name: 'Ada', role: 'CEO' })
    expect(
      readIdentityPayload({ name: ' Ada ', linkedin: 'linkedin.com/in/ada' }),
    ).toEqual({ name: 'Ada', linkedin: 'linkedin.com/in/ada' })
  })

  it('refuses anything that is not an identity', () => {
    expect(readIdentityPayload({ name: '' })).toBeNull()
    expect(readIdentityPayload({ name: 'Ada', domain: 'x.com' })).toBeNull()
    expect(
      readIdentityPayload({ name: 'Ada', email: 'not-an-email' }),
    ).toBeNull()
    expect(readIdentityPayload(['Ada'])).toBeNull()
  })
})
