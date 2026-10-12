import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import {
  accountConnection,
  document,
  entity,
  entityAlias,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  note,
  objectDef,
  suggestion,
} from '@spaces/db/schema'
import type {
  InteractionMeta,
  MeetingMeta,
} from '@spaces/db/schema/interactions'
import { readNotePayload } from '@spaces/core/ai/note'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { sinceRemoved } from '@spaces/core/plugins/registry'
import { taskPayloadSchema } from '@spaces/core/ai/task'
import { ref } from '@spaces/core/context/ref'
import { canRead } from '@spaces/core/read-policy'
import { recomputeInteractionStats } from '@spaces/core/writes/interactions/stats'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import type {
  ArtifactRole,
  DayMeeting,
  MeetingParticipant,
  MeetingRecord,
} from '#/lib/meetings/day'
import { PAST_LIMIT } from '#/lib/meetings/list'
import type { ListedMeeting, MeetingsList } from '#/lib/meetings/list'

/**
 * The meeting reads behind Today's Meetings section, its Needs-you rows, the
 * Meetings page and the meeting window, plus the one write the window owns: pinning a record.
 * A meeting is an `interaction` of kind `meeting`; nothing here is stored
 * beyond what the calendar sync wrote. (D68)
 */

export class MeetingReadFailed extends Schema.TaggedError<MeetingReadFailed>()(
  'MeetingReadFailed',
  { cause: Schema.Defect() },
) {}

export class MeetingNotFound extends Schema.TaggedError<MeetingNotFound>()(
  'MeetingNotFound',
  { id: Schema.String },
) {}

export class PinRecordNotFound extends Schema.TaggedError<PinRecordNotFound>()(
  'PinRecordNotFound',
  { id: Schema.String },
) {}

/** The sentence a client is shown; a `Schema.TaggedError` carries none. */
export function meetingMessage(failure: unknown): string {
  if (failure instanceof MeetingNotFound)
    return 'That meeting is no longer there'
  if (failure instanceof PinRecordNotFound)
    return 'That record is no longer there'
  return 'Could not read the meeting'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MeetingReadFailed({ cause }),
  })

const meetingMeta = (meta: InteractionMeta | null): MeetingMeta | null =>
  meta?.kind === 'meeting' ? meta : null

/** The end of a meeting: `meta.ends_at`, else its start. */
const endOf = (startsAt: Date, meta: MeetingMeta | null): string =>
  meta?.ends_at ?? startsAt.toISOString()

/** Records edged to each interaction, live ones only, by name. */
const recordsOf = (ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(
        new Map<string, Array<MeetingRecord & { emails: Array<string> }>>(),
      )
    : Effect.gen(function* () {
        const rows = yield* query(() =>
          db
            .select({
              interactionId: interactionEntity.interactionId,
              id: entity.id,
              kind: entity.kind,
              name: entity.canonicalName,
              objectSlug: objectDef.slug,
              emails: sql<Array<string>>`coalesce((
                select array_agg(lower(a.value_norm)) from ${entityAlias} a
                where a.entity_id = ${entity.id} and a.kind = 'email'
              ), '{}'::text[])`,
            })
            .from(interactionEntity)
            .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
            .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
            .where(
              and(
                inArray(interactionEntity.interactionId, [...ids]),
                isNull(entity.mergedIntoId),
              ),
            )
            .orderBy(asc(entity.canonicalName)),
        )
        const out = new Map<
          string,
          Array<MeetingRecord & { emails: Array<string> }>
        >()
        for (const r of rows) {
          const list = out.get(r.interactionId) ?? []
          list.push({
            id: r.id,
            kind: r.kind,
            name: r.name,
            objectSlug: r.objectSlug,
            emails: r.emails,
          })
          out.set(r.interactionId, list)
        }
        return out
      })

/**
 * Participants from `meta.rsvp`, each named by the person record edged to
 * the meeting that holds the address. Organizer first, then by name.
 */
export function participantsOf(
  meta: MeetingMeta | null,
  records: ReadonlyArray<MeetingRecord & { emails: ReadonlyArray<string> }>,
): Array<MeetingParticipant> {
  if (meta === null) return []
  const people = records.filter((r) => r.kind === 'person')
  const out = Object.entries(meta.rsvp).map(([email, rsvp]) => ({
    email,
    name:
      people.find((p) => p.emails.includes(email.toLowerCase()))?.name ?? null,
    rsvp,
  }))
  const organizer = meta.organizer?.toLowerCase() ?? null
  return out.sort(
    (a, b) =>
      Number(b.email.toLowerCase() === organizer) -
        Number(a.email.toLowerCase() === organizer) ||
      (a.name ?? a.email).localeCompare(b.name ?? b.email),
  )
}

const stripEmails = (
  r: MeetingRecord & { emails: ReadonlyArray<string> },
): MeetingRecord => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  objectSlug: r.objectSlug,
})

