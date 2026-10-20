import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import {
  and,
  arrayOverlaps,
  eq,
  inArray,
  isNull,
  like,
  or,
  sql,
} from 'drizzle-orm'
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
  link,
  note,
  suggestion,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type {
  InteractionMeta,
  MeetingMeta,
} from '@spaces/db/schema/interactions'
import type { Json } from '@spaces/db/json'
import type { DomainEvent } from '@spaces/sdk'
import { ref } from '../../context/ref'
import type { DocumentFilingTarget } from '../../documents/filing'
import { writeUpTitle } from '../../interactions/write-up-title'
import { jsonRecord, jsonString, readRecorderSettings } from '../../json'
import type { RecorderSettings } from '../../json'
import { noteBodyFromMarkdown } from '../../notes/markdown-blocks'
import type { Enqueue } from '../../queue/enqueue'
import { birthDocumentProgram } from '../documents/birth'
import type { DocumentBirthRejected } from '../documents/birth'
import { putBlobProgram } from '../documents/intake'
import type { DocumentTooLarge } from '../documents/intake'
import { deleteEntityProgram } from '../entities/delete'
import type { Tx } from '../entities/resolve'
import { removeInteractions } from './remove'
import { interactionParticipants } from './stats'
import { MAX_BODY_CHARS, writeRecordedInteraction } from './write'
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

/** A key read back: its integration and connection, `null` for a webhook recorder's. */
export function parseRecorderKey(
  key: string,
): { integrationId: string; connectionId: string | null } | null {
  const [tag, integrationId, connection] = key.split(':')
  if (tag !== 'rec' || !integrationId || !connection) return null
  return {
    integrationId,
    connectionId: connection === 'workspace' ? null : connection,
  }
}

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

/** What the caller does once the write commits. */
export type RecordedNoteFollowUp = {
  /** The shared note just filed, whose summary the Extract lane reads for action items. */
  tasks: RecordedNoteTasks | null
  /** The opted-in transcript, when the member holds none on the row yet. */
  transcript: string | null
}

/** One shared note's action items, to propose as `task` suggestions. */
export type RecordedNoteTasks = {
  interactionId: string
  noteId: string
  integrationId: string
  receiptId: string
}

/** A recorder's display name: the manifest's, else its id. */
async function providerName(tx: Tx, integrationId: string): Promise<string> {
  const row = (
    await tx
      .select({
        capabilityId: integration.capabilityId,
        manifest: integration.manifest,
      })
      .from(integration)
      .where(eq(integration.id, integrationId))
  ).at(0)
  if (row === undefined) return 'Recorder'
  return jsonString(jsonRecord(row.manifest).name) ?? row.capabilityId
}

/** The connection's opt-ins; a webhook recorder has none, so both are off. */
async function settingsOf(
  tx: Tx,
  connectionId: string | null,
): Promise<RecorderSettings> {
  if (connectionId === null) return readRecorderSettings(null)
  const row = (
    await tx
      .select({ settings: accountConnection.settings })
      .from(accountConnection)
      .where(eq(accountConnection.id, connectionId))
  ).at(0)
  return readRecorderSettings(row?.settings ?? null)
}

/** The live company, person and deal records a meeting's notes file against. */
async function filingRecordIds(
  tx: Tx,
  interactionId: string,
): Promise<Array<string>> {
  const ids = await interactionParticipants(tx, interactionId)
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: entity.id, kind: entity.kind })
    .from(entity)
    .where(and(inArray(entity.id, ids), isNull(entity.mergedIntoId)))
  return rows
    .filter(
      (r) => r.kind === 'company' || r.kind === 'person' || r.kind === 'deal',
    )
    .map((r) => r.id)
}

/** What this member's note already became on the row, by provenance. */
type Landed = {
  shared: string | null
  typed: string | null
  transcript: string | null
}

async function landedOf(
  tx: Tx,
  owner: RecordedNoteOwner,
  interactionId: string,
): Promise<Landed> {
  const mine = and(
    eq(note.authorId, owner.authorId),
    eq(entity.sourceClass, 'integration'),
    eq(entity.sourceRef, owner.integrationId),
  )
  const writeUp = await tx
    .select({ id: note.entityId })
    .from(interaction)
    .innerJoin(note, eq(note.entityId, interaction.noteId))
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(and(eq(interaction.id, interactionId), mine))
  const carried = await tx
    .select({ id: note.entityId, role: interactionNote.role })
    .from(interactionNote)
    .innerJoin(note, eq(note.entityId, interactionNote.noteId))
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(and(eq(interactionNote.interactionId, interactionId), mine))
  const transcript = await tx
    .select({ id: document.entityId })
    .from(interactionDocument)
    .innerJoin(document, eq(document.entityId, interactionDocument.documentId))
    .where(
      and(
        eq(interactionDocument.interactionId, interactionId),
        eq(interactionDocument.role, 'transcript'),
        eq(document.sourceRef, owner.integrationId),
        eq(document.authorId, owner.authorId),
      ),
    )
  return {
    shared:
      writeUp.at(0)?.id ??
      carried.find((c) => c.role === 'recorder_note')?.id ??
      null,
    typed: carried.find((c) => c.role === 'typed_notes')?.id ?? null,
    transcript: transcript.at(0)?.id ?? null,
  }
}

