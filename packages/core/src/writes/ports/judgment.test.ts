import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attributeEvent,
  entity,
  integration,
  suggestion,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Facts, JobPermanent, Judgment, Receipts } from '@spaces/sdk'
import type { FactClaim, JudgmentClaim } from '@spaces/sdk'
import { Enqueue } from '../../queue/enqueue'
import { setValues } from '../attributes/values'
import { resolveEntity } from '../entities/resolve'
import { FactsLive } from './facts'
import { JudgmentLive } from './judgment'
import { ReceiptsLive } from './receipts'

/**
 * Judgment bound to an integration row (sdk-10), against a real database:
 * one open suggestion per call with the row as proposer and the claim's
 * rationale and refs verbatim; and the loop the spec draws from Facts — a
 * `Facts.fill` conflict raised as exactly one suggestion, a re-run raising
 * none, held by `suggestion_open_integration_unique` rather than by a read.
 */

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

type Row = { id: string; capabilityId: string }

const boundRow = async (capabilityId = 'echo'): Promise<Row> => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const ports = (row: Row) =>
  Layer.mergeAll(
    FactsLive(row).pipe(Layer.provide(EnqueueTest)),
    ReceiptsLive(row),
    JudgmentLive(row),
  )

const suggestProgram = (claim: JudgmentClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Judgment).suggest(claim)
  })

const suggest = (row: Row, claim: JudgmentClaim) =>
  Effect.runPromise(suggestProgram(claim).pipe(Effect.provide(ports(row))))

const suggestExit = (row: Row, claim: JudgmentClaim) =>
  Effect.runPromiseExit(suggestProgram(claim).pipe(Effect.provide(ports(row))))

const fill = (row: Row, claim: FactClaim) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Facts).fill(claim)
    }).pipe(Effect.provide(ports(row))),
  )

const store = (row: Row, entityId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Receipts).store({
        entityId,
        raw: { headcount: 120 },
      })
    }).pipe(Effect.provide(ports(row))),
  )

const company = async (name: string) =>
  (await resolveEntity({ kind: 'company', name, source: { class: 'manual' } }))
    .entityId

const suggestionsOn = (entityId: string) =>
  db.select().from(suggestion).where(eq(suggestion.entityId, entityId))

const aUser = async () => {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('no fixture user')
  return row.id
}

const permanentReason = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('the call succeeded')
  const error = Cause.squash(exit.cause)
  if (!(error instanceof JobPermanent))
    throw new Error(`not a JobPermanent: ${String(error)}`)
  return error.reason
}

describe('Judgment.suggest, bound to an integration row', () => {
  it('writes one open suggestion: the row proposes, rationale and refs verbatim', async () => {
    const row = await boundRow()
    const co = await company('Suggest Co')
    const { receiptId } = await store(row, co)
    const refs = [`event:${receiptId}`, `attr:${co}:founded_year`] as const

    const { suggestionId } = await suggest(row, {
      entityId: co,
      proposal: { kind: 'attribute', slug: 'founded_year', value: 2015 },
      rationale: 'The registry filing says 2015',
      refs,
    })

    const rows = await suggestionsOn(co)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      id: suggestionId,
      kind: 'attribute_patch',
      status: 'open',
      proposedByType: 'integration',
      proposedById: row.id,
      rationale: 'The registry filing says 2015',
      refs: [...refs],
      decidedBy: null,
      decidedAt: null,
      payload: {
        founded_year: { value: 2015, refs: [...refs], confidence: 1 },
      },
    })
    // A proposal, never a write: the record is untouched.
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, co)),
    ).toHaveLength(0)
  })

  it('writes a note proposal drafted from the record itself', async () => {
    const row = await boundRow()
    const co = await company('Note Co')
    await suggest(row, {
      entityId: co,
      proposal: { kind: 'note', body: '## Web research\n\nRaised a seed.' },
      rationale: 'Exa web research',
      refs: [],
    })
    const rows = await suggestionsOn(co)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      kind: 'note',
      status: 'open',
      proposedById: row.id,
      rationale: 'Exa web research',
      payload: {
        title: 'Web research',
        markdown: '## Web research\n\nRaised a seed.',
        sourceId: co,
      },
    })
  })

  it('cannot propose a suggestion already accepted, nor name its own proposer', async () => {
    const row = await boundRow()
    const co = await company('Pre-accepted Co')
    // A claim carrying fields the contract does not have: a plugin built
    // against a lying type, or plain JS. The port reads none of them.
    const forged = {
      entityId: co,
      proposal: { kind: 'attribute', slug: 'location', value: 'Pune' },
      rationale: 'trust me',
      refs: [],
      status: 'accepted',
      decidedBy: await aUser(),
      proposedBy: { type: 'user', id: await aUser() },
    } as const
    await suggest(row, forged)
    const rows = await suggestionsOn(co)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      proposedByType: 'integration',
      proposedById: row.id,
    })
  })

  it('an identical open proposal is one row: the second call returns the first id', async () => {
    const row = await boundRow()
    const co = await company('Twice Suggested Co')
    const claim = {
      entityId: co,
      proposal: { kind: 'attribute', slug: 'location', value: 'Pune' },
      rationale: 'first run',
      refs: [],
    } as const
    const first = await suggest(row, claim)
    const second = await suggest(row, {
      ...claim,
      rationale: 'second run',
      refs: [`attr:${co}:location`],
    })
    expect(second.suggestionId).toBe(first.suggestionId)
    expect(await suggestionsOn(co)).toHaveLength(1)

    // A different value is a different proposal.
    await suggest(row, {
      ...claim,
      proposal: { kind: 'attribute', slug: 'location', value: 'Mumbai' },
    })
    expect(await suggestionsOn(co)).toHaveLength(2)
  })

  it('fails permanently on a ref outside the grammar, an unknown slug, or a malformed id', async () => {
    const row = await boundRow()
    const co = await company('Refused Co')
    const base = {
      entityId: co,
      proposal: { kind: 'attribute', slug: 'location', value: 'Pune' },
      rationale: 'r',
      refs: [],
    } as const
    // Both spellings satisfy the SDK's template types; neither parses in
    // the grammar (D4), so neither is a citation a reviewer could follow.
    expect(
      permanentReason(
        await suggestExit(row, { ...base, refs: ['event:', `attr:${co}:`] }),
      ),
    ).toMatch(/not a ref: event:, attr:.+:$/)
    expect(
      permanentReason(
        await suggestExit(row, {
          ...base,
          proposal: { kind: 'attribute', slug: 'no_such_slug', value: 1 },
        }),
      ),
    ).toMatch(/no_such_slug: Unknown attribute/)
    expect(
      permanentReason(await suggestExit(row, { ...base, entityId: 'nope' })),
    ).toMatch(/no record nope/)
    expect(await suggestionsOn(co)).toHaveLength(0)
  })
})

