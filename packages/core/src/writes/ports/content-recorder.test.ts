import { Effect, Exit, Layer } from 'effect'
import { count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  enrichmentRecord,
  integration,
  interaction,
  note,
  suggestion,
} from '@spaces/db/schema'
import { Content } from '@spaces/sdk'
import type { InteractionClaim, RecorderPayload } from '@spaces/sdk'
import { Enqueue } from '../../queue/enqueue'
import { resolveEntity } from '../entities/resolve'
import { MeetingLane } from '../interactions/meeting-lane'
import { NoEmailLane } from '../interactions/email-lane'
import { ContentLive, readInteractionShape } from './content'

/**
 * `Content.logInteraction` with a recorder's payload, bound to one
 * integration row: the payload is a receipt before anything it claims is
 * applied, its participants go through the lane's participants module, and
 * the writer — never the port — decides between the meeting and a call.
 */

const boundRow = async (capabilityId: string) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning({ id: integration.id, capabilityId: integration.capabilityId })
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** What the participants module was handed, and a person per address. */
const handed: Array<string> = []
const LaneTest = Layer.succeed(
  MeetingLane,
  MeetingLane.of({
    log: () => Effect.die('no meetings here'),
    participants: (_ctx, people) =>
      Effect.promise(async () => {
        const ids: Array<string> = []
        for (const p of people) {
          handed.push(p.email)
          ids.push(
            (
              await resolveEntity({
                kind: 'person',
                ...(p.name === null ? {} : { name: p.name }),
                keys: { email: p.email },
                source: { class: 'manual' },
              })
            ).entityId,
          )
        }
        return ids
      }),
  }),
)

const run = (
  row: { id: string; capabilityId: string },
  claim: InteractionClaim,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* (yield* Content).logInteraction(claim)
    }).pipe(
      Effect.provide(
        ContentLive(row).pipe(
          Layer.provide(Layer.mergeAll(EnqueueTest, LaneTest, NoEmailLane)),
        ),
      ),
    ),
  )

const valueOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>): TValue => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`failed: ${String(exit.cause)}`)
}

const claimFor = (
  providerEventId: string,
  extra: Partial<RecorderPayload> = {},
): InteractionClaim => ({
  _tag: 'interaction',
  kind: 'call',
  occurredAt: '2026-10-08T10:00:00.000Z',
  subject: 'Pitch',
  participants: [{ email: 'Dev@Recorder-Port.example', name: 'Dev' }],
  recorder: {
    providerEventId,
    raw: { id: providerEventId, summary: 'They raised a seed.' },
    ...extra,
  },
})

const total = async (
  table: typeof interaction | typeof note | typeof suggestion,
) => (await db.select({ n: count() }).from(table)).at(0)?.n ?? 0

describe('Content.logInteraction with a recorder payload', () => {
  it('stores the payload whole as a receipt with no record, then births one call', async () => {
    const row = await boundRow('fathom')
    const out = valueOf(await run(row, claimFor('fathom-port-1')))

    const receipts = await db
      .select()
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, row.id))
    expect(receipts).toHaveLength(1)
    expect(receipts.at(0)).toMatchObject({
      entityId: null,
      provider: 'fathom',
      raw: { id: 'fathom-port-1', summary: 'They raised a seed.' },
    })
    const held = (
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, out.interactionId))
    ).at(0)
    expect(held).toMatchObject({
      kind: 'call',
      messageId: 'fathom-port-1',
      sourceRef: row.id,
      meta: { kind: 'call', receipt_id: receipts.at(0)?.id },
    })
    // Before any claim was applied: the receipt predates the row.
    expect(receipts.at(0)?.fetchedAt.getTime()).toBeLessThanOrEqual(
      held?.createdAt.getTime() ?? 0,
    )
    // Participants went through the lane, lowercased.
    expect(handed).toContain('dev@recorder-port.example')
  })

  it('keeps the receipt when the claim is refused after it', async () => {
    const row = await boundRow('fathom')
    const before = await total(interaction)
    const exit = await run(
      row,
      claimFor('fathom-port-refused', {
        artifacts: [
          {
            role: 'transcript',
            documentId: '00000000-0000-4000-8000-000000000000',
          },
        ],
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain(
      'JobPermanent',
    )
    expect(await total(interaction)).toBe(before)
    const kept = await db
      .select({ raw: enrichmentRecord.raw })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, row.id))
    expect(kept.map((k) => k.raw)).toEqual([
      { id: 'fathom-port-refused', summary: 'They raised a seed.' },
    ])
  })

  it('delivered twice is one row, and the job succeeds both times', async () => {
    const row = await boundRow('fathom')
    const before = await total(interaction)
    const first = valueOf(await run(row, claimFor('fathom-port-twice')))
    const second = valueOf(await run(row, claimFor('fathom-port-twice')))
    expect(second).toEqual(first)
    expect(await total(interaction)).toBe(before + 1)
  })

  it('writes no note and proposes no suggestion for the payload’s summary', async () => {
    const row = await boundRow('fathom')
    const notes = await total(note)
    const suggestions = await total(suggestion)
    valueOf(await run(row, claimFor('fathom-port-nonote')))
    expect(await total(note)).toBe(notes)
    expect(await total(suggestion)).toBe(suggestions)
  })

  it('refuses a body beside a recorder payload, and a claim with nowhere to live', () => {
    // A bundle is JavaScript: the type forbids both, the port checks them.
    // @ts-expect-error — what a recorder's notes become is the host's
    const withBody: InteractionClaim = {
      ...claimFor('fathom-port-body'),
      body: 'the summary as a write-up',
    }
    expect(readInteractionShape(withBody)).toEqual({
      ok: false,
      reason: "a recorder's payload carries no body: its notes are the host's",
    })
    // @ts-expect-error — an interaction names an entity or a participant
    const nowhere: InteractionClaim = {
      _tag: 'interaction',
      kind: 'call',
      occurredAt: '2026-10-08T10:00:00.000Z',
      recorder: { providerEventId: 'nobody', raw: null },
    }
    expect(readInteractionShape(nowhere)).toEqual({
      ok: false,
      reason: 'an interaction names at least one entity or participant',
    })
  })
})