/**
 * A recorder's note born for its member: rendered from markdown to blocks,
 * `body_md` serialized back from them, filed against the meeting's records.
 */
async function insertRecordedNote(
  tx: Tx,
  owner: RecordedNoteOwner,
  body: { title: string; markdown: string; visibility: 'shared' | 'private' },
  records: ReadonlyArray<string>,
): Promise<string> {
  const born = (
    await tx
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: body.title,
        createdBy: owner.authorId,
        sourceClass: 'integration',
        sourceRef: owner.integrationId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (born === undefined) throw new Error('note entity insert returned no row')
  const { bodyJson, bodyMd } = noteBodyFromMarkdown(
    body.markdown.slice(0, MAX_BODY_CHARS),
  )
  await tx.insert(note).values({
    entityId: born.id,
    authorId: owner.authorId,
    title: body.title,
    kind: 'note',
    bodyJson,
    bodyMd,
    visibility: body.visibility,
  })
  for (const toEntityId of records)
    await tx
      .insert(link)
      .values({
        fromEntityId: born.id,
        toEntityId,
        relation: 'tagged_in',
        source: 'manual',
        createdBy: owner.authorId,
      })
      .onConflictDoNothing()
  return born.id
}

/** The note's `web_url` kept on its recorder event: "Open in <provider>". */
async function keepWebUrl(
  tx: Tx,
  landing: RecordedNoteLanding,
  meta: InteractionMeta | null,
): Promise<void> {
  const url = landing.note.webUrl
  if (url === null || meta === null) return
  let next: InteractionMeta | null = null
  if (meta.kind === 'call' && meta.provider_event_id === landing.key) {
    if (meta.web_url !== url) next = { ...meta, web_url: url }
  } else if (meta.kind === 'meeting') {
    const events = meta.recorder_events ?? []
    if (
      events.some(
        (e) => e.provider_event_id === landing.key && e.web_url !== url,
      )
    )
      next = {
        ...meta,
        recorder_events: events.map((e) =>
          e.provider_event_id === landing.key ? { ...e, web_url: url } : e,
        ),
      }
  }
  if (next !== null)
    await tx
      .update(interaction)
      .set({ meta: next })
      .where(eq(interaction.id, landing.interactionId))
}

/**
 * The landing rules (D78): what a fetched note becomes.
 * - The summary is the meeting's write-up when it has none, else a second
 *   shared note (`interaction_note`, `recorder_note`) — never a suggestion,
 *   and a write-up already there is never rewritten.
 * - The typed notes, when the connection opts in, are a private note
 *   (`typed_notes`); the transcript is handed back for the caller to file.
 * - Idempotent: what the member's note already became is left as it is, so
 *   a duplicate delivery only adds an opt-in turned on since.
 */
export async function landRecordedNote(
  tx: Tx,
  landing: RecordedNoteLanding,
): Promise<RecordedNoteFollowUp> {
  const row = (
    await tx
      .select({
        kind: interaction.kind,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
        noteId: interaction.noteId,
        meta: interaction.meta,
      })
      .from(interaction)
      .where(eq(interaction.id, landing.interactionId))
      .for('update')
  ).at(0)
  if (row === undefined)
    throw new Error(`interaction ${landing.interactionId} vanished`)
  await keepWebUrl(tx, landing, row.meta)

  const settings = await settingsOf(tx, landing.connectionId)
  const held = await landedOf(tx, landing, landing.interactionId)
  const { note: input } = landing
  const wantsShared = held.shared === null && input.summary !== null
  const wantsTyped =
    settings.typedNotes && input.typedNotes !== null && held.typed === null
  if (!wantsShared && !wantsTyped)
    return {
      tasks: null,
      transcript:
        settings.transcript && held.transcript === null
          ? input.transcript
          : null,
    }

  const provider = await providerName(tx, landing.integrationId)
  const member =
    (
      await tx
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, landing.authorId))
    ).at(0)?.name ?? 'a member'
  const records = await filingRecordIds(tx, landing.interactionId)

  let tasks: RecordedNoteTasks | null = null
  if (wantsShared && input.summary !== null) {
    const writeUp = row.noteId === null
    const noteId = await insertRecordedNote(
      tx,
      landing,
      {
        title: writeUp
          ? writeUpTitle(row.kind, row.subject ?? input.title, row.occurredAt)
          : `${provider} notes · ${member}`,
        markdown: input.summary,
        visibility: 'shared',
      },
      records,
    )
    if (writeUp)
      await tx
        .update(interaction)
        .set({ noteId })
        .where(eq(interaction.id, landing.interactionId))
    else
      await tx.insert(interactionNote).values({
        interactionId: landing.interactionId,
        noteId,
        role: 'recorder_note',
      })
    tasks = {
      interactionId: landing.interactionId,
      noteId,
      integrationId: landing.integrationId,
      receiptId: landing.receiptId,
    }
  }
  if (wantsTyped && input.typedNotes !== null) {
    const noteId = await insertRecordedNote(
      tx,
      landing,
      {
        title: `Typed notes · ${provider}`,
        markdown: input.typedNotes,
        visibility: 'private',
      },
      records,
    )
    await tx.insert(interactionNote).values({
      interactionId: landing.interactionId,
      noteId,
      role: 'typed_notes',
    })
  }
  return {
    tasks,
    transcript:
      settings.transcript && held.transcript === null ? input.transcript : null,
  }
}

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
  /** What the landing hands back for after the commit; null when nothing was held. */
  followUp: RecordedNoteFollowUp | null
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
      const followUp =
        held.receiptId === null
          ? null
          : await landRecordedNote(tx, {
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
        followUp,
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
    const followUp = await landRecordedNote(tx, {
      ...owner,
      outcome: written.outcome,
      interactionId: written.interactionId,
      receiptId: receipt.id,
      key,
      note: input,
    })
    return { ...written, followUp }
  })
}