/** The artifact roles on each interaction. */
const artifactRolesOf = (ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(new Map<string, Array<ArtifactRole>>())
    : Effect.gen(function* () {
        const rows = yield* query(() =>
          db
            .select({
              interactionId: interactionDocument.interactionId,
              role: interactionDocument.role,
            })
            .from(interactionDocument)
            .where(inArray(interactionDocument.interactionId, [...ids])),
        )
        const out = new Map<string, Array<ArtifactRole>>()
        for (const r of rows) {
          const list = out.get(r.interactionId) ?? []
          if (!list.includes(r.role)) list.push(r.role)
          out.set(r.interactionId, list)
        }
        return out
      })

/** The interaction columns every meeting row is built from. */
type MeetingBase = {
  id: string
  subject: string | null
  occurredAt: Date
  meta: InteractionMeta | null
  noteId: string | null
}

/** Rows as `DayMeeting`s: records, participants and artifact roles joined. */
const hydrate = (rows: ReadonlyArray<MeetingBase>) =>
  Effect.gen(function* () {
    const ids = rows.map((r) => r.id)
    const [records, artifacts] = yield* Effect.all([
      recordsOf(ids),
      artifactRolesOf(ids),
    ])
    return rows.map((r): DayMeeting => {
      const meta = meetingMeta(r.meta)
      const linked = records.get(r.id) ?? []
      return {
        id: r.id,
        title: r.subject,
        startsAt: r.occurredAt.toISOString(),
        endsAt: endOf(r.occurredAt, meta),
        cancelled: meta?.status === 'cancelled',
        participants: participantsOf(meta, linked),
        records: linked.map(stripEmails),
        artifacts: artifacts.get(r.id) ?? [],
        noteId: r.noteId,
      }
    })
  })

/**
 * The meetings that start inside `[from, to)`, earliest first. External
 * meetings only, because internal ones are never stored; a cancelled one
 * stays, marked.
 */
export const dayMeetingsProgram = Effect.fn('dayMeetingsProgram')(function* (
  from: Date,
  to: Date,
): Effect.fn.Return<Array<DayMeeting>, MeetingReadFailed> {
  const rows = yield* query(() =>
    db
      .select({
        id: interaction.id,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
        meta: interaction.meta,
        noteId: interaction.noteId,
      })
      .from(interaction)
      .where(
        and(
          eq(interaction.kind, 'meeting'),
          gte(interaction.occurredAt, from),
          lt(interaction.occurredAt, to),
        ),
      )
      .orderBy(asc(interaction.occurredAt), asc(interaction.id)),
  )
  return yield* hydrate(rows)
})

/** Who reads the list: canRead's id, and the address their invites name. */
export type MeetingReader = { id: string; email: string }

/** The write-up's entity, aliased `e` because `canReadNoteSql` reads `e`. */
const writeUp = alias(entity, 'e')

/**
 * The Meetings page's read: what starts in `(now, until)`, earliest first,
 * and what started by `now`, the ones still needing a write-up first, then
 * newest first, cut at `PAST_LIMIT`. (D68 amended)
 * - Every meeting row is visible to every member (D67); canRead decides only
 *   whether the reader may read the write-up, which reads `private`.
 * - `mine` matches the participants against the reader's login address and
 *   every connected account's.
 */
export const meetingListProgram = Effect.fn('meetingListProgram')(function* (
  reader: MeetingReader,
  now: Date,
  until: Date,
): Effect.fn.Return<MeetingsList, MeetingReadFailed> {
  const columns = {
    id: interaction.id,
    subject: interaction.subject,
    occurredAt: interaction.occurredAt,
    meta: interaction.meta,
    noteId: interaction.noteId,
    bodyReadable: sql<boolean>`${canReadNoteSql(reader.id)}`,
    bodySource: writeUp.sourceRef,
  }
  const needsWriteUpSql = sql`(${interaction.noteId} is null and coalesce(${interaction.meta} ->> 'status', '') <> 'cancelled')`
  const [upcoming, past, accounts] = yield* Effect.all([
    query(() =>
      db
        .select(columns)
        .from(interaction)
        .leftJoin(writeUp, eq(writeUp.id, interaction.noteId))
        .where(
          and(
            eq(interaction.kind, 'meeting'),
            gt(interaction.occurredAt, now),
            lt(interaction.occurredAt, until),
          ),
        )
        .orderBy(asc(interaction.occurredAt), asc(interaction.id)),
    ),
    query(() =>
      db
        .select(columns)
        .from(interaction)
        .leftJoin(writeUp, eq(writeUp.id, interaction.noteId))
        .where(
          and(
            eq(interaction.kind, 'meeting'),
            lte(interaction.occurredAt, now),
          ),
        )
        .orderBy(
          desc(needsWriteUpSql),
          desc(interaction.occurredAt),
          desc(interaction.id),
        )
        .limit(PAST_LIMIT + 1),
    ),
    query(() =>
      db
        .select({ email: accountConnection.externalEmail })
        .from(accountConnection)
        .where(eq(accountConnection.userId, reader.id)),
    ),
  ])
  const kept = past.slice(0, PAST_LIMIT)
  const rows = [...upcoming, ...kept]
  const sources = [
    ...new Set(
      rows.flatMap((r) => (r.bodySource === null ? [] : [r.bodySource])),
    ),
  ]
  const [hydrated, names] = yield* Effect.all([
    hydrate(rows),
    sources.length === 0
      ? Effect.succeed([])
      : query(() =>
          db
            .select({
              id: integration.id,
              capabilityId: integration.capabilityId,
              manifest: integration.manifest,
              removedAt: integration.removedAt,
            })
            .from(integration)
            .where(inArray(integration.id, sources)),
        ),
  ])
  const nameOf = new Map(
    names.map((i) => [
      i.id,
      sinceRemoved(
        jsonString(jsonRecord(i.manifest).name) ?? i.capabilityId,
        i.removedAt,
      ),
    ]),
  )
  const mineSet = new Set(
    [reader.email, ...accounts.map((a) => a.email)].map((e) => e.toLowerCase()),
  )
  const listed = rows.map((r, i): ListedMeeting => {
    const meta = meetingMeta(r.meta)
    const own = Object.entries(meta?.rsvp ?? {}).find(([email]) =>
      mineSet.has(email.toLowerCase()),
    )
    const organizer = meta?.organizer?.toLowerCase() ?? null
    return {
      ...hydrated[i],
      mine: own !== undefined || (organizer !== null && mineSet.has(organizer)),
      myRsvp: own?.[1] ?? null,
      writeUp:
        r.noteId === null ? 'none' : r.bodyReadable ? 'written' : 'private',
      via:
        r.noteId !== null && r.bodyReadable && r.bodySource !== null
          ? (nameOf.get(r.bodySource) ?? null)
          : null,
    }
  })
  return {
    upcoming: listed.slice(0, upcoming.length),
    past: listed.slice(upcoming.length),
    more: past.length > PAST_LIMIT,
  }
})

/** How far back Needs you looks for a meeting nobody wrote up. */
export const UNWRITTEN_DAYS = 14

/** A past meeting with no write-up: a Needs-you row with Write. (D79) */
export type UnwrittenMeeting = {
  id: string
  title: string | null
  startsAt: string
  /** The first linked record's name, for the row's mono lane. */
  record: string | null
}

export const unwrittenMeetingsProgram = Effect.fn('unwrittenMeetingsProgram')(
  function* (
    now: Date,
  ): Effect.fn.Return<Array<UnwrittenMeeting>, MeetingReadFailed> {
    const since = new Date(now.getTime() - UNWRITTEN_DAYS * 86_400_000)
    const rows = yield* query(() =>
      db
        .select({
          id: interaction.id,
          subject: interaction.subject,
          occurredAt: interaction.occurredAt,
          meta: interaction.meta,
        })
        .from(interaction)
        .where(
          and(
            eq(interaction.kind, 'meeting'),
            isNull(interaction.noteId),
            gte(interaction.occurredAt, since),
            lt(interaction.occurredAt, now),
          ),
        )
        .orderBy(asc(interaction.occurredAt)),
    )
    const ended = rows.filter((r) => {
      const meta = meetingMeta(r.meta)
      return (
        meta?.status !== 'cancelled' &&
        Date.parse(endOf(r.occurredAt, meta)) <= now.getTime()
      )
    })
    const records = yield* recordsOf(ended.map((r) => r.id))
    return ended.map((r) => {
      const linked = records.get(r.id) ?? []
      const named = linked.find((l) => l.kind !== 'person') ?? linked.at(0)
      return {
        id: r.id,
        title: r.subject,
        startsAt: r.occurredAt.toISOString(),
        record: named?.name ?? null,
      }
    })
  },
)

/** Whether any member has a live Google Calendar connection. (D80) */
export const calendarConnectedProgram = Effect.fn('calendarConnectedProgram')(
  function* (): Effect.fn.Return<boolean, MeetingReadFailed> {
    const rows = yield* query(() =>
      db
        .select({ id: accountConnection.id })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.provider, 'google'),
            eq(accountConnection.product, 'calendar'),
            ne(accountConnection.status, 'revoked'),
          ),
        )
        .limit(1),
    )
    return rows.length > 0
  },
)

