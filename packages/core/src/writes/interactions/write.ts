import { Schema } from 'effect'
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { normalizeEmail } from '@spaces/sdk/identity'
import {
  document,
  entity,
  entityAlias,
  interaction,
  interactionDocument,
  interactionEntity,
  note,
} from '@spaces/db/schema'
import type { NoteBody } from '@spaces/db/schema/kinds'
import type {
  InteractionKind,
  InteractionMeta,
  MeetingMeta,
} from '@spaces/db/schema/interactions'
import type { DomainEvent } from '@spaces/sdk'
import { readInteractionMeta } from '../../json'
import { birthLinkDocument } from '../documents/birth'
import type { Tx } from '../entities/resolve'
import { interactionParticipants, recomputeInteractionStats } from './stats'

/**
 * The integration interaction lane: one interaction, its body note and its
 * edges, written inside the caller's transaction. Callers: the forwarding
 * mailbox and `Content.logInteraction`. The manual "Log interaction" dialog
 * is not one: it is `manual`, carries no `message_id` and births its
 * write-up through the note door.
 *
 * **The dedupe is the index.** With a `messageId`, the insert is `on conflict
 * (message_id) do nothing` against `interaction_message_id_unique`, and an
 * empty `returning` is the duplicate — nothing checks first, because a
 * pre-check would race a concurrent writer and the index cannot. A
 * duplicate writes nothing else: no body note, no edges. Without a
 * `messageId` there is no key to collide on (NULLs are distinct in a unique
 * index), so every call is a new row.
 *
 * **The interaction first, then its body, then its edges**, so a duplicate
 * leaves no orphan note and a failed edge insert (the caller's transaction
 * rolls back) leaves no bodyless interaction the next attempt would skip as
 * a duplicate. `edges` may be a function of the transaction, which is how
 * the mailbox matches participants and inherits thread edges after the row
 * exists.
 *
 * **The body is a note**, claimed by `interaction.note_id` and filed against
 * nothing: it reaches a record through the interaction's edges on the
 * timeline. Its visibility is the caller's to decide — a forwarded body is
 * `shared`, a synced or plugin-written one `private` — never the writer's.
 *
 * **The stats follow in the same transaction.** Every entity edged is handed
 * to `recomputeInteractionStats` before the writer returns, and
 * `updateInteraction` does the same for a change in place — a cancellation
 * included — so `interaction_stat` cannot disagree with a committed row.
 *
 * **Every write hands back its `interaction.logged` events**: one per company
 * or person newly edged to a meeting or a call. The caller dispatches them
 * once its transaction commits; the meeting auto-enrich scope reads them.
 */

/** A long body is kept whole in `body_md` up to here, not truncated at 1 MB by accident. */
export const MAX_BODY_CHARS = 200_000

/** Plain text → BlockNote paragraphs, one per line, so the editor opens it. */
export function bodyBlocks(text: string): NoteBody {
  return text.split('\n').map((line) =>
    line.trim() === ''
      ? { type: 'paragraph', content: [] }
      : {
          type: 'paragraph',
          content: [
            { type: 'text', text: line.replace(/\s+$/, ''), styles: {} },
          ],
        },
  )
}

export type BodyVisibility = 'shared' | 'private'

/** The interaction's write-up, as plain text, and who it is born to. */
export type InteractionBody = {
  /** The note's title — the subject, or '' when there is none. */
  title: string
  /** Plain text; capped at `MAX_BODY_CHARS`. */
  text: string
  /** The workspace user the note is authored by (`note.author_id`). */
  authorId: string
  visibility: BodyVisibility
}

/**
 * The birth of a body note, inside the caller's transaction: the `note`
 * entity (source `integration`, ref the writing row) and its `note` row,
 * filed against nothing. Visibility is the caller's.
 */
export async function insertBodyNote(
  tx: Tx,
  integrationId: string,
  body: InteractionBody,
): Promise<string> {
  const text = body.text.slice(0, MAX_BODY_CHARS)
  const noteEntity = (
    await tx
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: body.title || 'Untitled',
        createdBy: body.authorId,
        sourceClass: 'integration',
        sourceRef: integrationId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!noteEntity) throw new Error('note entity insert returned no row')
  await tx.insert(note).values({
    entityId: noteEntity.id,
    authorId: body.authorId,
    title: body.title,
    kind: 'note',
    bodyJson: bodyBlocks(text),
    bodyMd: text,
    visibility: body.visibility,
  })
  return noteEntity.id
}