/** The transcript's bytes as stored: a head naming whose it is, then the text. */
const transcriptText = (
  title: string | null,
  member: string,
  transcript: string,
): string =>
  `${title?.trim() || 'Meeting'} — transcript, ${member}\n\n${transcript}\n`

/** Filing the opted-in transcript failed; the next delivery tries again. */
export class RecordedTranscriptFailed extends Schema.TaggedError<RecordedTranscriptFailed>()(
  'RecordedTranscriptFailed',
  { cause: Schema.Defect() },
) {}

/**
 * The opted-in transcript, filed after the note's write commits: a text
 * document private to the member, on the meeting's records and on
 * `interaction_document` as `transcript`, extracted and chunked like any
 * document under the sensitivity gate.
 * - Its head names the member, so two members' transcripts of one meeting
 *   are two blobs and never dedupe onto one private row.
 * - Run again on a delivery that finds none held: a filing cut short here
 *   is finished by the next sync.
 */
export const fileRecordedTranscriptProgram = Effect.fn(
  'fileRecordedTranscript',
)(function* (
  owner: RecordedNoteOwner,
  interactionId: string,
  transcript: string,
): Effect.fn.Return<
  string,
  RecordedTranscriptFailed | DocumentTooLarge | DocumentBirthRejected,
  Enqueue
> {
  const query = <T>(run: () => Promise<T>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new RecordedTranscriptFailed({ cause }),
    })
  const facts = yield* query(async () => {
    const row = (
      await db
        .select({ subject: interaction.subject })
        .from(interaction)
        .where(eq(interaction.id, interactionId))
    ).at(0)
    const member = (
      await db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, owner.authorId))
    ).at(0)
    const records = await db.transaction((tx) =>
      filingRecordIds(tx, interactionId),
    )
    return {
      subject: row?.subject ?? null,
      member: member?.name ?? 'a member',
      records,
    }
  })
  const bytes = Buffer.from(
    transcriptText(facts.subject, facts.member, transcript),
    'utf8',
  )
  const put = yield* putBlobProgram({
    stream: Readable.from([bytes]),
    mime: 'text/plain',
    preparedBy: owner.authorId,
  }).pipe(
    Effect.catchTag('DocumentIntakeFailed', (failure) =>
      Effect.fail(new RecordedTranscriptFailed({ cause: failure })),
    ),
  )
  const born = yield* birthDocumentProgram({
    blobSha: put.sha,
    filename: `Transcript · ${facts.subject?.trim() || 'Meeting'}.txt`,
    mime: 'text/plain',
    sizeBytes: put.sizeBytes,
    kind: 'other',
    sourceClass: 'integration',
    sourceRef: owner.integrationId,
    provenance: { connectionId: owner.connectionId },
    fileAgainst: facts.records.map((entityId): DocumentFilingTarget => ({
      kind: 'record',
      entityId,
    })),
    actor: { integrationId: owner.integrationId },
    privacy: { visibility: 'private', authorId: owner.authorId },
  }).pipe(
    Effect.catchTag('DocumentBirthFailed', (failure) =>
      Effect.fail(new RecordedTranscriptFailed({ cause: failure })),
    ),
  )
  yield* query(() =>
    db
      .insert(interactionDocument)
      .values({ interactionId, documentId: born.id, role: 'transcript' })
      .onConflictDoNothing(),
  )
  return born.id
})

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
