import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  activity,
  aiRoute,
  credential,
  document,
  documentRevision,
  suggestion,
} from '@spaces/db/schema'
import {
  distribution,
  holding,
  investment,
  mark,
  round,
  roundCoInvestor,
} from '@spaces/db/schema/portfolio'
import type { Json } from '@spaces/core/json'
import { QUEUES } from '@spaces/core/queue/names'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { birthDocumentProgram } from '@spaces/core/writes/documents/birth'
import { storeCredential } from '@spaces/core/writes/vault'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { webEnqueue } from '#/lib/enqueue-live'
import { onDocumentExtracted } from '#/lib/documents/on-extracted'
import {
  addInvestmentProgram,
  addMarkProgram,
  addRoundProgram,
} from '#/lib/portfolio/write'
import {
  SuggestionInvalid,
  acceptProgram,
  proposeProgram,
  rejectProgram,
  suggestionMessage,
} from './propose'
import { setAiRouteProgram } from './route'
import {
  chooseLedgerEvent,
  ledgerTargetOf,
  proposeLedgerEventProgram,
} from './ledger-event'
import type { HoldingNow } from './ledger-event'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Live-file ledger events: a revised cap table proposes, the suggestion
 * queue is the only door, and accepting appends exactly one row to `round`
 * or `mark` — counted before and after, nothing updated or deleted. (D12)
 */

const USER = FIXTURE_ACTOR.id
const DECIDER = { type: 'user', id: USER } as const

/** Every portfolio table, by row count. */
async function counts() {
  const rows = async (q: PromiseLike<Array<unknown>>) => (await q).length
  return {
    holding: await rows(db.select().from(holding)),
    round: await rows(db.select().from(round)),
    roundCoInvestor: await rows(db.select().from(roundCoInvestor)),
    investment: await rows(db.select().from(investment)),
    mark: await rows(db.select().from(mark)),
    distribution: await rows(db.select().from(distribution)),
  }
}

/**
 * A held company: 124,000 priced shares of a 1,000,000 fully diluted
 * Series A (12.4%), marked once.
 */
async function heldCompany() {
  const company = await resolveEntity({
    kind: 'company',
    name: `Ledgered ${randomUUID().slice(0, 8)}`,
    source: { class: 'manual' },
  })
  const companyId = company.entityId
  const cheque = await Effect.runPromise(
    addInvestmentProgram({
      companyId,
      date: '2025-01-10',
      amount: 500_000,
      currency: 'USD',
      instrument: 'priced',
      shares: 124_000,
      actorId: USER,
    }),
  )
  await Effect.runPromise(
    addRoundProgram({
      companyId,
      date: '2025-01-10',
      kind: 'Series A',
      sharesOutstanding: 1_000_000,
      actorId: USER,
    }),
  )
  await Effect.runPromise(
    addMarkProgram({
      holdingId: cheque.holdingId,
      date: '2025-06-30',
      fairValue: 600_000,
      currency: 'USD',
      basis: 'manual',
      actorId: USER,
    }),
  )
  return { companyId, holdingId: cheque.holdingId }
}

const BEFORE = {
  ownershipPct: 0.124,
  fairValue: 600_000,
  currency: 'USD',
  roundKind: 'Series A',
  roundDate: '2025-01-10',
}

function roundPayload(
  companyId: string,
  proposed: { [k: string]: Json },
  revisionId = `rev-${randomUUID()}`,
): Json {
  return {
    event: 'round',
    companyId,
    companyName: 'Acme',
    documentId: randomUUID(),
    documentName: 'Cap table.csv',
    revisionId,
    before: BEFORE,
    after: { ownershipPct: 0.098 },
    proposed,
  }
}

function markPayload(
  holdingId: string,
  companyId: string,
  fairValue: number,
): Json {
  return {
    event: 'mark',
    companyId,
    companyName: 'Acme',
    documentId: randomUUID(),
    documentName: 'Cap table.csv',
    revisionId: `rev-${randomUUID()}`,
    before: BEFORE,
    after: { ownershipPct: 0.098 },
    proposed: {
      holdingId,
      date: '2026-03-01',
      fairValue,
      currency: 'USD',
      basis: 'round_price',
    },
  }
}