/** Inserts the edges; answers the ones that were new, in the order given. */
async function insertEdges(
  tx: Tx,
  interactionId: string,
  entityIds: ReadonlyArray<string>,
): Promise<Array<string>> {
  const added: Array<string> = []
  for (const entityId of new Set(entityIds)) {
    const inserted = await tx
      .insert(interactionEntity)
      .values({ interactionId, entityId })
      .onConflictDoNothing()
      .returning({ entityId: interactionEntity.entityId })
    if (inserted.length > 0) added.push(entityId)
  }
  return added
}

/**
 * `interaction.logged` for each live company or person among `entityIds`,
 * when the row is a meeting or a call; nothing for any other kind.
 */
async function loggedEvents(
  tx: Tx,
  interactionId: string,
  kind: InteractionKind,
  entityIds: ReadonlyArray<string>,
  at: Date = new Date(),
): Promise<Array<DomainEvent>> {
  if ((kind !== 'meeting' && kind !== 'call') || entityIds.length === 0)
    return []
  const rows = await tx
    .select({ id: entity.id, kind: entity.kind })
    .from(entity)
    .where(and(inArray(entity.id, [...entityIds]), isNull(entity.mergedIntoId)))
  const kinds = new Map(rows.map((r) => [r.id, r.kind]))
  return entityIds.flatMap((entityId): Array<DomainEvent> => {
    const of = kinds.get(entityId)
    return of === 'company' || of === 'person'
      ? [
          {
            name: 'interaction.logged',
            entityId,
            kind: of,
            occurredAt: at.toISOString(),
            interactionId,
            interactionKind: kind,
          },
        ]
      : []
  })
}

/**
 * The edges minus every person reached only through a Bcc: a blind copy is
 * never edged and never counted in the stats, so it stays hidden.
 * - A person also named in From, To or Cc keeps the edge.
 */
async function withoutBlindCopies(
  tx: Tx,
  meta: InteractionMeta | null,
  entityIds: ReadonlyArray<string>,
): Promise<Array<string>> {
  const ids = [...new Set(entityIds)]
  if (meta?.kind !== 'email' || !meta.bcc?.length || ids.length === 0)
    return ids
  const keys = (emails: ReadonlyArray<string>) =>
    emails.map((e) => normalizeEmail(e)).filter((e) => e !== null)
  const visible = keys([meta.from, ...meta.to, ...meta.cc])
  const blind = keys(meta.bcc).filter((k) => !visible.includes(k))
  if (blind.length === 0) return ids
  const owners = await tx
    .select({ entityId: entityAlias.entityId, key: entityAlias.valueNorm })
    .from(entityAlias)
    .where(
      and(
        eq(entityAlias.kind, 'email'),
        inArray(entityAlias.valueNorm, [...blind, ...visible]),
      ),
    )
  const seen = new Set(
    owners.filter((o) => visible.includes(o.key)).map((o) => o.entityId),
  )
  const hidden = new Set(
    owners
      .filter((o) => blind.includes(o.key) && !seen.has(o.entityId))
      .map((o) => o.entityId),
  )
  return ids.filter((id) => !hidden.has(id))
}

export type IntegrationInteraction = {
  /** The integration row that wrote it — `source_ref` on every row. */
  integrationId: string
  kind: 'email' | 'meeting' | 'call'
  /** The dedupe key; null is a new row every time. */
  messageId: string | null
  threadId: string | null
  subject: string | null
  occurredAt: Date
  /** Per-kind metadata; its `kind` must be this row's. Omitted writes null. */
  meta?: InteractionMeta
  /** Null writes no note and leaves `note_id` null. */
  body: InteractionBody | null
  /** The entities to edge — given, or derived inside the transaction once the row exists. */
  edges: ReadonlyArray<string> | ((tx: Tx) => Promise<ReadonlyArray<string>>)
}

export type WrittenInteraction =
  | {
      kind: 'written'
      interactionId: string
      noteId: string | null
      /** Every entity edged, deduplicated, in the order given. */
      edges: Array<string>
      /** To dispatch once the transaction commits. */
      events: Array<DomainEvent>
    }
  | { kind: 'duplicate' }

