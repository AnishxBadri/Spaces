import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { link, suggestion } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { intakeDocumentProgram } from '@spaces/core/writes/documents/intake'
import { insertSupersedes } from '@spaces/core/writes/links/supersedes'
import { fileDocumentProgram } from '#/lib/documents/refile'
import { proposeProgram } from '@spaces/core/writes/suggestions/propose'
import {
  acceptProgram,
  acceptRecordProgram,
  rejectProgram,
  suggestionMessage,
} from './propose'

/**
 * The `supersedes` suggestion: accept writes `link(supersedes)` through
 * the supersedes writer and closes the row; dismiss closes it, and a
 * re-intake of the same pair proposes nothing.
 */

const NoQueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

async function accepterId(): Promise<string> {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('the test seed has no user')
  return row.id
}

async function aCompany(): Promise<string> {
  const made = await resolveEntity({
    kind: 'company',
    name: `Newer version ${randomUUID().slice(0, 8)}`,
    source: { class: 'manual' },
  })
  return made.entityId
}

async function file(
  records: string | Array<string>,
  filename: string,
  bytes = `%PDF-1.4\n% ${filename} ${randomUUID()}\n%%EOF\n`,
): Promise<string> {
  const born = await Effect.runPromise(
    intakeDocumentProgram({
      stream: Readable.from([Buffer.from(bytes)]),
      filename,
      mime: 'application/pdf',
      declaredSize: null,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: (typeof records === 'string' ? [records] : records).map(
        (entityId) => ({ kind: 'record' as const, entityId }),
      ),
      actor: { userId: await accepterId() },
    }).pipe(Effect.provide(NoQueue)),
  )
  return born.id
}

const proposalsOn = (recordId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(eq(suggestion.entityId, recordId), eq(suggestion.kind, 'supersedes')),
    )

const supersedesFrom = (newerId: string) =>
  db
    .select({ to: link.toEntityId, createdBy: link.createdBy })
    .from(link)
    .where(and(eq(link.fromEntityId, newerId), eq(link.relation, 'supersedes')))

