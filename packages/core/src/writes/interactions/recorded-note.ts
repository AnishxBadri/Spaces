import { Effect, Schema } from 'effect'
import { and, arrayOverlaps, eq, like, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  enrichmentRecord,
  entity,
  integration,
  interaction,
  interactionDocument,
  interactionNote,
  note,
  suggestion,
} from '@spaces/db/schema'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import type { Json } from '@spaces/db/json'
import type { DomainEvent } from '@spaces/sdk'
import { ref } from '../../context/ref'
import { deleteEntityProgram } from '../entities/delete'
import type { Tx } from '../entities/resolve'
import { removeInteractions } from './remove'
import { writeRecordedInteraction } from './write'
import type { RecordedArtifact } from './write'

/**
 * The recorder contract's host half (D78): one recorded note in, matched to
 * its meeting by `writeRecordedInteraction`, or Spaces' copy of it out.
 * - The key is per connection: a member's note is theirs to share or take
 *   back, so two members' notes of one meeting are two recorder events.
 * - What a note becomes beyond its row and receipt — the write-up, a second
 *   note, task suggestions, private extras — is `landRecordedNote`'s.
 * - Removal finds what the note became by provenance: notes and documents
 *   this integration wrote for the note's author on that interaction, task
 *   suggestions citing its receipt or its notes, the receipt itself.
 *   One note per member per meeting is assumed.
 */

/** The row key of one recorded note: `interaction.message_id` or a recorder event's id. */
export const recorderKey = (
  integrationId: string,
  connectionId: string | null,
  providerNoteId: string,
): string =>
  `rec:${integrationId}:${connectionId ?? 'workspace'}:${providerNoteId}`

/** Every key one connection's notes are held under. */
const connectionKeys = (connectionId: string) => `rec:%:${connectionId}:%`

/** A recorded note as the port checked it. */
export type RecordedNoteInput = {
  providerNoteId: string
  title: string | null
  startedAt: Date
  durationSeconds: number | null
  /** Trimmed, lowercased; the 30-minute fallback's test. */
  emails: ReadonlyArray<string>
  calendarEventId: string | null
  icalUid: string | null
  summary: string | null
  typedNotes: string | null
  transcript: string | null
  webUrl: string | null
  recordingUrl: string | null
  raw: Json
}

/** Who wrote the note, and through which connection. */
export type RecordedNoteOwner = {
  integrationId: string
  /** Null for a webhook recorder, which has no member's connection. */
  connectionId: string | null
  /** The member whose note it is: the author of everything it becomes. */
  authorId: string
}

/** What `landRecordedNote` is handed, inside the write's transaction. */
export type RecordedNoteLanding = RecordedNoteOwner & {
  outcome: 'attached' | 'born' | 'duplicate'
  interactionId: string
  receiptId: string
  key: string
  note: RecordedNoteInput
}

/**
 * The landing rules (D78, arrival-7): what a fetched note becomes — the
 * write-up when the meeting has none, else a second shared note
 * (`interaction_note`, `recorder_note`), task suggestions citing the receipt,
 * the opted-in typed notes and transcript private to the author. Called once
 * per delivery, a duplicate included. Today it lands nothing beyond the row
 * and its receipt.
 */
export const landRecordedNote: (
  tx: Tx,
  landing: RecordedNoteLanding,
) => Promise<void> = async () => {}

type Held = {
  interactionId: string
  kind: 'meeting' | 'call'
  receiptId: string | null
}

/** The row a key landed on: the call it was born as, or the meeting it attached to. */
async function heldRecording(tx: Tx, key: string): Promise<Held | null> {
  const rows = await tx
    .select({
      id: interaction.id,
      kind: interaction.kind,
      meta: interaction.meta,
    })
    .from(interaction)
    .where(
      or(
        eq(interaction.messageId, key),
        and(
          eq(interaction.kind, 'meeting'),
          sql`${interaction.meta} -> 'recorder_events' @> ${JSON.stringify([{ provider_event_id: key }])}::jsonb`,
        ),
      ),
    )
    .limit(1)
  const row = rows.at(0)
  if (row === undefined) return null
  const meta = row.meta
  if (meta?.kind === 'call')
    return {
      interactionId: row.id,
      kind: 'call',
      receiptId: meta.receipt_id ?? null,
    }
  if (meta?.kind === 'meeting')
    return {
      interactionId: row.id,
      kind: 'meeting',
      receiptId:
        meta.recorder_events?.find((e) => e.provider_event_id === key)
          ?.receipt_id ?? null,
    }
  return null
}

