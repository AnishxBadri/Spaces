import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  interactionStat,
} from '@spaces/db/schema'
import type { MergeSnapshotEntry } from '@spaces/db/schema/entities'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { readInteractionMeta } from '../../json'
import { repointRegistryInTx } from '../entities/merge'
import { updateInteraction, writeIntegrationInteraction } from './write'

/**
 * `interaction.meta` through the writer, and the artifact join beside it:
 * a cancelled meeting with two RSVPs reads back typed, its transcript hangs
 * off `interaction_document`, and a merge of that document moves the join.
 */

const anIntegration = async () => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'calendar', version: '1.0.0', enabled: true })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

/** A document fixture: the entity and its side-table row. */
const aDocument = async (name: string) => {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document entity')
  await db
    .insert(document)
    .values({ entityId: ent.id, filename: `${name}.txt`, kind: 'other' })
  return ent.id
}

const cancelled: MeetingMeta = {
  kind: 'meeting',
  ends_at: '2026-10-08T10:30:00.000Z',
  status: 'cancelled',
  conference_url: 'https://meet.example/abc-defg-hij',
  organizer: 'priya@ohmium.example',
  recurring_instance_id: null,
  rsvp: {
    'priya@ohmium.example': 'accepted',
    'anish@fund.example': 'declined',
  },
}

const meeting = (integrationId: string, meta?: MeetingMeta) => ({
  integrationId,
  kind: 'meeting' as const,
  messageId: null,
  threadId: null,
  subject: 'Ohmium follow-up',
  occurredAt: new Date('2026-10-08T10:00:00.000Z'),
  body: null,
  edges: [],
  ...(meta === undefined ? {} : { meta }),
})

describe('interaction meta and artifacts', () => {
  it('writes a cancelled meeting with its RSVPs and reads it back typed', async () => {
    const integrationId = await anIntegration()
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, meeting(integrationId, cancelled)),
    )
    if (written.kind !== 'written') throw new Error('expected a new row')

    const row = (
      await db
        .select({ kind: interaction.kind, meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.id, written.interactionId))
    ).at(0)
    if (!row || row.meta === null) throw new Error('no meta written')
    const read = readInteractionMeta(row.kind, row.meta)
    expect(read).toEqual({ ok: true, meta: cancelled })
    if (!read.ok || read.meta?.kind !== 'meeting')
      throw new Error('expected a meeting shape')
    expect(read.meta.status).toBe('cancelled')
    expect(read.meta.rsvp['anish@fund.example']).toBe('declined')
  })

  it('leaves meta null when the lane gives none', async () => {
    const integrationId = await anIntegration()
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, meeting(integrationId)),
    )
    if (written.kind !== 'written') throw new Error('expected a new row')
    const row = (
      await db
        .select({ meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.id, written.interactionId))
    ).at(0)
    expect(row?.meta).toBeNull()
  })

  it('refuses a meeting shape on an email row and writes nothing', async () => {
    const integrationId = await anIntegration()
    const tag = randomUUID()
    await expect(
      db.transaction((tx) =>
        writeIntegrationInteraction(tx, {
          ...meeting(integrationId, cancelled),
          kind: 'email',
          messageId: `<${tag}@mail.example>`,
        }),
      ),
    ).rejects.toThrow(/meeting shape; the row is email/)
    const held = await db
      .select({ id: interaction.id })
      .from(interaction)
      .where(eq(interaction.messageId, `<${tag}@mail.example>`))
    expect(held).toEqual([])
  })

  it('attaches a transcript, and a merge of the document moves the join', async () => {
    const integrationId = await anIntegration()
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, meeting(integrationId, cancelled)),
    )
    if (written.kind !== 'written') throw new Error('expected a new row')
    const loser = await aDocument('Transcript copy')
    const winner = await aDocument('Transcript')
    await db.insert(interactionDocument).values({
      interactionId: written.interactionId,
      documentId: loser,
      role: 'transcript',
    })

    const artifacts = await db
      .select()
      .from(interactionDocument)
      .where(eq(interactionDocument.interactionId, written.interactionId))
    expect(artifacts).toEqual([
      {
        interactionId: written.interactionId,
        documentId: loser,
        role: 'transcript',
      },
    ])

    const snapshot: Array<MergeSnapshotEntry> = []
    await db.transaction((tx) =>
      repointRegistryInTx(tx, loser, winner, snapshot),
    )

    const after = await db
      .select()
      .from(interactionDocument)
      .where(eq(interactionDocument.interactionId, written.interactionId))
    expect(after).toEqual([
      {
        interactionId: written.interactionId,
        documentId: winner,
        role: 'transcript',
      },
    ])
    expect(snapshot.filter((e) => e.table === 'interaction_document')).toEqual([
      {
        table: 'interaction_document',
        action: 'repointed',
        pk: { interactionId: written.interactionId, documentId: loser },
        old: { documentId: loser },
      },
    ])
  })

  it('drops the loser’s join when the interaction already holds the winner', async () => {
    const integrationId = await anIntegration()
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, meeting(integrationId)),
    )
    if (written.kind !== 'written') throw new Error('expected a new row')
    const loser = await aDocument('Recording link copy')
    const winner = await aDocument('Recording link')
    await db.insert(interactionDocument).values([
      {
        interactionId: written.interactionId,
        documentId: loser,
        role: 'recording_link',
      },
      {
        interactionId: written.interactionId,
        documentId: winner,
        role: 'recording_link',
      },
    ])

    const snapshot: Array<MergeSnapshotEntry> = []
    await db.transaction((tx) =>
      repointRegistryInTx(tx, loser, winner, snapshot),
    )

    const after = await db
      .select({ documentId: interactionDocument.documentId })
      .from(interactionDocument)
      .where(eq(interactionDocument.interactionId, written.interactionId))
    expect(after).toEqual([{ documentId: winner }])
    expect(
      snapshot
        .filter((e) => e.table === 'interaction_document')
        .map((e) => e.action),
    ).toEqual(['dropped'])
  })
})

