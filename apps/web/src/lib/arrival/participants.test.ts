import { describe, expect, it } from 'vitest'
import type { Address } from './forwarded'
import { companyName, decideParticipants } from './participants'
import type { ParticipantDecision, ParticipantsInput } from './participants'

/**
 * SPA-86's judgement as a table, no Postgres: which address may create a
 * person, a company, both or neither, and which is only ever attached or
 * ignored. The fund is `fund.example`, with two members, one of them on
 * Gmail.
 */

const at = (email: string, name: string | null = null): Address => ({
  email,
  name,
})

const WORKSPACE: Pick<ParticipantsInput, 'ownDomains' | 'memberEmails'> = {
  ownDomains: ['fund.example', 'gmail.com'],
  memberEmails: ['Anish@Fund.example', 'a.partner@gmail.com'],
}

function decide(
  from: Address | null,
  to: Array<Address> = [],
  cc: Array<Address> = [],
): Array<ParticipantDecision> {
  return decideParticipants({ from, to, cc, ...WORKSPACE })
}

function one(address: Address): ParticipantDecision {
  const decisions = decide(address)
  expect(decisions).toHaveLength(1)
  return decisions[0]
}

describe('decideParticipants', () => {
  it('a work-domain founder creates a person and a company', () => {
    expect(one(at('Jane@Acme-Robotics.io', 'Jane Founder'))).toEqual({
      action: 'create',
      address: 'jane@acme-robotics.io',
      person: { email: 'jane@acme-robotics.io', name: 'Jane Founder' },
      company: { domain: 'acme-robotics.io', name: 'Acme Robotics' },
    })
  })

  it('a subdomain keys the company on its registrable domain', () => {
    const d = one(at('ops@mail.beta.co.uk', 'Ops Person'))
    expect(d.action === 'create' && d.company).toEqual({
      domain: 'beta.co.uk',
      name: 'Beta',
    })
  })

  it.each([
    'lawyer@gmail.com',
    'lawyer@outlook.com',
    'lawyer@yahoo.co.uk',
    'lawyer@proton.me',
    'lawyer@icloud.com',
    'lawyer@tutanota.com',
  ])('a free provider (%s) creates a person and no company', (email) => {
    const d = one(at(email, 'Lee Counsel'))
    expect(d).toMatchObject({ action: 'create', company: null })
    expect(d.action === 'create' && d.person?.name).toBe('Lee Counsel')
  })

  it('a workspace member creates nothing, on a work domain or on Gmail', () => {
    expect(one(at('anish@fund.example'))).toEqual({
      action: 'attach',
      address: 'anish@fund.example',
      reason: 'member',
    })
    // Gmail's dots and +tags are one mailbox, so one member.
    expect(one(at('apartner+deals@gmail.com'))).toMatchObject({
      action: 'attach',
      reason: 'member',
    })
  })

  it('anyone at an own domain creates nothing, member or not', () => {
    expect(one(at('associate@fund.example', 'New Associate'))).toEqual({
      action: 'attach',
      address: 'associate@fund.example',
      reason: 'own-domain',
    })
    expect(one(at('associate@london.fund.example'))).toMatchObject({
      action: 'attach',
      reason: 'own-domain',
    })
  })

  it('a free provider passed as an own domain is not one', () => {
    // `gmail.com` is in WORKSPACE.ownDomains: a stranger on it still counts.
    expect(one(at('stranger@gmail.com'))).toMatchObject({ action: 'create' })
  })

  it.each([
    'no-reply@acme.io',
    'noreply@acme.io',
    'notifications@github.com',
    'mailer-daemon@acme.io',
    'calendar-notification@google.com',
    'NoReply+bounce@acme.io',
  ])('a machine address (%s) is ignored', (email) => {
    expect(one(at(email))).toMatchObject({ action: 'ignore', reason: 'role' })
  })

  it('a shared inbox at a work domain is the company and no person', () => {
    expect(one(at('founders@acme.io', 'Acme Founders'))).toEqual({
      action: 'create',
      address: 'founders@acme.io',
      person: null,
      company: { domain: 'acme.io', name: 'Acme' },
    })
  })

  it('a shared inbox at a free provider is ignored', () => {
    expect(one(at('hello@gmail.com'))).toMatchObject({
      action: 'ignore',
      reason: 'role',
    })
  })

  it.each([
    'not-an-address',
    '@acme.io',
    'jane@',
    'jane@localhost',
    'jane@@acme.io',
    'jane doe@acme.io',
    'jane@acme',
    'jane@-acme-.io',
  ])('a malformed address (%s) is ignored', (email) => {
    expect(one(at(email))).toMatchObject({
      action: 'ignore',
      reason: 'malformed',
    })
  })

  it('decides once per address across From, To and Cc, in header order', () => {
    const decisions = decide(
      at('jane@acme.io', 'Jane'),
      [at('anish@fund.example'), at('JANE@acme.io')],
      [at('raj@acme.io', 'Raj'), at('lee@gmail.com', 'Lee')],
    )
    expect(decisions.map((d) => [d.address, d.action])).toEqual([
      ['jane@acme.io', 'create'],
      ['anish@fund.example', 'attach'],
      ['raj@acme.io', 'create'],
      ['lee@gmail.com', 'create'],
    ])
  })

  it('keeps a display name only when it is a name', () => {
    const name = (n: string | null) => {
      const d = one(at('jane@acme.io', n))
      return d.action === 'create' ? d.person?.name : undefined
    }
    expect(name('"Jane Founder"')).toBe('Jane Founder')
    expect(name('jane@acme.io')).toBe(null)
    expect(name('   ')).toBe(null)
    expect(name(null)).toBe(null)
  })

  it('names a company after the label its registrant chose', () => {
    expect(companyName('acme.io')).toBe('Acme')
    expect(companyName('acme-robotics.co.uk')).toBe('Acme Robotics')
    expect(companyName('deep_mind.ai')).toBe('Deep Mind')
  })
})
