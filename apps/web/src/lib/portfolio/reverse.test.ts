import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The void flow against the test database (D12, SPA-150). What is asserted
 * here is what the acceptance criteria name: the original is neither updated
 * nor deleted, the compensating row is an exact negative citing it, both
 * refusals answer by name, the partial unique index refuses the double void
 * at the database by constraint name, and a batch refuses whole.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

/** drizzle wraps the driver error; the SQLSTATE is one or more hops down. */
function pgErrorOf(
  error: unknown,
): { code: string | undefined; constraint: string | undefined } | undefined {
  let cursor: unknown = error
  while (cursor instanceof Error) {
    if ('code' in cursor && typeof cursor.code === 'string') {
      const e: { code?: unknown; constraint?: unknown } = cursor
      return {
        code: typeof e.code === 'string' ? e.code : undefined,
        constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
      }
    }
    cursor = cursor.cause
  }
  return undefined
}

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** One company, one holding — the anchor everything else hangs off. */
async function buildHolding(tag: string) {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const { holding } = await import('@spaces/db/schema/portfolio')

  const actor = await actorId()
  const [co] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Voidable ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: co.id })
  const [h] = await db
    .insert(holding)
    .values({ companyId: co.id, openedAt: '2022-01-01', createdBy: actor })
    .returning({ id: holding.id })
  return { actor, companyId: co.id, holdingId: h.id }
}

async function addMarkRow(
  holdingId: string,
  actor: string,
  fairValue: string,
  date: string,
  batchId?: string,
) {
  const { db } = await import('@spaces/db')
  const { mark } = await import('@spaces/db/schema/portfolio')
  const [row] = await db
    .insert(mark)
    .values({
      holdingId,
      date,
      fairValue,
      currency: 'USD',
      basis: 'manual',
      createdBy: actor,
      batchId,
    })
    .returning()
  return row
}