describe('updateInteraction', () => {
  const aPerson = async (name: string) => {
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'person', canonicalName: name })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('no person')
    return ent.id
  }

  it('adds and drops edges in place, and rebuilds the stats of the one it lost', async () => {
    const integrationId = await anIntegration()
    const [jane, sam, lee] = [
      await aPerson('Jane'),
      await aPerson('Sam'),
      await aPerson('Lee'),
    ]
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        ...meeting(integrationId, { ...cancelled, status: 'scheduled' }),
        messageId: `uid-${randomUUID()}`,
        edges: [jane, sam],
      }),
    )
    if (written.kind !== 'written') throw new Error('not written')
    const statsOf = async (entityId: string) =>
      db
        .select({ kind: interactionStat.kind })
        .from(interactionStat)
        .where(eq(interactionStat.entityId, entityId))
    expect(await statsOf(sam)).not.toEqual([])

    await db.transaction((tx) =>
      updateInteraction(tx, written.interactionId, {
        occurredAt: new Date('2026-10-09T10:00:00.000Z'),
        edges: { add: [jane, lee], remove: [sam] },
      }),
    )
    const edges = await db
      .select({ entityId: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, written.interactionId))
    expect(edges.map((e) => e.entityId).sort()).toEqual([jane, lee].sort())
    expect(await statsOf(sam)).toEqual([])
    expect(await statsOf(lee)).not.toEqual([])
    const row = (
      await db
        .select({ occurredAt: interaction.occurredAt })
        .from(interaction)
        .where(eq(interaction.id, written.interactionId))
    ).at(0)
    expect(row?.occurredAt.toISOString()).toBe('2026-10-09T10:00:00.000Z')
  })
})

describe('a blind copy', () => {
  const aPerson = async (name: string, email: string) => {
    const ent = (
      await db
        .insert(entity)
        .values({ kind: 'person', canonicalName: name })
        .returning({ id: entity.id })
    ).at(0)
    if (!ent) throw new Error('no person')
    await db.insert(entityAlias).values({
      entityId: ent.id,
      kind: 'email',
      value: email,
      valueNorm: email.toLowerCase(),
      isIdentity: true,
    })
    return ent.id
  }

  it('is never edged and never counted, while To and Cc are', async () => {
    const integrationId = await anIntegration()
    const dana = await aPerson('Dana Moreau', 'dana@flent.example')
    const kiran = await aPerson('Kiran Shah', 'kiran@flent.example')
    const priya = await aPerson('Priya Nair', 'Priya@Fund.example')
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        integrationId,
        kind: 'email',
        messageId: `<${randomUUID()}@fund.example>`,
        threadId: null,
        subject: 'Flent diligence — next steps',
        occurredAt: new Date('2026-10-08T10:44:00.000Z'),
        meta: {
          kind: 'email',
          from: 'anish@fund.example',
          to: ['dana@flent.example'],
          cc: ['kiran@flent.example'],
          bcc: ['priya@fund.example'],
          date: '2026-10-08T10:44:00.000Z',
          mime_blob_sha: null,
        },
        body: null,
        // A caller that matched every address still leaves the Bcc out.
        edges: [dana, kiran, priya],
      }),
    )
    if (written.kind !== 'written') throw new Error('not written')
    expect(written.edges.sort()).toEqual([dana, kiran].sort())

    const edged = await db
      .select({ entityId: interactionEntity.entityId })
      .from(interactionEntity)
      .where(eq(interactionEntity.interactionId, written.interactionId))
    expect(edged.map((e) => e.entityId).sort()).toEqual([dana, kiran].sort())

    const statsOf = (entityId: string) =>
      db
        .select({ kind: interactionStat.kind })
        .from(interactionStat)
        .where(eq(interactionStat.entityId, entityId))
    expect(await statsOf(priya)).toEqual([])
    expect((await statsOf(dana)).map((s) => s.kind).sort()).toEqual([
      'any',
      'email',
    ])

    const row = (
      await db
        .select({ kind: interaction.kind, meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.id, written.interactionId))
    ).at(0)
    if (!row || row.meta === null) throw new Error('no meta')
    expect(readInteractionMeta(row.kind, row.meta)).toMatchObject({
      ok: true,
      meta: { bcc: ['priya@fund.example'] },
    })
  })

  it('keeps the edge of a person also named in To', async () => {
    const integrationId = await anIntegration()
    const dana = await aPerson('Sam Ortiz', 'sam@flent.example')
    const written = await db.transaction((tx) =>
      writeIntegrationInteraction(tx, {
        integrationId,
        kind: 'email',
        messageId: `<${randomUUID()}@fund.example>`,
        threadId: null,
        subject: null,
        occurredAt: new Date('2026-10-08T10:44:00.000Z'),
        meta: {
          kind: 'email',
          from: 'anish@fund.example',
          to: ['sam@flent.example'],
          cc: [],
          bcc: ['SAM@flent.example'],
          date: '2026-10-08T10:44:00.000Z',
          mime_blob_sha: null,
        },
        body: null,
        edges: [dana],
      }),
    )
    if (written.kind !== 'written') throw new Error('not written')
    expect(written.edges).toEqual([dana])
  })
})
