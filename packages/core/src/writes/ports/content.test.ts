import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  integration,
  interaction,
  interactionEntity,
  note,
  signal,
  user,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Content } from '@spaces/sdk'
import type { InteractionClaim, SignalClaim } from '@spaces/sdk'
import { resolveEntity } from '../entities/resolve'
import { ContentLive } from './content'

/**
 * Content's interaction and signal lanes bound to one integration row
 * (sdk-7b), against a real database: the dedupe is the same unique index the
 * mailbox relies on, and every row these lanes write names the bound row —
 * whatever a caller passes.
 */

const boundRow = async (capabilityId = 'researcher') => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const run = <TValue>(
  row: { id: string; capabilityId: string },
  program: Effect.Effect<TValue, unknown, Content>,
) => Effect.runPromise(program.pipe(Effect.provide(ContentLive(row))))

const runExit = <TValue>(
  row: { id: string; capabilityId: string },
  program: Effect.Effect<TValue, unknown, Content>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(ContentLive(row))))

const logInteraction = (claim: InteractionClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Content).logInteraction(claim)
  })
const emitSignal = (claim: SignalClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Content).emitSignal(claim)
  })

const company = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId
const person = async (name: string, email: string) =>
  (
    await resolveEntity({
      kind: 'person',
      name,
      keys: { email },
      source: { class: 'manual' },
    })
  ).entityId

const edgesOf = async (interactionId: string) =>
  (
    await db
      .select({ entityId: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, interactionId))
  )
    .map((e) => e.entityId)
    .sort()

describe('Content.logInteraction, bound to an integration row', () => {
  it('a messageId twice is one interaction row with both entity edges', async () => {
    const row = await boundRow('syncer')
    const acme = await company('Acme', 'acme-content.example')
    const jane = await person('Jane', 'jane@acme-content.example')
    const claim: InteractionClaim = {
      _tag: 'interaction',
      kind: 'email',
      occurredAt: '2026-09-30T10:00:00Z',
      entityIds: [acme, jane],
      subject: 'Intro',
      messageId: '<intro-1@acme-content.example>',
      threadId: 'thread-intro',
    }
    const first = await run(row, logInteraction(claim))
    const second = await run(row, logInteraction(claim))
    expect(second).toEqual(first)

    const rows = await db
      .select()
      .from(interaction)
      .where(eq(interaction.messageId, '<intro-1@acme-content.example>'))
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      id: first.interactionId,
      kind: 'email',
      sourceClass: 'integration',
      sourceRef: row.id,
      threadId: 'thread-intro',
      subject: 'Intro',
      noteId: null,
    })
    expect(await edgesOf(first.interactionId)).toEqual([acme, jane].sort())
  })

  it('dedupes against a row the mailbox wrote: one index, one row', async () => {
    const mailbox = await boundRow('core.mailbox')
    const row = await boundRow('syncer')
    const acme = await company('Shared Co', 'shared-content.example')
    const messageId = '<shared@shared-content.example>'
    const held = (
      await db
        .insert(interaction)
        .values({
          kind: 'email',
          sourceClass: 'integration',
          sourceRef: mailbox.id,
          messageId,
          occurredAt: new Date('2026-09-30T09:00:00Z'),
        })
        .returning({ id: interaction.id })
    ).at(0)
    const result = await run(
      row,
      logInteraction({
        _tag: 'interaction',
        kind: 'email',
        occurredAt: '2026-09-30T09:00:00Z',
        entityIds: [acme],
        messageId,
        body: 'already filed by the mailbox',
      }),
    )
    expect(result.interactionId).toBe(held?.id)
    expect(
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.messageId, messageId)),
    ).toHaveLength(1)
    // A duplicate writes nothing else: no body note, no edge.
    expect(await edgesOf(result.interactionId)).toEqual([])
  })

  it('without a messageId, a new interaction every time — as on the manual path', async () => {
    const row = await boundRow('recorder')
    const acme = await company('NoKey Co', 'nokey-content.example')
    const claim: InteractionClaim = {
      _tag: 'interaction',
      kind: 'call',
      occurredAt: '2026-09-30T11:00:00Z',
      entityIds: [acme],
      subject: 'Weekly',
    }
    const a = await run(row, logInteraction(claim))
    const b = await run(row, logInteraction(claim))
    expect(a.interactionId).not.toBe(b.interactionId)
    const rows = await db
      .select()
      .from(interaction)
      .where(eq(interaction.sourceRef, row.id))
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.messageId).toBeNull()
  })

  it('writes the body as a private note, authored by the installing admin', async () => {
    const admin = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!admin) throw new Error('the harness seeds a user')
    const row = (
      await db
        .insert(integration)
        .values({
          capabilityId: 'syncer',
          version: '1.0.0',
          enabled: true,
          createdBy: admin.id,
        })
        .returning()
    ).at(0)
    if (!row) throw new Error('no row')
    const acme = await company('Body Co', 'body-content.example')
    const { interactionId } = await run(
      row,
      logInteraction({
        _tag: 'interaction',
        kind: 'meeting',
        occurredAt: '2026-09-30T12:00:00Z',
        entityIds: [acme],
        subject: 'Board prep',
        body: 'Line one\n\nLine two',
      }),
    )
    const written = (
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, interactionId))
    ).at(0)
    expect(written?.noteId).toBeTruthy()
    const body = (
      await db
        .select()
        .from(note)
        .where(eq(note.entityId, written?.noteId ?? ''))
    ).at(0)
    expect(body).toMatchObject({
      title: 'Board prep',
      bodyMd: 'Line one\n\nLine two',
      authorId: admin.id,
      visibility: 'private',
    })
    const noteEntity = (
      await db
        .select()
        .from(entity)
        .where(eq(entity.id, written?.noteId ?? ''))
    ).at(0)
    expect(noteEntity).toMatchObject({
      kind: 'note',
      sourceClass: 'integration',
      sourceRef: row.id,
    })
  })

  it('edges a merged-away id to its survivor, and refuses an id that names nothing', async () => {
    const row = await boundRow('syncer')
    const winner = await company('Winner', 'winner-content.example')
    const loser = await company('Loser', 'loser-content.example')
    await db
      .update(entity)
      .set({ mergedIntoId: winner })
      .where(eq(entity.id, loser))
    const { interactionId } = await run(
      row,
      logInteraction({
        _tag: 'interaction',
        kind: 'call',
        occurredAt: '2026-09-30T13:00:00Z',
        entityIds: [loser],
      }),
    )
    expect(await edgesOf(interactionId)).toEqual([winner])

    const exit = await runExit(
      row,
      logInteraction({
        _tag: 'interaction',
        kind: 'call',
        occurredAt: '2026-09-30T13:00:00Z',
        entityIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    )
    expect(JSON.stringify(exit)).toContain('JobPermanent')
  })
})