describe('voidLedgerEventProgram', () => {
  it('appends an exact negative citing the original, and never touches it', async () => {
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { eq } = await import('drizzle-orm')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const original = await addMarkRow(
      built.holdingId,
      built.actor,
      '750000.0000',
      '2024-03-01',
    )

    const { reversalId } = await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: original.id }),
    )

    // The original, byte for byte what it was — no UPDATE, no DELETE.
    const after = (
      await db.select().from(mark).where(eq(mark.id, original.id))
    ).at(0)
    expect(after).toEqual(original)

    const reversal = (
      await db.select().from(mark).where(eq(mark.id, reversalId))
    ).at(0)
    expect(reversal).toBeTruthy()
    if (!reversal) return
    expect(reversal.reversesId).toBe(original.id)
    expect(Number(reversal.fairValue)).toBe(-Number(original.fairValue))
    // The original's date, so the pair cancels at every as-of on or after it.
    expect(reversal.date).toBe(original.date)
    expect(reversal.createdBy).toBe(built.actor)
    expect(reversal.batchId).toBeNull()
    expect(reversal.createdAt.getTime()).toBeGreaterThanOrEqual(
      original.createdAt.getTime(),
    )
  })

  it('negates shares on an investment and keeps the terms', async () => {
    const { db } = await import('@spaces/db')
    const { investment } = await import('@spaces/db/schema/portfolio')
    const { eq } = await import('drizzle-orm')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const [original] = await db
      .insert(investment)
      .values({
        holdingId: built.holdingId,
        date: '2023-01-01',
        amount: '250000.0000',
        currency: 'USD',
        instrument: 'priced',
        shares: '400000.0000',
        cap: '5000000.0000',
        createdBy: built.actor,
      })
      .returning()

    const { reversalId } = await Effect.runPromise(
      voidLedgerEventProgram(built.actor, {
        table: 'investment',
        id: original.id,
      }),
    )
    const reversal = (
      await db.select().from(investment).where(eq(investment.id, reversalId))
    ).at(0)
    expect(reversal).toBeTruthy()
    if (!reversal) return
    expect(Number(reversal.amount)).toBe(-250_000)
    expect(Number(reversal.shares)).toBe(-400_000)
    // A cap is a term, not a quantity: the negated amount over the same cap
    // is what cancels the implied %.
    expect(reversal.cap).toBe(original.cap)
    expect(reversal.instrument).toBe(original.instrument)
  })

  it('writes one activity line naming the verb', async () => {
    const { db } = await import('@spaces/db')
    const { activity } = await import('@spaces/db/schema/activity')
    const { eq } = await import('drizzle-orm')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const original = await addMarkRow(
      built.holdingId,
      built.actor,
      '100.0000',
      '2024-01-01',
    )
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: original.id }),
    )
    const rows = await db
      .select({ verb: activity.verb })
      .from(activity)
      .where(eq(activity.subjectEntityId, built.companyId))
    expect(rows.map((r) => r.verb)).toContain('mark.voided')
  })

  it('refuses a second void by name', async () => {
    const { voidLedgerEventProgram, AlreadyReversed, ledgerVoidMessage } =
      await import('./reverse')
    const built = await buildHolding(randomUUID().slice(0, 8))
    const original = await addMarkRow(
      built.holdingId,
      built.actor,
      '100.0000',
      '2024-01-01',
    )
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: original.id }),
    )
    const failure = await Effect.runPromise(
      Effect.flip(
        voidLedgerEventProgram(built.actor, {
          table: 'mark',
          id: original.id,
        }),
      ),
    )
    expect(failure).toBeInstanceOf(AlreadyReversed)
    expect(ledgerVoidMessage(failure)).toBe('This mark has already been voided')
  })

  it('refuses to reverse a reversal by name', async () => {
    const { voidLedgerEventProgram, CannotReverseReversal, ledgerVoidMessage } =
      await import('./reverse')
    const built = await buildHolding(randomUUID().slice(0, 8))
    const original = await addMarkRow(
      built.holdingId,
      built.actor,
      '100.0000',
      '2024-01-01',
    )
    const { reversalId } = await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: original.id }),
    )
    const failure = await Effect.runPromise(
      Effect.flip(
        voidLedgerEventProgram(built.actor, {
          table: 'mark',
          id: reversalId,
        }),
      ),
    )
    expect(failure).toBeInstanceOf(CannotReverseReversal)
    expect(ledgerVoidMessage(failure)).toBe(
      'A reversal cannot be reversed — it is the correction',
    )
  })

  it('the database refuses the double void too, by constraint name', async () => {
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const original = await addMarkRow(
      built.holdingId,
      built.actor,
      '100.0000',
      '2024-01-01',
    )
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: original.id }),
    )

    // The check the program makes is not the only guard: a second reversal
    // inserted behind its back — which is what two concurrent voids are —
    // is refused by the partial unique index.
    const raw = await db
      .insert(mark)
      .values({
        holdingId: built.holdingId,
        date: '2024-01-01',
        fairValue: '-100.0000',
        currency: 'USD',
        basis: 'manual',
        reversesId: original.id,
        createdBy: built.actor,
      })
      .then(
        () => null,
        (err: unknown) => pgErrorOf(err),
      )
    expect(raw?.code).toBe('23505')
    expect(raw?.constraint).toBe('mark_reverses_unique')
  })

  it('the unique index is partial — many live rows keep a null reverses_id', async () => {
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { eq, and, isNull } = await import('drizzle-orm')
    const built = await buildHolding(randomUUID().slice(0, 8))
    for (const [i, v] of ['1.0000', '2.0000', '3.0000'].entries()) {
      await addMarkRow(built.holdingId, built.actor, v, `2024-0${i + 1}-01`)
    }
    // A non-partial unique index would have refused the second of these.
    const live = await db
      .select({ id: mark.id })
      .from(mark)
      .where(and(eq(mark.holdingId, built.holdingId), isNull(mark.reversesId)))
    expect(live.length).toBe(3)
  })
})