describe('supersedes suggestion', () => {
  it('accept writes the link newer → older and closes the suggestion', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    const v2 = await file(acme, 'Seed deck v2.pdf')
    const v3 = await file(acme, 'Seed deck v3.pdf')
    const proposed = (await proposalsOn(acme)).at(0)
    if (!proposed) throw new Error('intake proposed nothing')
    expect(await supersedesFrom(v3)).toEqual([])

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, { type: 'user', id: me }),
    )
    if (accepted.kind !== 'supersedes') throw new Error('expected supersedes')
    expect(accepted.written).toBe(true)
    expect(accepted.suggestion.status).toBe('accepted')
    expect(accepted.suggestion.decidedBy).toBe(me)
    expect(await supersedesFrom(v3)).toEqual([{ to: v2, createdBy: me }])
  })

  it('dismiss closes it, writes no link, and a re-intake proposes nothing', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    await file(acme, 'Seed deck v2.pdf')
    const bytes = `%PDF-1.4\n% v3 ${randomUUID()}\n%%EOF\n`
    const v3 = await file(acme, 'Seed deck v3.pdf', bytes)
    const proposed = (await proposalsOn(acme)).at(0)
    if (!proposed) throw new Error('intake proposed nothing')

    const rejected = await Effect.runPromise(
      rejectProgram(proposed.id, { type: 'user', id: me }),
    )
    expect(rejected.status).toBe('rejected')
    expect(await supersedesFrom(v3)).toEqual([])

    await file(acme, 'Seed deck v3.pdf', bytes)
    const after = await proposalsOn(acme)
    expect(after.map((r) => [r.id, r.status])).toEqual([
      [proposed.id, 'rejected'],
    ])
  })

  it('a pair the writer refuses keeps the suggestion open', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    const v2 = await file(acme, 'Seed deck v2.pdf')
    const v3 = await file(acme, 'Seed deck v3.pdf')
    const proposed = (await proposalsOn(acme)).at(0)
    if (!proposed) throw new Error('intake proposed nothing')
    // The reverse already stands: v2 marked as the newer by hand.
    await db.transaction((tx) =>
      insertSupersedes(tx, { newerId: v2, olderId: v3, actorId: me }),
    )

    const failure = await Effect.runPromise(
      Effect.flip(acceptProgram(proposed.id, { type: 'user', id: me })),
    )
    expect(suggestionMessage(failure)).toBe(
      'That one is already the newer version of this',
    )
    const held = (await proposalsOn(acme)).at(0)
    expect(held?.status).toBe('open')
    expect(await supersedesFrom(v3)).toEqual([])
  })

  it('accept all on a record leaves a supersedes row for its own decision', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    await file(acme, 'Seed deck v2.pdf')
    const v3 = await file(acme, 'Seed deck v3.pdf')
    const proposed = (await proposalsOn(acme)).at(0)
    if (!proposed) throw new Error('intake proposed nothing')

    const outcomes = await Effect.runPromise(
      acceptRecordProgram({ entityId: acme, actorId: me }),
    )
    expect(outcomes.map((o) => o.suggestionId)).not.toContain(proposed.id)
    expect((await proposalsOn(acme)).at(0)?.status).toBe('open')
    expect(await supersedesFrom(v3)).toEqual([])
  })

  it('accept all on a record leaves a ledger event for its own decision (D12)', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    const patch = await Effect.runPromise(
      proposeProgram({
        entityId: acme,
        kind: 'attribute_patch',
        payload: { location: { value: 'Oslo', refs: [], confidence: 1 } },
        proposedBy: { type: 'system' },
      }),
    )
    const ledger = await Effect.runPromise(
      proposeProgram({
        entityId: acme,
        kind: 'ledger_event',
        payload: {
          event: 'round',
          companyId: acme,
          companyName: 'Acme',
          documentId: randomUUID(),
          documentName: 'Cap table.csv',
          revisionId: 'rev-2',
          before: {
            ownershipPct: null,
            fairValue: null,
            currency: null,
            roundKind: null,
            roundDate: null,
          },
          after: { ownershipPct: null },
          proposed: { date: '2026-03-01', kind: 'Series B' },
        },
        proposedBy: { type: 'system' },
      }),
    )

    const outcomes = await Effect.runPromise(
      acceptRecordProgram({ entityId: acme, actorId: me }),
    )
    expect(outcomes).toEqual([
      { suggestionId: patch.id, slug: 'location', ok: true },
    ])
    const statusOf = async (id: string) =>
      (
        await db
          .select({ status: suggestion.status })
          .from(suggestion)
          .where(eq(suggestion.id, id))
      ).at(0)?.status
    expect(await statusOf(patch.id)).toBe('accepted')
    expect(await statusOf(ledger.id)).toBe('open')
  })

  it('accepting on one record closes the same pair on the other', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    const deal = await aCompany()
    await file([acme, deal], 'Seed deck v2.pdf')
    await file([acme, deal], 'Seed deck v3.pdf')
    const onAcme = (await proposalsOn(acme)).at(0)
    if (!onAcme) throw new Error('intake proposed nothing')
    await Effect.runPromise(acceptProgram(onAcme.id, { type: 'user', id: me }))
    expect((await proposalsOn(deal)).map((r) => r.status)).toEqual(['accepted'])
  })

  it('a document filed on the record after arrival proposes too', async () => {
    const me = await accepterId()
    const acme = await aCompany()
    const v2 = await file(acme, 'Seed deck v2.pdf')
    const v3 = await file([], 'Seed deck v3.pdf')
    expect(await proposalsOn(acme)).toEqual([])

    await Effect.runPromise(
      fileDocumentProgram(me, {
        documentId: v3,
        target: { kind: 'record', entityId: acme },
      }),
    )
    const rows = await proposalsOn(acme)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ newerId: v3, olderId: v2 })
  })
})