const propose = (entityId: string, payload: Json) =>
  Effect.runPromise(
    proposeProgram({
      entityId,
      kind: 'ledger_event',
      payload,
      proposedBy: { type: 'system' },
    }),
  )

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(eq(suggestion.id, id))
  ).at(0)?.status

describe('accepting a ledger event', () => {
  it('appends exactly one round, by the accepter, naming the suggestion', async () => {
    const { companyId } = await heldCompany()
    const row = await propose(
      companyId,
      roundPayload(companyId, {
        date: '2026-03-01',
        kind: 'Series B',
        raised: 4_000_000,
        currency: 'USD',
        sharesOutstanding: 1_265_306,
      }),
    )
    const before = await counts()

    const accepted = await Effect.runPromise(acceptProgram(row.id, DECIDER))

    expect(accepted.kind).toBe('ledger_event')
    expect(await counts()).toEqual({ ...before, round: before.round + 1 })
    const written = (
      await db
        .select()
        .from(round)
        .where(and(eq(round.companyId, companyId), eq(round.kind, 'Series B')))
    ).at(0)
    expect(written).toMatchObject({
      date: '2026-03-01',
      createdBy: USER,
      raised: '4000000.0000',
    })
    if (accepted.kind === 'ledger_event')
      expect(accepted).toMatchObject({ event: 'round', eventId: written?.id })
    const trail = await db
      .select({ actorId: activity.actorId, meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, companyId),
          eq(activity.verb, 'round.added'),
          sql`${activity.meta} ->> 'suggestionId' = ${row.id}`,
        ),
      )
    expect(trail).toEqual([{ actorId: USER, meta: { suggestionId: row.id } }])
    expect(await statusOf(row.id)).toBe('accepted')
  })

  it('appends exactly one mark on the holding', async () => {
    const { companyId, holdingId } = await heldCompany()
    const row = await propose(
      companyId,
      markPayload(holdingId, companyId, 482_000),
    )
    const before = await counts()

    await Effect.runPromise(acceptProgram(row.id, DECIDER))

    expect(await counts()).toEqual({ ...before, mark: before.mark + 1 })
    const marks = await db
      .select({ fairValue: mark.fairValue, createdBy: mark.createdBy })
      .from(mark)
      .where(and(eq(mark.holdingId, holdingId), eq(mark.date, '2026-03-01')))
    expect(marks).toEqual([{ fairValue: '482000.0000', createdBy: USER }])
  })

  it('refuses numbers the portfolio validators refuse, with their message, and leaves the row open', async () => {
    const { companyId, holdingId } = await heldCompany()
    const negative = await propose(
      companyId,
      roundPayload(companyId, {
        date: '2026-03-01',
        kind: 'Series B',
        raised: -5,
      }),
    )
    const badDate = await propose(
      companyId,
      roundPayload(companyId, { date: 'March 2026', kind: 'Series B' }),
    )
    const negativeMark = await propose(
      companyId,
      markPayload(holdingId, companyId, -1),
    )
    const before = await counts()

    for (const [id, field] of [
      [negative.id, 'raised'],
      [badDate.id, 'date'],
      [negativeMark.id, 'fairValue'],
    ] as const) {
      const refused = await Effect.runPromise(
        Effect.flip(acceptProgram(id, DECIDER)),
      )
      expect(refused).toBeInstanceOf(SuggestionInvalid)
      expect(suggestionMessage(refused)).toMatch(new RegExp(`^${field}: `))
      expect(await statusOf(id)).toBe('open')
    }
    expect(
      suggestionMessage(
        await Effect.runPromise(
          Effect.flip(acceptProgram(badDate.id, DECIDER)),
        ),
      ),
    ).toContain('Expected YYYY-MM-DD')
    expect(await counts()).toEqual(before)
  })

  it('refuses a mark on a holding that is gone, and writes nothing', async () => {
    const { companyId } = await heldCompany()
    const row = await propose(
      companyId,
      markPayload(randomUUID(), companyId, 1_000),
    )
    const before = await counts()
    const refused = await Effect.runPromise(
      Effect.flip(acceptProgram(row.id, DECIDER)),
    )
    expect(suggestionMessage(refused)).toBe('Holding not found')
    expect(await statusOf(row.id)).toBe('open')
    expect(await counts()).toEqual(before)
  })

  it('rejecting writes nothing to any portfolio table', async () => {
    const { companyId } = await heldCompany()
    const row = await propose(
      companyId,
      roundPayload(companyId, { date: '2026-03-01', kind: 'Series B' }),
    )
    const before = await counts()
    const activityBefore = (await db.select().from(activity)).length
    await Effect.runPromise(rejectProgram(row.id, DECIDER))
    expect(await counts()).toEqual(before)
    expect((await db.select().from(activity)).length).toBe(activityBefore)
    expect(await statusOf(row.id)).toBe('rejected')
  })

  it('is proposed once per (document, revision), and never again after a reject', async () => {
    const { companyId } = await heldCompany()
    const payload = roundPayload(
      companyId,
      { date: '2026-03-01', kind: 'Series B' },
      'rev-fixed',
    )
    const first = await propose(companyId, payload)
    expect((await propose(companyId, payload)).id).toBe(first.id)
    await Effect.runPromise(rejectProgram(first.id, DECIDER))
    expect((await propose(companyId, payload)).id).toBe(first.id)
  })
})