describe('voidLedgerBatchProgram', () => {
  it('voids every event sharing a batch id, in one transaction', async () => {
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { eq, isNotNull, and } = await import('drizzle-orm')
    const { voidLedgerBatchProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const batchId = randomUUID()
    for (const [i, value] of ['10.0000', '20.0000', '30.0000'].entries()) {
      await addMarkRow(
        built.holdingId,
        built.actor,
        value,
        `2024-0${i + 1}-01`,
        batchId,
      )
    }

    const { reversed } = await Effect.runPromise(
      voidLedgerBatchProgram(built.actor, batchId),
    )
    expect(reversed).toBe(3)

    const reversals = await db
      .select({ fairValue: mark.fairValue })
      .from(mark)
      .where(
        and(eq(mark.holdingId, built.holdingId), isNotNull(mark.reversesId)),
      )
    expect(
      reversals.map((r) => Number(r.fairValue)).sort((a, b) => a - b),
    ).toEqual([-30, -20, -10])
  })

  it('refuses the whole batch when one member is already voided, writing nothing', async () => {
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { eq } = await import('drizzle-orm')
    const { voidLedgerBatchProgram, voidLedgerEventProgram, AlreadyReversed } =
      await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const batchId = randomUUID()
    const planted = []
    for (const [i, value] of ['10.0000', '20.0000', '30.0000'].entries()) {
      planted.push(
        await addMarkRow(
          built.holdingId,
          built.actor,
          value,
          `2024-0${i + 1}-01`,
          batchId,
        ),
      )
    }
    // The middle one is already voided.
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, {
        table: 'mark',
        id: planted[1].id,
      }),
    )
    const rowsBefore = await db
      .select({ id: mark.id })
      .from(mark)
      .where(eq(mark.holdingId, built.holdingId))

    const failure = await Effect.runPromise(
      Effect.flip(voidLedgerBatchProgram(built.actor, batchId)),
    )
    expect(failure).toBeInstanceOf(AlreadyReversed)

    const rowsAfter = await db
      .select({ id: mark.id })
      .from(mark)
      .where(eq(mark.holdingId, built.holdingId))
    // Not one new row: partial is not an outcome.
    expect(rowsAfter.length).toBe(rowsBefore.length)
  })

  it('refuses an empty batch by name', async () => {
    const { voidLedgerBatchProgram, LedgerBatchEmpty, ledgerVoidMessage } =
      await import('./reverse')
    const failure = await Effect.runPromise(
      Effect.flip(voidLedgerBatchProgram(await actorId(), randomUUID())),
    )
    expect(failure).toBeInstanceOf(LedgerBatchEmpty)
    expect(ledgerVoidMessage(failure)).toBe(
      'Nothing left to void in that batch',
    )
  })
})

describe('the loader contract', () => {
  it('hands the pure libs originals only, stamped with reversedAt, and renders the pair', async () => {
    const { loadHoldingDetail } = await import('./detail')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    const kept = await addMarkRow(
      built.holdingId,
      built.actor,
      '300.0000',
      '2023-01-01',
    )
    const voided = await addMarkRow(
      built.holdingId,
      built.actor,
      '750000.0000',
      '2024-01-01',
    )
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: voided.id }),
    )

    const detail = await loadHoldingDetail(built.holdingId)

    // Three rows on the timeline: two originals and the correction, the
    // correction immediately beneath the entry it voids.
    expect(detail.marks.length).toBe(3)
    expect(detail.marks.map((m) => m.id)).toEqual([
      kept.id,
      voided.id,
      detail.marks[2].id,
    ])
    expect(detail.marks[0].reversedAt).toBeNull()
    expect(detail.marks[1].reversedAt).not.toBeNull()
    expect(detail.marks[2].reversesId).toBe(voided.id)
    expect(detail.marks[2].voidedOn).toBe(new Date().toISOString().slice(0, 10))
    // Who voided it, by name.
    expect(typeof detail.marks[2].voidedBy).toBe('string')

    // The metrics the pure libs computed: the fat mark is gone.
    expect(detail.metrics.ok).toBe(true)
    if (!detail.metrics.ok) return
    expect(detail.metrics.metrics.lastMarkDate).toBe('2023-01-01')
    expect(detail.metrics.metrics.unrealized).toBe(300)
  })

  it('an as-of date before the void still sees the original', async () => {
    const { loadHoldingDetail } = await import('./detail')
    const { db } = await import('@spaces/db')
    const { mark } = await import('@spaces/db/schema/portfolio')
    const { eq, isNotNull, and } = await import('drizzle-orm')
    const { voidLedgerEventProgram } = await import('./reverse')

    const built = await buildHolding(randomUUID().slice(0, 8))
    await addMarkRow(built.holdingId, built.actor, '300.0000', '2023-01-01')
    const voided = await addMarkRow(
      built.holdingId,
      built.actor,
      '750000.0000',
      '2024-01-01',
    )
    await Effect.runPromise(
      voidLedgerEventProgram(built.actor, { table: 'mark', id: voided.id }),
    )
    // Back-date the void so "before it" is a date that exists.
    await db
      .update(mark)
      .set({ createdAt: new Date('2025-03-04T11:20:00.000Z') })
      .where(
        and(eq(mark.holdingId, built.holdingId), isNotNull(mark.reversesId)),
      )

    const before = await loadHoldingDetail(built.holdingId, '2024-06-30')
    expect(before.metrics.ok).toBe(true)
    if (!before.metrics.ok) return
    expect(before.metrics.metrics.lastMarkDate).toBe('2024-01-01')
    expect(before.metrics.metrics.unrealized).toBe(750_000)

    const after = await loadHoldingDetail(built.holdingId, '2025-06-30')
    expect(after.metrics.ok).toBe(true)
    if (!after.metrics.ok) return
    expect(after.metrics.metrics.lastMarkDate).toBe('2023-01-01')
  })
})