export async function writeIntegrationInteraction(
  tx: Tx,
  input: IntegrationInteraction,
): Promise<WrittenInteraction> {
  const meta = readInteractionMeta(input.kind, input.meta ?? null)
  if (!meta.ok) throw new Error(`interaction meta refused — ${meta.reason}`)
  const insert = tx.insert(interaction).values({
    kind: input.kind,
    sourceClass: 'integration',
    sourceRef: input.integrationId,
    messageId: input.messageId,
    threadId: input.threadId,
    subject: input.subject,
    meta: meta.meta,
    occurredAt: input.occurredAt,
  })
  const row = (
    input.messageId === null
      ? await insert.returning({ id: interaction.id })
      : await insert
          .onConflictDoNothing({ target: interaction.messageId })
          .returning({ id: interaction.id })
  ).at(0)
  if (!row) {
    if (input.messageId === null)
      throw new Error('interaction insert returned no row')
    return { kind: 'duplicate' }
  }

  let noteId: string | null = null
  if (input.body !== null) {
    noteId = await insertBodyNote(tx, input.integrationId, input.body)
    await tx
      .update(interaction)
      .set({ noteId })
      .where(eq(interaction.id, row.id))
  }

  const given =
    typeof input.edges === 'function' ? await input.edges(tx) : input.edges
  const edges = await withoutBlindCopies(tx, meta.meta, given)
  await insertEdges(tx, row.id, edges)
  await recomputeInteractionStats(tx, edges)
  const events = await loggedEvents(tx, row.id, input.kind, edges)
  return { kind: 'written', interactionId: row.id, noteId, edges, events }
}

/** What a sync may change on an interaction it wrote earlier. */
export type InteractionChange = {
  subject?: string | null
  occurredAt?: Date
  /** Replaces the whole `meta`; its `kind` must be the row's. */
  meta?: InteractionMeta
  /** Edges to add and to drop — an attendee who joined or left. */
  edges?: {
    add: ReadonlyArray<string>
    remove: ReadonlyArray<string>
  }
}

/**
 * An interaction changed in place — a meeting moved, renamed or cancelled
 * (a cancelled meeting is marked, never deleted). Its participants'
 * stats, and those of every entity it lost, are rebuilt in the same
 * transaction. Answers the `interaction.logged` events for the edges it
 * added, or null when no such row.
 */
export async function updateInteraction(
  tx: Tx,
  interactionId: string,
  change: InteractionChange,
): Promise<Array<DomainEvent> | null> {
  const current = (
    await tx
      .select({ kind: interaction.kind })
      .from(interaction)
      .where(eq(interaction.id, interactionId))
  ).at(0)
  if (!current) return null
  let meta: InteractionMeta | null | undefined
  if (change.meta !== undefined) {
    const read = readInteractionMeta(current.kind, change.meta)
    if (!read.ok) throw new Error(`interaction meta refused — ${read.reason}`)
    meta = read.meta
  }
  await tx
    .update(interaction)
    .set({
      ...(change.subject === undefined ? {} : { subject: change.subject }),
      ...(change.occurredAt === undefined
        ? {}
        : { occurredAt: change.occurredAt }),
      ...(meta === undefined ? {} : { meta }),
    })
    .where(eq(interaction.id, interactionId))
  const remove = [...new Set(change.edges?.remove ?? [])]
  if (remove.length > 0)
    await tx
      .delete(interactionEntity)
      .where(
        and(
          eq(interactionEntity.interactionId, interactionId),
          inArray(interactionEntity.entityId, remove),
        ),
      )
  const added = await insertEdges(tx, interactionId, change.edges?.add ?? [])
  await recomputeInteractionStats(tx, [
    ...(await interactionParticipants(tx, interactionId)),
    ...remove,
  ])
  return loggedEvents(tx, interactionId, current.kind, added)
}

/**
 * A recorder's payload: attach it to the calendar meeting, or birth a `call`.
 * One meeting, one row.
 * - The match, in order: the meeting `icalUid` keys (or one instance of its
 *   series, `<uid>#<start>`, inside the window), the one whose
 *   `calendar_event_id` is given, else one starting within `MATCH_WINDOW_MS`
 *   of `occurredAt` whose attendees include **every** payload email. A
 *   looser match would hang a transcript on the wrong call, which is worse
 *   than a duplicate.
 * - An attach unions the participants, adds the artifacts and appends the
 *   payload to `meta.recorder_events`; no row is born.
 * - No match births a `call` keyed by the provider event id, so a payload
 *   delivered twice is one row through `interaction_message_id_unique`.
 * - Serialized per (integration, provider event) by an advisory lock, so a
 *   replay racing the first delivery reads it rather than doubling it.
 * - Writes no note: what a recorder's notes become is the caller's.
 */

/** How far from `occurredAt` a meeting may start and still be the one recorded. */
export const MATCH_WINDOW_MS = 30 * 60 * 1000