describe('Facts.fill conflicts become suggestions', () => {
  it('raises exactly one suggestion naming the slug, the held and the proposed value', async () => {
    const row = await boundRow('apollo')
    const co = await company('Conflict Co')
    await setValues({
      entityId: co,
      patch: { founded_year: 1990 },
      actor: { type: 'user', id: await aUser() },
    })
    const { receiptId } = await store(row, co)

    const result = await fill(row, {
      entityId: co,
      values: { founded_year: 2015, location: 'Bengaluru' },
      receiptId,
    })
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 1990, proposed: 2015 },
    ])

    const rows = await suggestionsOn(co)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      kind: 'attribute_patch',
      status: 'open',
      proposedByType: 'integration',
      proposedById: row.id,
      rationale: 'founded_year: apollo says 2015; the record holds 1990',
      refs: [`event:${receiptId}`],
      payload: {
        founded_year: {
          value: 2015,
          refs: [`event:${receiptId}`],
          confidence: 1,
        },
      },
    })
    // The held value is untouched; the blank beside it filled.
    const values = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, co))
    ).at(0)?.values
    expect(values).toMatchObject({ founded_year: 1990, location: 'Bengaluru' })
  })

  it('a second identical run raises no duplicate, though it cites a new receipt', async () => {
    const row = await boundRow('apollo')
    const co = await company('Rerun Co')
    await setValues({
      entityId: co,
      patch: { founded_year: 1990 },
      actor: { type: 'user', id: await aUser() },
    })
    const first = await store(row, co)
    await fill(row, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId: first.receiptId,
    })
    const second = await store(row, co)
    const again = await fill(row, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId: second.receiptId,
    })
    // Still returned to the job — the dedupe is the inbox's, not the port's answer.
    expect(again.conflicts).toHaveLength(1)
    const rows = await suggestionsOn(co)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)?.refs).toEqual([`event:${first.receiptId}`])

    // Another provider proposing the same value for the same open slot is
    // the same proposal.
    await fill(await boundRow('pdl'), {
      entityId: co,
      values: { founded_year: 2015 },
    })
    expect(await suggestionsOn(co)).toHaveLength(1)
  })

  it('the index, not a read, holds it: a raw duplicate insert is refused; a decided row blocks nothing', async () => {
    const row = await boundRow('apollo')
    const co = await company('Indexed Co')
    await setValues({
      entityId: co,
      patch: { founded_year: 1990 },
      actor: { type: 'user', id: await aUser() },
    })
    await fill(row, { entityId: co, values: { founded_year: 2015 } })
    const held = (await suggestionsOn(co)).at(0)
    if (!held) throw new Error('no suggestion')

    // Same slug and value, different refs and confidence: the key ignores both.
    const duplicate = db.insert(suggestion).values({
      entityId: co,
      kind: 'attribute_patch',
      payload: {
        founded_year: { value: 2015, refs: ['event:other'], confidence: 0.4 },
      },
      refs: ['event:other'],
      proposedByType: 'integration',
      proposedById: row.id,
    })
    await expect(duplicate).rejects.toMatchObject({
      cause: {
        code: '23505',
        constraint: 'suggestion_open_integration_unique',
      },
    })

    // Rejected: no longer open, so the next run proposes afresh.
    await db
      .update(suggestion)
      .set({
        status: 'rejected',
        decidedBy: await aUser(),
        decidedAt: new Date(),
      })
      .where(eq(suggestion.id, held.id))
    await fill(row, { entityId: co, values: { founded_year: 2015 } })
    const open = await db
      .select()
      .from(suggestion)
      .where(and(eq(suggestion.entityId, co), eq(suggestion.status, 'open')))
    expect(open).toHaveLength(1)
    expect(open.at(0)?.id).not.toBe(held.id)
  })
})