// ---------- the choice ----------

const NOW: HoldingNow = {
  holdingId: '00000000-0000-4000-8000-000000000001',
  ownershipPct: 0.124,
  ourShares: 124_000,
  latestMark: { date: '2025-06-30', fairValue: 600_000, currency: 'USD' },
  latestRound: { date: '2025-01-10', kind: 'Series A' },
  roundDates: ['2025-01-10'],
  currency: 'USD',
}

describe('chooseLedgerEvent', () => {
  it('proposes a round the ledger lacks, with the ownership it implies', () => {
    const choice = chooseLedgerEvent(
      {
        round: {
          date: '2026-03-01',
          kind: 'Series B',
          raised: 4_000_000,
          sharesOutstanding: 1_265_306,
        },
      },
      NOW,
    )
    expect(choice.event).toBe('round')
    if (choice.event === 'round') {
      expect(choice.proposed).toEqual({
        date: '2026-03-01',
        kind: 'Series B',
        raised: 4_000_000,
        sharesOutstanding: 1_265_306,
      })
      expect(choice.afterPct).toBeCloseTo(0.098, 3)
    }
  })

  it('a round already held at that date becomes a mark at its price', () => {
    const choice = chooseLedgerEvent(
      {
        round: { date: '2025-01-10', kind: 'Series A', pricePerShare: 4.5 },
        ownership: { pct: 0.124 },
      },
      NOW,
    )
    expect(choice).toEqual({
      event: 'mark',
      proposed: {
        holdingId: NOW.holdingId,
        date: '2025-01-10',
        fairValue: 558_000,
        currency: 'USD',
        basis: 'round_price',
      },
      afterPct: 0.124,
    })
  })

  it('nothing to propose when the revision shows no new round and no price', () => {
    expect(chooseLedgerEvent({ ownership: { pct: 0.1 } }, NOW).event).toBeNull()
    expect(
      chooseLedgerEvent(
        { round: { date: '2025-01-10', kind: 'Series A' } },
        NOW,
      ).event,
    ).toBeNull()
  })
})

// ---------- the lane ----------

function scripted(answer: Json) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  })
}

