import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { company, entity, link, suggestion } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Enqueue } from '../../queue/enqueue'
import { readSupersedesPayload } from '../../ai/supersedes'
import type { DocumentKind } from '../../documents'
import { markNewerVersionProgram } from '../links/supersedes'
import { intakeDocumentProgram } from './intake'

/**
 * Intake's supersedes suggestion: a second document of a kind filed on
 * a record proposes one link to the latest, and nothing ever writes it.
 */

const NoQueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

async function actorId(): Promise<string> {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('the seed holds no user')
  return row.id
}

async function aCompany(): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Kalpana ${randomUUID()}` })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no company')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function file(
  recordId: string | Array<string>,
  filename: string,
  kind: DocumentKind = 'deck',
  bytes = `%PDF-1.4\n% ${filename} ${randomUUID()}\n%%EOF\n`,
): Promise<string> {
  const records = typeof recordId === 'string' ? [recordId] : recordId
  const born = await Effect.runPromise(
    intakeDocumentProgram({
      stream: Readable.from([Buffer.from(bytes)]),
      filename,
      mime: 'application/pdf',
      declaredSize: null,
      kind,
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: records.map((entityId) => ({
        kind: 'record' as const,
        entityId,
      })),
      actor: { userId: await actorId() },
    }).pipe(Effect.provide(NoQueue)),
  )
  return born.id
}

const proposals = (recordId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(eq(suggestion.entityId, recordId), eq(suggestion.kind, 'supersedes')),
    )

const supersedesLinks = () =>
  db.select({ id: link.id }).from(link).where(eq(link.relation, 'supersedes'))

describe('intake proposes a newer version', () => {
  it('a second deck proposes one supersedes suggestion citing both', async () => {
    const acme = await aCompany()
    const v1 = await file(acme, 'Seed deck v1.pdf')
    expect(await proposals(acme)).toHaveLength(0)
    const v2 = await file(acme, 'Seed deck v2.pdf')

    const rows = await proposals(acme)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.status).toBe('open')
    expect(row.proposedByType).toBe('system')
    expect(row.refs).toEqual([`doc:${v2}#0`, `doc:${v1}#0`])
    expect(readSupersedesPayload(row.payload)).toMatchObject({
      newerId: v2,
      olderId: v1,
      newerName: 'Seed deck v2.pdf',
      olderName: 'Seed deck v1.pdf',
      documentKind: 'deck',
    })
    expect(row.rationale).toMatch(/^Deck filed [A-Z][a-z]{2} \d{2}, \d{4}/)
    // Proposed, never written.
    expect(await supersedesLinks()).toHaveLength(0)
  })

  it('a third proposes one more, against the latest — not two', async () => {
    const acme = await aCompany()
    const v1 = await file(acme, 'Seed deck v1.pdf')
    const v2 = await file(acme, 'Seed deck v2.pdf')
    const v3 = await file(acme, 'Seed deck v3.pdf')
    const pairs = (await proposals(acme)).map((r) => {
      const p = readSupersedesPayload(r.payload)
      return [p?.newerId, p?.olderId]
    })
    expect(pairs).toHaveLength(2)
    expect(pairs).toContainEqual([v2, v1])
    expect(pairs).toContainEqual([v3, v2])
  })

  it('skips a superseded older for the head of its chain', async () => {
    const acme = await aCompany()
    const actor = await actorId()
    const v1 = await file(acme, 'Seed deck v1.pdf')
    const v2 = await file(acme, 'Seed deck v2.pdf')
    await Effect.runPromise(
      markNewerVersionProgram({ newerId: v2, olderId: v1, actorId: actor }),
    )
    const v3 = await file(acme, 'Seed deck v3.pdf')
    const latest = (await proposals(acme))
      .map((r) => readSupersedesPayload(r.payload))
      .find((p) => p?.newerId === v3)
    expect(latest?.olderId).toBe(v2)
  })

  it('a re-intake of the same pair proposes nothing, open or dismissed', async () => {
    const acme = await aCompany()
    await file(acme, 'Seed deck v1.pdf')
    const bytes = `%PDF-1.4\n% the v2 bytes ${randomUUID()}\n%%EOF\n`
    await file(acme, 'Seed deck v2.pdf', 'deck', bytes)
    const first = await proposals(acme)
    expect(first).toHaveLength(1)

    // Open: the same bytes again are the same document, the same pair.
    await file(acme, 'Seed deck v2.pdf', 'deck', bytes)
    expect(await proposals(acme)).toHaveLength(1)

    // Dismissed: the closed row keeps the pair closed.
    await db
      .update(suggestion)
      .set({
        status: 'rejected',
        decidedBy: await actorId(),
        decidedAt: new Date(),
      })
      .where(eq(suggestion.id, first[0].id))
    await file(acme, 'Seed deck v2.pdf', 'deck', bytes)
    const after = await proposals(acme)
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('rejected')
  })

  it('proposes nothing across kinds, for other, or for a pair already linked', async () => {
    const acme = await aCompany()
    const actor = await actorId()
    await file(acme, 'Seed deck v1.pdf')
    await file(acme, 'Cap table.pdf', 'cap_table')
    await file(acme, 'notes.pdf', 'other')
    await file(acme, 'scan.pdf', 'other')
    expect(await proposals(acme)).toHaveLength(0)

    const other = await aCompany()
    const signed = `%PDF-1.4\n% signed ${randomUUID()}\n%%EOF\n`
    const a = await file(other, 'Cap table Q1.pdf', 'cap_table')
    const b = await file(other, 'Cap table Q2.pdf', 'cap_table', signed)
    await db.delete(suggestion).where(eq(suggestion.entityId, other))
    await Effect.runPromise(
      markNewerVersionProgram({ newerId: b, olderId: a, actorId: actor }),
    )
    await file(other, 'Cap table Q2.pdf', 'cap_table', signed)
    expect(await proposals(other)).toHaveLength(0)
  })

  it('reads a forwarded attachment filed as other by its filename', async () => {
    const acme = await aCompany()
    const v2 = await file(acme, 'Seed deck v2.pdf')
    const v3 = await file(acme, 'Seed deck v3.pdf', 'other')
    const only = (await proposals(acme)).at(0)
    expect(readSupersedesPayload(only?.payload)).toMatchObject({
      newerId: v3,
      olderId: v2,
      documentKind: 'deck',
    })
  })

  it('only decks and cap tables come in versions', async () => {
    const acme = await aCompany()
    await file(acme, 'Profile in the press.pdf', 'article')
    await file(acme, 'Another profile.pdf', 'article')
    await file(acme, 'SAFE.pdf', 'legal')
    await file(acme, 'NDA.pdf', 'legal')
    await file(acme, 'Data room index.pdf', 'dd')
    await file(acme, 'Diligence notes.pdf', 'dd')
    expect(await proposals(acme)).toHaveLength(0)
    await file(acme, 'Cap table Q1.pdf', 'cap_table')
    await file(acme, 'Cap table Q2.pdf', 'cap_table')
    expect(await proposals(acme)).toHaveLength(1)
  })

  it('a pair filed on two records is offered on each', async () => {
    const acme = await aCompany()
    const deal = await aCompany()
    const v1 = await file([acme, deal], 'Seed deck v1.pdf')
    const v2 = await file([acme, deal], 'Seed deck v2.pdf')
    for (const record of [acme, deal]) {
      const rows = await proposals(record)
      expect(rows).toHaveLength(1)
      expect(readSupersedesPayload(rows[0].payload)).toMatchObject({
        newerId: v2,
        olderId: v1,
      })
    }
  })

  it('the manual verb closes the open suggestion for its pair', async () => {
    const acme = await aCompany()
    const actor = await actorId()
    const v1 = await file(acme, 'Seed deck v1.pdf')
    const v2 = await file(acme, 'Seed deck v2.pdf')
    await Effect.runPromise(
      markNewerVersionProgram({ newerId: v2, olderId: v1, actorId: actor }),
    )
    const rows = await proposals(acme)
    expect(rows.map((r) => [r.status, r.decidedBy])).toEqual([
      ['accepted', actor],
    ])
    const links = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(and(eq(link.fromEntityId, v2), eq(link.relation, 'supersedes')))
    expect(links).toEqual([{ to: v1 }])
  })
})