/** One artifact as the writer takes it; documents are checked inside. */
export type RecordedArtifact =
  | { role: 'recording_link'; url: string; title: string }
  | { role: 'transcript' | 'attachment'; documentId: string }

export type RecordedInteraction = {
  integrationId: string
  providerEventId: string
  icalUid: string | null
  calendarEventId: string | null
  occurredAt: Date
  subject: string | null
  durationSeconds: number | null
  /** The participants' emails, lowercased: the fallback's test. */
  emails: ReadonlyArray<string>
  /** The receipt the payload was stored in before this ran. */
  receiptId: string
  /** The entities the participants resolved to, plus any given by id. */
  edges: ReadonlyArray<string>
  artifacts: ReadonlyArray<RecordedArtifact>
}

export type RecordedOutcome = {
  /** `duplicate`: this payload was already applied; nothing was added. */
  outcome: 'attached' | 'born' | 'duplicate'
  interactionId: string
  /** To dispatch once the transaction commits. */
  events: Array<DomainEvent>
}

/** An artifact names a document that is missing or another integration's. */
export class ArtifactNotOwned extends Schema.TaggedError<ArtifactNotOwned>()(
  'ArtifactNotOwned',
  { documentId: Schema.String, message: Schema.String },
) {}

/** The row's line where an extract would say what the text is. */
const RECORDING_NOTE = 'a recording — kept at the provider, never copied'

type HeldMeeting = { id: string; meta: MeetingMeta }

const asMeeting = (row: {
  id: string
  meta: InteractionMeta | null
}): HeldMeeting | null =>
  row.meta?.kind === 'meeting' ? { id: row.id, meta: row.meta } : null

/** The meeting a recorder's payload belongs to, or null. */
async function recordedMeeting(
  tx: Tx,
  r: RecordedInteraction,
): Promise<HeldMeeting | null> {
  const at = r.occurredAt.getTime()
  const inWindow = and(
    eq(interaction.kind, 'meeting'),
    gte(interaction.occurredAt, new Date(at - MATCH_WINDOW_MS)),
    lte(interaction.occurredAt, new Date(at + MATCH_WINDOW_MS)),
  )
  const nearest = sql`abs(extract(epoch from ${interaction.occurredAt} - ${r.occurredAt.toISOString()}::timestamptz))`
  const meetings = () =>
    tx
      .select({
        id: interaction.id,
        meta: interaction.meta,
        occurredAt: interaction.occurredAt,
      })
      .from(interaction)

  if (r.icalUid !== null) {
    const exact = (
      await meetings().where(
        and(
          eq(interaction.kind, 'meeting'),
          eq(interaction.messageId, r.icalUid),
        ),
      )
    ).at(0)
    const instance =
      exact ??
      (
        await meetings()
          .where(
            and(
              inWindow,
              sql`starts_with(${interaction.messageId}, ${`${r.icalUid}#`})`,
            ),
          )
          .orderBy(nearest)
          .limit(1)
      ).at(0)
    const held = instance === undefined ? null : asMeeting(instance)
    if (held !== null) return held
  }

  if (r.calendarEventId !== null) {
    const byEvent = (
      await meetings()
        .where(
          and(
            eq(interaction.kind, 'meeting'),
            sql`${interaction.meta} ->> 'calendar_event_id' = ${r.calendarEventId}`,
          ),
        )
        .limit(1)
    ).at(0)
    const held = byEvent === undefined ? null : asMeeting(byEvent)
    if (held !== null) return held
  }

  // The fallback: every payload email among the meeting's attendees.
  if (r.emails.length === 0) return null
  const candidates = await meetings().where(inWindow).orderBy(nearest)
  for (const row of candidates) {
    const held = asMeeting(row)
    if (held === null || held.meta.status === 'cancelled') continue
    const attendees = new Set(Object.keys(held.meta.rsvp))
    if (held.meta.organizer !== null) attendees.add(held.meta.organizer)
    if (r.emails.every((email) => attendees.has(email))) return held
  }
  return null
}

/** The records an artifact files against: the row's live company, person and deal edges. */
async function filingRecords(
  tx: Tx,
  interactionId: string,
): Promise<Array<{ kind: 'record'; entityId: string }>> {
  const ids = await interactionParticipants(tx, interactionId)
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: entity.id, kind: entity.kind })
    .from(entity)
    .where(and(inArray(entity.id, ids), isNull(entity.mergedIntoId)))
  return rows.flatMap((row) =>
    row.kind === 'company' || row.kind === 'person' || row.kind === 'deal'
      ? [{ kind: 'record', entityId: row.id }]
      : [],
  )
}

