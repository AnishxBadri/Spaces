import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { interactionStat } from '@spaces/db/schema'
import { UnknownVariable } from '@spaces/core/templates/variables'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { reviewVariablesProgram } from './email-variables'

/**
 * Review (D67): three founders, one with no first name. Every variable is
 * resolved per recipient from the record's values, its current company and
 * its interaction stats; the blank is named in its row.
 */

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

async function aFounder(
  email: string,
  parts: { first_name: string | null; last_name: string },
  companyId: string | null,
) {
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  const { setValues } = await import('@spaces/core/writes/attributes/values')
  const person = await resolveEntity({
    kind: 'person',
    name: [parts.first_name, parts.last_name].filter(Boolean).join(' '),
    keys: { email },
    source: { class: 'manual' },
  })
  await setValues({
    entityId: person.entityId,
    patch: {
      ...parts,
      ...(companyId === null ? {} : { companies: [companyId] }),
    },
    actor: { type: 'user', id: FIXTURE_ACTOR.id },
  })
  return { email, entityId: person.entityId }
}

async function aCompany(name: string, domain: string) {
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  const company = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  return company.entityId
}

beforeEach(async () => {
  await truncateAndReseed()
})

describe('reviewVariablesProgram', () => {
  it('resolves every variable per recipient and flags the blank', async () => {
    const flent = await aCompany('Flent', 'flent.example')
    const northgate = await aCompany('Northgate', 'northgate.example')
    const dana = await aFounder(
      'dana@flent.example',
      { first_name: 'Dana', last_name: 'Moreau' },
      flent,
    )
    const arjun = await aFounder(
      'arjun@northgate.example',
      { first_name: 'Arjun', last_name: 'Rao' },
      northgate,
    )
    const okafor = await aFounder(
      'okafor@lumen.example',
      { first_name: null, last_name: 'Okafor' },
      null,
    )
    await db.insert(interactionStat).values({
      entityId: dana.entityId,
      kind: 'any',
      lastAt: new Date('2026-10-12T10:00:00.000Z'),
    })

    const review = await run(
      reviewVariablesProgram({
        to: [dana, arjun, okafor],
        cc: [],
        bcc: [],
        subject: 'Intro: {{company.name}}',
        bodyMd: 'Hi {{name.first}}, since {{last_interaction.when}}',
      }),
    )
    expect(review.paths).toEqual([
      'company.name',
      'name.first',
      'last_interaction.when',
    ])
    const byEmail = new Map(review.rows.map((r) => [r.email, r]))
    expect(byEmail.get(dana.email)).toMatchObject({
      name: 'Dana Moreau',
      values: {
        'company.name': 'Flent',
        'name.first': 'Dana',
        'last_interaction.when': 'Oct 12, 2026',
      },
      blanks: [],
    })
    expect(byEmail.get(arjun.email)?.values['company.name']).toBe('Northgate')
    expect(byEmail.get(arjun.email)?.blanks).toEqual(['last_interaction.when'])
    expect(byEmail.get(okafor.email)?.blanks).toEqual([
      'company.name',
      'name.first',
      'last_interaction.when',
    ])
  })

  it('reads an address no record holds as blanks, once per address', async () => {
    const review = await run(
      reviewVariablesProgram({
        to: [{ email: 'ops@northgate.example' }],
        cc: [{ email: 'OPS@northgate.example' }],
        bcc: [],
        subject: '',
        bodyMd: 'Hi {{name.first}}, re {{job_title}}',
      }),
    )
    expect(review.rows).toEqual([
      {
        email: 'ops@northgate.example',
        name: null,
        values: { 'name.first': null, job_title: null },
        blanks: ['name.first', 'job_title'],
      },
    ])
  })

  it('refuses a variable no attribute matches, naming it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewVariablesProgram({
          to: [{ email: 'ops@northgate.example' }],
          cc: [],
          bcc: [],
          subject: '',
          bodyMd: 'Hi {{favourite_colour}}',
        }),
      ),
    )
    expect(failure).toBeInstanceOf(UnknownVariable)
    if (!(failure instanceof UnknownVariable)) return
    expect(failure.path).toBe('favourite_colour')
  })
})