async function routeExtract() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-ledger-0000',
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** A cap table filed on the company, extracted, and optionally revised. */
async function capTable(companyId: string, revised: boolean) {
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: null,
      filename: 'Cap table.csv',
      mime: 'text/csv',
      sizeBytes: 64,
      kind: 'cap_table',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [{ kind: 'record', entityId: companyId }],
      actor: { userId: USER },
    }).pipe(Effect.provide(webEnqueue)),
  )
  // Exempt from the one-writer rule: the state a revision and its
  // extraction leave behind.
  await db
    .update(document)
    .set({
      extractionStatus: 'done',
      extractedText: 'Holder,Shares\nFund,124000\nTotal,1265306',
      externalRevisionId: 'rev-2',
    })
    .where(eq(document.entityId, id))
  if (revised)
    await db.insert(documentRevision).values({
      documentId: id,
      blobSha: 'a'.repeat(64),
      externalRevisionId: 'rev-1',
    })
  enqueued.length = 0
  return id
}

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
})

describe('the revision lane', () => {
  it('a first filing enqueues nothing; a revision on a held company enqueues one read, keyed on the revision', async () => {
    await routeExtract()
    const { companyId } = await heldCompany()
    const first = await capTable(companyId, false)
    await Effect.runPromise(onDocumentExtracted(first))
    expect(enqueued.map((e) => e.name)).toEqual([QUEUES.embedDocument])

    const revised = await capTable(companyId, true)
    await Effect.runPromise(onDocumentExtracted(revised))
    await Effect.runPromise(onDocumentExtracted(revised))
    expect(
      enqueued.filter((e) => e.name === QUEUES.proposeLedgerEvent),
    ).toEqual([
      {
        name: QUEUES.proposeLedgerEvent,
        data: { documentId: revised, revisionId: 'rev-2' },
        options: { singletonKey: `${revised}:rev-2` },
      },
    ])
  })

  it('nothing for a company with no holding, or with the extract lane unrouted', async () => {
    const company = await resolveEntity({
      kind: 'company',
      name: `Unheld ${randomUUID().slice(0, 8)}`,
      source: { class: 'manual' },
    })
    const unheld = await capTable(company.entityId, true)
    expect(await ledgerTargetOf(unheld)).toEqual({
      ok: false,
      reason: 'Not filed on a company the portfolio holds',
    })
    const { companyId } = await heldCompany()
    const held = await capTable(companyId, true)
    await Effect.runPromise(onDocumentExtracted(held))
    expect(enqueued.map((e) => e.name)).toEqual([QUEUES.embedDocument])
  })

  it('proposes one ledger event with the diff against the holding; a replay proposes nothing new', async () => {
    await routeExtract()
    const { companyId } = await heldCompany()
    const doc = await capTable(companyId, true)
    const answer = {
      round: {
        date: '2026-03-01',
        kind: 'Series B',
        raised: 4_000_000,
        currency: 'USD',
        sharesOutstanding: 1_265_306,
      },
      ownership: { ourShares: 124_000, fullyDilutedShares: 1_265_306 },
      reason: 'A Series B closed and diluted every holder.',
    }
    const run = () =>
      Effect.runPromise(
        proposeLedgerEventProgram({
          documentId: doc,
          revisionId: 'rev-2',
          model: scripted(answer),
        }),
      )
    const result = await run()
    expect(result.status).toBe('proposed')
    const ofDoc = () =>
      db
        .select()
        .from(suggestion)
        .where(
          and(
            eq(suggestion.kind, 'ledger_event'),
            sql`${suggestion.payload} ->> 'documentId' = ${doc}`,
          ),
        )
    const rows = await ofDoc()
    expect(rows).toHaveLength(1)
    const row = rows.at(0)
    expect(row?.entityId).toBe(companyId)
    expect(row?.payload).toMatchObject({
      event: 'round',
      documentId: doc,
      revisionId: 'rev-2',
      before: { ownershipPct: 0.124, fairValue: 600_000, currency: 'USD' },
      proposed: { date: '2026-03-01', kind: 'Series B', raised: 4_000_000 },
    })
    expect(await run()).toMatchObject({ status: 'skipped' })
    expect(
      await Effect.runPromise(
        proposeLedgerEventProgram({
          documentId: doc,
          revisionId: 'rev-1',
          model: scripted(answer),
        }),
      ),
    ).toEqual({
      status: 'skipped',
      reason: 'A newer revision arrived; its own read proposes',
    })
    expect(await ofDoc()).toHaveLength(1)
  })
})