const lockKey = (tx: Tx, owner: RecordedNoteOwner, key: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`recorder ${owner.integrationId} ${key}`}, 0))`,
  )

export type RecordedNoteWritten = {
  outcome: 'attached' | 'born' | 'duplicate'
  interactionId: string
  /** To dispatch once the transaction commits. */
  events: Array<DomainEvent>
}

/**
 * One recorded note, in one transaction: the receipt first — only on a first
 * delivery, so a replay stores nothing twice — then the match, then the
 * landing rules.
 */
export async function writeRecordedNote(
  owner: RecordedNoteOwner,
  input: RecordedNoteInput,
  edges: ReadonlyArray<string>,
): Promise<RecordedNoteWritten> {
  const key = recorderKey(
    owner.integrationId,
    owner.connectionId,
    input.providerNoteId,
  )
  return db.transaction(async (tx) => {
    // The writer takes the same lock; a transaction holds it twice.
    await lockKey(tx, owner, key)
    const held = await heldRecording(tx, key)
    if (held !== null) {
      if (held.receiptId !== null)
        await landRecordedNote(tx, {
          ...owner,
          outcome: 'duplicate',
          interactionId: held.interactionId,
          receiptId: held.receiptId,
          key,
          note: input,
        })
      return {
        outcome: 'duplicate',
        interactionId: held.interactionId,
        events: [],
      }
    }
    const receipt = (
      await tx
        .insert(enrichmentRecord)
        .values({
          entityId: null,
          provider: await capabilityOf(tx, owner.integrationId),
          raw: input.raw,
          creditsUsed: null,
          integrationId: owner.integrationId,
        })
        .returning({ id: enrichmentRecord.id })
    ).at(0)
    if (receipt === undefined) throw new Error('receipt insert returned no row')
    const artifacts: Array<RecordedArtifact> =
      input.recordingUrl === null
        ? []
        : [
            {
              role: 'recording_link',
              url: input.recordingUrl,
              title: 'Recording',
            },
          ]
    const written = await writeRecordedInteraction(tx, {
      integrationId: owner.integrationId,
      providerEventId: key,
      icalUid: input.icalUid,
      calendarEventId: input.calendarEventId,
      occurredAt: input.startedAt,
      subject: input.title,
      durationSeconds: input.durationSeconds,
      emails: input.emails,
      receiptId: receipt.id,
      edges,
      artifacts,
    })
    await landRecordedNote(tx, {
      ...owner,
      outcome: written.outcome,
      interactionId: written.interactionId,
      receiptId: receipt.id,
      key,
      note: input,
    })
    return written
  })
}

/** The receipt's display text: the plugin's manifest id. */
async function capabilityOf(tx: Tx, integrationId: string): Promise<string> {
  const row = (
    await tx
      .select({ capabilityId: integration.capabilityId })
      .from(integration)
      .where(eq(integration.id, integrationId))
  ).at(0)
  if (row === undefined) throw new Error(`no integration ${integrationId}`)
  return row.capabilityId
}

/** What one key's removal found: the entities to delete before the rows go. */
type Found = {
  held: Held
  notes: Array<string>
  documents: Array<string>
}

/** The notes and documents a key became on its interaction, by provenance. */
async function findCopies(
  tx: Tx,
  owner: RecordedNoteOwner,
  held: Held,
  shared: boolean,
): Promise<Found> {
  const fromIntegration = and(
    eq(entity.sourceClass, 'integration'),
    eq(entity.sourceRef, owner.integrationId),
  )
  const writeUp = await tx
    .select({ id: note.entityId })
    .from(interaction)
    .innerJoin(note, eq(note.entityId, interaction.noteId))
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(
      and(
        eq(interaction.id, held.interactionId),
        eq(note.authorId, owner.authorId),
        fromIntegration,
      ),
    )
  const carried = await tx
    .select({ id: note.entityId })
    .from(interactionNote)
    .innerJoin(note, eq(note.entityId, interactionNote.noteId))
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(
      and(
        eq(interactionNote.interactionId, held.interactionId),
        eq(note.authorId, owner.authorId),
        fromIntegration,
      ),
    )
  // The member's private artifacts; a born call takes every artifact this
  // integration filed on it, a shared meeting keeps the others'.
  const artifacts = await tx
    .select({ id: document.entityId, authorId: document.authorId })
    .from(interactionDocument)
    .innerJoin(document, eq(document.entityId, interactionDocument.documentId))
    .where(
      and(
        eq(interactionDocument.interactionId, held.interactionId),
        eq(document.sourceRef, owner.integrationId),
      ),
    )
  return {
    held,
    notes: [...writeUp, ...carried].map((r) => r.id),
    documents: artifacts
      .filter((a) => !shared || a.authorId === owner.authorId)
      .map((a) => a.id),
  }
}

/** Removing Spaces' copy of a recorded note failed; nothing was half-removed for good. */
export class RecordedNoteRemovalFailed extends Schema.TaggedError<RecordedNoteRemovalFailed>()(
  'RecordedNoteRemovalFailed',
  { cause: Schema.Defect() },
) {}

/**
 * Spaces' copy of recorded notes, removed: what each became, its open task
 * suggestions, its private artifacts, its receipt and its recorder event —
 * or the whole call it had born. A calendar meeting stays.
 * - Notes and documents go first, through `deleteEntityProgram`, so a run cut
 *   short finds the rest next time under the same recorder event.
 * - Answers the interaction each key hung off; null for one nothing held.
 */
export const removeRecordedNotesProgram = Effect.fn('removeRecordedNotes')(
  function* (
    owner: RecordedNoteOwner,
    keys: ReadonlyArray<string>,
  ): Effect.fn.Return<Array<string | null>, RecordedNoteRemovalFailed> {
    const out: Array<string | null> = []
    for (const key of keys) {
      const found = yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx): Promise<Found | null> => {
            const held = await heldRecording(tx, key)
            if (held === null) return null
            return findCopies(tx, owner, held, held.kind === 'meeting')
          }),
        catch: (cause) => new RecordedNoteRemovalFailed({ cause }),
      })
      if (found === null) {
        out.push(null)
        continue
      }
      for (const id of [...found.notes, ...found.documents])
        yield* deleteEntityProgram(id).pipe(
          Effect.mapError((cause) => new RecordedNoteRemovalFailed({ cause })),
        )
      const leftover = yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await lockKey(tx, owner, key)
            const held = await heldRecording(tx, key)
            if (held === null) return []
            const cites = [
              ...(held.receiptId === null ? [] : [ref.event(held.receiptId)]),
              ...found.notes.map((id) => ref.note(id)),
            ]
            if (cites.length > 0)
              await tx
                .delete(suggestion)
                .where(
                  and(
                    eq(suggestion.kind, 'task'),
                    eq(suggestion.status, 'open'),
                    arrayOverlaps(suggestion.refs, cites),
                  ),
                )
            if (held.receiptId !== null)
              await tx
                .delete(enrichmentRecord)
                .where(eq(enrichmentRecord.id, held.receiptId))
            if (held.kind === 'call') {
              const { noteIds } = await removeInteractions(tx, [
                held.interactionId,
              ])
              return noteIds
            }
            const row = (
              await tx
                .select({ meta: interaction.meta })
                .from(interaction)
                .where(eq(interaction.id, held.interactionId))
                .for('update')
            ).at(0)
            if (row?.meta?.kind === 'meeting') {
              const { recorder_events: events, ...rest } = row.meta
              const kept = (events ?? []).filter(
                (e) => e.provider_event_id !== key,
              )
              const meta: MeetingMeta =
                kept.length === 0 ? rest : { ...rest, recorder_events: kept }
              await tx
                .update(interaction)
                .set({ meta })
                .where(eq(interaction.id, held.interactionId))
            }
            return []
          }),
        catch: (cause) => new RecordedNoteRemovalFailed({ cause }),
      })
      // A born call's own write-up, if anyone wrote one, goes with it.
      for (const id of leftover)
        yield* deleteEntityProgram(id).pipe(
          Effect.mapError((cause) => new RecordedNoteRemovalFailed({ cause })),
        )
      out.push(found.held.interactionId)
    }
    return out
  },
)

/** Every key a connection's runs wrote: what Disconnect removes. */
export async function connectionRecordingKeys(
  connectionId: string,
): Promise<Array<string>> {
  const calls = await db
    .select({ key: interaction.messageId })
    .from(interaction)
    .where(
      and(
        eq(interaction.kind, 'call'),
        like(interaction.messageId, connectionKeys(connectionId)),
      ),
    )
  const meetings = await db.execute<{ key: string }>(
    sql`select e ->> 'provider_event_id' as key
          from interaction i, jsonb_array_elements(i.meta -> 'recorder_events') e
         where i.kind = 'meeting'
           and e ->> 'provider_event_id' like ${connectionKeys(connectionId)}`,
  )
  return [
    ...calls.flatMap((c) => (c.key === null ? [] : [c.key])),
    ...meetings.rows.map((r) => r.key),
  ]
}

/**
 * Every recorded note a connection's runs wrote, removed (Disconnect): its
 * member is the author, under each integration that wrote them. Answers how
 * many interactions lost a copy.
 */
export async function removeConnectionRecordings(
  connectionId: string,
): Promise<number> {
  const conn = (
    await db
      .select({ userId: accountConnection.userId })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)
  if (conn === undefined) return 0
  const keys = await connectionRecordingKeys(connectionId)
  const byIntegration = new Map<string, Array<string>>()
  for (const key of keys) {
    const integrationId = key.split(':').at(1)
    if (integrationId === undefined) continue
    byIntegration.set(integrationId, [
      ...(byIntegration.get(integrationId) ?? []),
      key,
    ])
  }
  let removed = 0
  for (const [integrationId, held] of byIntegration) {
    const done = await Effect.runPromise(
      removeRecordedNotesProgram(
        { integrationId, connectionId, authorId: conn.userId },
        held,
      ),
    )
    removed += done.filter((id) => id !== null).length
  }
  return removed
}