/** One artifact in the window, by role. (D68) */
export type MeetingArtifact = {
  documentId: string
  role: ArtifactRole
  name: string
  /** Where a recording link opens: the provider's own page. */
  url: string | null
}

/** An open suggestion that cites this meeting, decided inline. */
export type MeetingSuggestion = {
  id: string
  kind: string
  /** What it proposes, in a line: the task's or the note's title. */
  summary: string
}

export type MeetingDetail = {
  id: string
  title: string | null
  startsAt: string
  endsAt: string
  cancelled: boolean
  conferenceUrl: string | null
  participants: Array<MeetingParticipant>
  records: Array<MeetingRecord>
  /** The write-up; `title` is null when the reader may not see it. */
  note: { id: string; title: string | null } | null
  artifacts: Array<MeetingArtifact>
  suggestions: Array<MeetingSuggestion>
}

const SUGGESTION_WORD: Record<string, string> = {
  attribute_patch: 'Field update',
  note: 'Note',
  task: 'Task',
  space_tag: 'File in a space',
  identity: 'Same record',
}

/** A suggestion's one line, read from its payload. */
export function suggestionSummary(kind: string, payload: unknown): string {
  if (kind === 'task') {
    const task = taskPayloadSchema.safeParse(payload)
    if (task.success) return task.data.title
  }
  if (kind === 'note') {
    const n = readNotePayload(payload)
    if (n) return n.title
  }
  return SUGGESTION_WORD[kind] ?? kind
}

