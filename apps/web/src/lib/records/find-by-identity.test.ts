import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { findByIdentityProgram } from './find-by-identity'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The create windows' identity check, against this worker's test database:
 * a typed key finds the record that holds it however it was typed, and an
 * email finds the company its domain names — which is how New person infers
 * the company and how every create window refuses a match.
 */

const find = (key: 'domain' | 'email' | 'linkedin', value: string) =>
  Effect.runPromise(findByIdentityProgram({ key, value }))

async function born(
  kind: 'company' | 'person',
  name: string,
  keys: { domain: string } | { email: string },
): Promise<string> {
  const r = await resolveEntity({
    kind,
    name,
    keys,
    source: { class: 'manual' },
  })
  return r.entityId
}

describe('findByIdentityProgram', () => {
  it('finds the company that holds a domain, however the domain is typed', async () => {
    const id = await born('company', 'Pixxel', { domain: 'pixxel.space' })
    const match = await find('domain', 'https://www.Pixxel.space/about')
    expect(match.owner).toEqual({
      id,
      name: 'Pixxel',
      kind: 'company',
      path: `/companies/${id}`,
    })
    expect(match.company).toBeNull()
  })

  it('infers the company from an email’s domain when no person holds the email', async () => {
    const company = await born('company', 'Orbital', { domain: 'orbital.co' })
    const match = await find('email', 'Awais@orbital.co')
    expect(match.owner).toBeNull()
    expect(match.company).toEqual({ id: company, name: 'Orbital' })
  })

  it('names the person who already holds an email', async () => {
    const person = await born('person', 'Ada Lovelace', {
      email: 'ada@engine.io',
    })
    const match = await find('email', ' ADA@engine.io ')
    expect(match.owner?.id).toBe(person)
    expect(match.owner?.path).toBe(`/people/${person}`)
    expect(match.company).toBeNull()
  })

  it('infers nothing from a free-mail domain or a key that does not parse', async () => {
    await born('company', 'Gmail Inc', { domain: 'gmail-inc.com' })
    expect(await find('email', 'someone@gmail.com')).toEqual({
      owner: null,
      company: null,
    })
    expect(await find('domain', 'not a domain')).toEqual({
      owner: null,
      company: null,
    })
  })
})
