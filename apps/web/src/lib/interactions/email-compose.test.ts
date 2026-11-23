import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entityAlias,
  interactionStat,
  link,
  person,
} from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema/entities'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { saveDraftProgram } from './email-drafts'
import { openComposeProgram } from './email-compose'

/**
 * The composer's opening read: To from the record a new email starts on
 * (the person; the person last emailed at a company, or at a deal's
 * company; nobody elsewhere), and a draft held under the id reopened as it
 * was, with no prefill over it.
 */

const ME = { id: FIXTURE_ACTOR.id }

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

const anEntity = async (
  kind: 'person' | 'company' | 'deal' | 'custom',
  name: string,
  values: EntityValues = {},
) => {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name, values })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error(`no ${kind}`)
  return row.id
}

/** A person with an email alias, at `companyId`, last emailed `lastEmailAt`. */
const aPerson = async (
  name: string,
  email: string,
  companyId: string | null,
  lastEmailAt: string | null,
) => {
  const id = await anEntity(
    'person',
    name,
    companyId === null ? {} : { companies: [companyId] },
  )
  await db.insert(person).values({ entityId: id })
  await db.insert(entityAlias).values({
    entityId: id,
    kind: 'email',
    value: email,
    valueNorm: email.toLowerCase(),
    isIdentity: true,
  })
  if (companyId !== null)
    await db.insert(link).values({
      fromEntityId: id,
      toEntityId: companyId,
      relation: 'references',
      attrSlug: 'companies',
    })
  if (lastEmailAt !== null)
    await db.insert(interactionStat).values({
      entityId: id,
      kind: 'email',
      lastAt: new Date(lastEmailAt),
    })
  return id
}

const aCompany = async (name: string) => {
  const id = await anEntity('company', name)
  await db.insert(company).values({ entityId: id })
  return id
}

const open = (recordId: string | null, draftId: string | null = null) =>
  run(openComposeProgram(ME, { draftId, recordId }))

beforeEach(async () => {
  await truncateAndReseed()
})

describe('openComposeProgram', () => {
  it('fills To with the person on a person', async () => {
    const dev = await aPerson('Dev Shah', 'Dev@flent.example', null, null)
    const opened = await open(dev)
    expect(opened.to).toEqual([
      { email: 'Dev@flent.example', entityId: dev, name: 'Dev Shah' },
    ])
    expect(opened.record).toEqual({ id: dev, name: 'Dev Shah' })
    expect(opened.draft).toBeNull()
  })

  it('fills To with the person last emailed at a company', async () => {
    const flent = await aCompany('Flent')
    await aPerson(
      'Dev Shah',
      'dev@flent.example',
      flent,
      '2026-11-10T09:00:00.000Z',
    )
    const priya = await aPerson(
      'Priya Raman',
      'priya@flent.example',
      flent,
      '2026-11-18T09:00:00.000Z',
    )
    await aPerson('Meera Nair', 'meera@flent.example', flent, null)
    expect((await open(flent)).to).toEqual([
      { email: 'priya@flent.example', entityId: priya, name: 'Priya Raman' },
    ])
  })

  it('fills To on a deal from its company', async () => {
    const flent = await aCompany('Flent')
    const dev = await aPerson(
      'Dev Shah',
      'dev@flent.example',
      flent,
      '2026-11-10T09:00:00.000Z',
    )
    const deal = await anEntity('deal', 'Flent seed', { company: flent })
    expect((await open(deal)).to).toEqual([
      { email: 'dev@flent.example', entityId: dev, name: 'Dev Shah' },
    ])
  })

  it('leaves To empty where nobody was emailed, on a deal with no company, and on any other record', async () => {
    const quiet = await aCompany('Quiet Co')
    await aPerson('Meera Nair', 'meera@quiet.example', quiet, null)
    expect((await open(quiet)).to).toEqual([])
    const orphan = await anEntity('deal', 'No company')
    expect((await open(orphan)).to).toEqual([])
    const lp = await anEntity('custom', 'An LP')
    expect((await open(lp)).to).toEqual([])
    expect(await open(null)).toEqual({ draft: null, to: [], record: null })
  })

  it('reopens a draft held under the id as it was, with no prefill', async () => {
    const dev = await aPerson('Dev Shah', 'dev@flent.example', null, null)
    const id = randomUUID()
    await run(
      saveDraftProgram(ME, {
        id,
        mode: 'new',
        inReplyToId: null,
        to: [{ email: 'priya@flent.example' }],
        cc: [],
        bcc: [],
        subject: 'Data room',
        bodyMd: 'The link.',
        attachments: [],
      }),
    )
    const opened = await open(dev, id)
    expect(opened.draft?.subject).toBe('Data room')
    expect(opened.draft?.to).toEqual([{ email: 'priya@flent.example' }])
    expect(opened.to).toEqual([])
    expect(opened.record).toEqual({ id: dev, name: 'Dev Shah' })
  })

  it('opens an id with no draft behind it as a new email', async () => {
    const dev = await aPerson('Dev Shah', 'dev@flent.example', null, null)
    const opened = await open(dev, randomUUID())
    expect(opened.draft).toBeNull()
    expect(opened.to.map((r) => r.email)).toEqual(['dev@flent.example'])
  })
})