/** The meeting window's whole read. */
export const meetingDetailProgram = Effect.fn('meetingDetailProgram')(
  function* (
    user: { id: string },
    id: string,
  ): Effect.fn.Return<MeetingDetail, MeetingReadFailed | MeetingNotFound> {
    const row = (yield* query(() =>
      db
        .select({
          id: interaction.id,
          subject: interaction.subject,
          occurredAt: interaction.occurredAt,
          meta: interaction.meta,
          noteId: interaction.noteId,
        })
        .from(interaction)
        .where(and(eq(interaction.id, id), eq(interaction.kind, 'meeting'))),
    )).at(0)
    if (!row) return yield* new MeetingNotFound({ id })
    const meta = meetingMeta(row.meta)
    const noteId = row.noteId
    const [records, artifacts, written, open] = yield* Effect.all([
      recordsOf([id]),
      query(() =>
        db
          .select({
            documentId: interactionDocument.documentId,
            role: interactionDocument.role,
            filename: document.filename,
            name: entity.canonicalName,
            url: document.url,
            externalUrl: document.externalUrl,
          })
          .from(interactionDocument)
          .innerJoin(
            document,
            eq(document.entityId, interactionDocument.documentId),
          )
          .innerJoin(entity, eq(entity.id, interactionDocument.documentId))
          .where(eq(interactionDocument.interactionId, id))
          .orderBy(asc(interactionDocument.role), asc(entity.canonicalName)),
      ),
      noteId === null
        ? Effect.succeed([])
        : query(() =>
            db
              .select({
                title: note.title,
                visibility: note.visibility,
                authorId: note.authorId,
              })
              .from(note)
              .where(eq(note.entityId, noteId)),
          ),
      query(() =>
        db
          .select({
            id: suggestion.id,
            kind: suggestion.kind,
            payload: suggestion.payload,
          })
          .from(suggestion)
          .where(
            and(
              eq(suggestion.status, 'open'),
              sql`${suggestion.refs} @> array[${ref.interaction(id)}]::text[]`,
            ),
          )
          .orderBy(asc(suggestion.createdAt)),
      ),
    ])
    const linked = records.get(id) ?? []
    const body = written.at(0)
    return {
      id: row.id,
      title: row.subject,
      startsAt: row.occurredAt.toISOString(),
      endsAt: endOf(row.occurredAt, meta),
      cancelled: meta?.status === 'cancelled',
      conferenceUrl: meta?.conference_url ?? null,
      participants: participantsOf(meta, linked),
      records: linked.map(stripEmails),
      note:
        noteId === null
          ? null
          : {
              id: noteId,
              title:
                body && canRead(user, body) ? body.title || 'Untitled' : null,
            },
      artifacts: artifacts.map((a) => ({
        documentId: a.documentId,
        role: a.role,
        name: a.filename ?? a.name,
        url: a.url ?? a.externalUrl,
      })),
      suggestions: open.map((s) => ({
        id: s.id,
        kind: s.kind,
        summary: suggestionSummary(s.kind, s.payload),
      })),
    }
  },
)