/**
 * The artifacts on `interaction_document`, each with its role.
 * - A recording is a document with no blob whose `external_url` is the
 *   provider's — never copied. The same link on the row twice is one.
 * - A transcript or attachment must be a document this integration filed.
 */
async function attachArtifacts(
  tx: Tx,
  interactionId: string,
  integrationId: string,
  artifacts: ReadonlyArray<RecordedArtifact>,
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.role === 'recording_link') {
      const held = await tx
        .select({ id: document.entityId })
        .from(interactionDocument)
        .innerJoin(
          document,
          eq(document.entityId, interactionDocument.documentId),
        )
        .where(
          and(
            eq(interactionDocument.interactionId, interactionId),
            eq(interactionDocument.role, 'recording_link'),
            eq(document.externalUrl, artifact.url),
          ),
        )
        .limit(1)
      if (held.length > 0) continue
      const documentId = await birthLinkDocument(tx, {
        filename: artifact.title,
        externalUrl: artifact.url,
        sourceRef: integrationId,
        fileAgainst: await filingRecords(tx, interactionId),
        reason: RECORDING_NOTE,
      })
      await tx
        .insert(interactionDocument)
        .values({ interactionId, documentId, role: 'recording_link' })
      continue
    }
    const filed = (
      await tx
        .select({ sourceRef: document.sourceRef })
        .from(document)
        .where(eq(document.entityId, artifact.documentId))
    ).at(0)
    if (filed?.sourceRef !== integrationId)
      throw new ArtifactNotOwned({
        documentId: artifact.documentId,
        message:
          filed === undefined
            ? `no document ${artifact.documentId}`
            : `document ${artifact.documentId} was filed by another integration`,
      })
    await tx
      .insert(interactionDocument)
      .values({
        interactionId,
        documentId: artifact.documentId,
        role: artifact.role,
      })
      .onConflictDoNothing()
  }
}

export async function writeRecordedInteraction(
  tx: Tx,
  r: RecordedInteraction,
): Promise<RecordedOutcome> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`recorder ${r.integrationId} ${r.providerEventId}`}, 0))`,
  )
  // Born as a call by an earlier delivery: the same payload again.
  const asCall = (
    await tx
      .select({ id: interaction.id })
      .from(interaction)
      .where(eq(interaction.messageId, r.providerEventId))
  ).at(0)
  if (asCall !== undefined)
    return { outcome: 'duplicate', interactionId: asCall.id, events: [] }

  const meeting = await recordedMeeting(tx, r)
  if (meeting !== null) {
    const locked = (
      await tx
        .select({ id: interaction.id, meta: interaction.meta })
        .from(interaction)
        .where(eq(interaction.id, meeting.id))
        .for('update')
    ).at(0)
    const held = locked === undefined ? null : asMeeting(locked)
    if (held === null) throw new Error(`meeting ${meeting.id} vanished`)
    const recorded = held.meta.recorder_events ?? []
    const repeat = recorded.some(
      (e) => e.provider_event_id === r.providerEventId,
    )
    const added = await insertEdges(tx, held.id, r.edges)
    if (!repeat) {
      await attachArtifacts(tx, held.id, r.integrationId, r.artifacts)
      const meta: MeetingMeta = {
        ...held.meta,
        recorder_events: [
          ...recorded,
          { provider_event_id: r.providerEventId, receipt_id: r.receiptId },
        ],
      }
      await tx
        .update(interaction)
        .set({ meta })
        .where(eq(interaction.id, held.id))
    }
    await recomputeInteractionStats(tx, added)
    return {
      outcome: repeat ? 'duplicate' : 'attached',
      interactionId: held.id,
      events: await loggedEvents(tx, held.id, 'meeting', added),
    }
  }

  const written = await writeIntegrationInteraction(tx, {
    integrationId: r.integrationId,
    kind: 'call',
    messageId: r.providerEventId,
    threadId: null,
    subject: r.subject,
    occurredAt: r.occurredAt,
    meta: {
      kind: 'call',
      provider_event_id: r.providerEventId,
      duration_seconds: r.durationSeconds,
      receipt_id: r.receiptId,
    },
    body: null,
    edges: r.edges,
  })
  // Held by the lock and checked above; a conflict here is a bug.
  if (written.kind === 'duplicate')
    throw new Error(`${r.providerEventId} conflicted under its lock`)
  await attachArtifacts(tx, written.interactionId, r.integrationId, r.artifacts)
  return {
    outcome: 'born',
    interactionId: written.interactionId,
    events: written.events,
  }
}