describe('Content.emitSignal', () => {
  it('writes a signal as the integration, payload intact, on the entity and its timeline', async () => {
    const row = await boundRow('researcher')
    const acme = await company('Signal Co', 'signal-content.example')
    const payload = {
      score: 0.82,
      authors: ['A. Writer'],
      nested: { deep: [1, { x: null }] },
    }
    const { signalId } = await run(
      row,
      emitSignal({
        _tag: 'signal',
        entityId: acme,
        kind: 'web',
        title: 'Signal Co raises a seed',
        url: 'https://news.example/signal-co',
        publishedAt: '2026-09-29T08:00:00Z',
        payload,
      }),
    )
    const stored = (
      await db.select().from(signal).where(eq(signal.id, signalId))
    ).at(0)
    expect(stored).toMatchObject({
      entityId: acme,
      source: 'researcher',
      sourceClass: 'integration',
      sourceRef: row.id,
      payload: {
        kind: 'web',
        title: 'Signal Co raises a seed',
        url: 'https://news.example/signal-co',
        publishedAt: '2026-09-29T08:00:00Z',
        payload,
      },
    })
    const acts = await db
      .select()
      .from(activity)
      .where(eq(activity.subjectEntityId, acme))
    expect(acts.filter((a) => a.verb === 'signal.emitted')).toEqual([
      expect.objectContaining({
        actorId: null,
        meta: expect.objectContaining({
          actorType: 'integration',
          integrationId: row.id,
          capabilityId: 'researcher',
          signalId,
        }),
      }),
    ])
  })

  it('refuses an entity that does not exist', async () => {
    const row = await boundRow('researcher')
    const exit = await runExit(
      row,
      emitSignal({
        _tag: 'signal',
        entityId: '00000000-0000-4000-8000-000000000000',
        kind: 'web',
      }),
    )
    expect(JSON.stringify(exit)).toContain('JobPermanent')
    expect(
      await db.select().from(signal).where(eq(signal.sourceRef, row.id)),
    ).toEqual([])
  })
})

describe('provenance is the port’s', () => {
  it('ignores a source a caller tries to smuggle into either lane', async () => {
    const row = await boundRow('researcher')
    const other = await boundRow('impostor')
    const acme = await company('Smuggle Co', 'smuggle-content.example')
    // The claim types carry no source (D52); at runtime an object can carry
    // anything, and the port must not read it.
    const forged = {
      source: 'impostor',
      sourceClass: 'manual',
      sourceRef: other.id,
      integrationId: other.id,
      actor: { type: 'user', id: 'someone' },
    }
    const smuggledSignal = {
      _tag: 'signal' as const,
      entityId: acme,
      kind: 'web',
      payload: { ok: true },
      ...forged,
    }
    const entityIds: [string] = [acme]
    const smuggledInteraction = {
      _tag: 'interaction' as const,
      kind: 'email' as const,
      occurredAt: '2026-09-30T14:00:00Z',
      entityIds,
      messageId: '<smuggle@smuggle-content.example>',
      ...forged,
    }
    const { signalId } = await run(row, emitSignal(smuggledSignal))
    const { interactionId } = await run(
      row,
      logInteraction(smuggledInteraction),
    )

    const s = (
      await db.select().from(signal).where(eq(signal.id, signalId))
    ).at(0)
    expect(s).toMatchObject({
      source: 'researcher',
      sourceClass: 'integration',
      sourceRef: row.id,
      payload: { kind: 'web', payload: { ok: true } },
    })
    expect(JSON.stringify(s?.payload)).not.toContain(other.id)
    const i = (
      await db
        .select()
        .from(interaction)
        .where(eq(interaction.id, interactionId))
    ).at(0)
    expect(i).toMatchObject({
      sourceClass: 'integration',
      sourceRef: row.id,
    })
  })
})