/**
 * Pin a record to a meeting: the one manual `interaction_entity` edge (D49).
 * A link never invites anyone. The record's interaction stats follow in the
 * same transaction.
 */
export const pinMeetingRecordProgram = Effect.fn('pinMeetingRecordProgram')(
  function* (
    interactionId: string,
    entityId: string,
  ): Effect.fn.Return<
    { pinned: boolean },
    MeetingReadFailed | MeetingNotFound | PinRecordNotFound
  > {
    const [meeting, record] = yield* Effect.all([
      query(() =>
        db
          .select({ id: interaction.id })
          .from(interaction)
          .where(
            and(
              eq(interaction.id, interactionId),
              eq(interaction.kind, 'meeting'),
            ),
          ),
      ),
      query(() =>
        db
          .select({ id: entity.id })
          .from(entity)
          .where(and(eq(entity.id, entityId), isNull(entity.mergedIntoId))),
      ),
    ])
    if (meeting.length === 0)
      return yield* new MeetingNotFound({ id: interactionId })
    if (record.length === 0)
      return yield* new PinRecordNotFound({ id: entityId })
    return yield* query(() =>
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(interactionEntity)
          .values({ interactionId, entityId })
          .onConflictDoNothing()
          .returning({ id: interactionEntity.entityId })
        if (inserted.length > 0) await recomputeInteractionStats(tx, [entityId])
        return { pinned: inserted.length > 0 }
      }),
    )
  },
)
