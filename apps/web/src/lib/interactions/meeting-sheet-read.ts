import { Effect } from 'effect'
import { and, desc, eq, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  entityAlias,
  interaction,
  interactionEntity,
  interactionNote,
  link,
  note,
} from '@spaces/db/schema'
import { user as member } from '@spaces/db/schema/auth'
import type { MeetingMeta } from '@spaces/db/schema/interactions'
import { canRead } from '@spaces/core/read-policy'
import { emailListing } from '@spaces/core/interactions/email-listing'
import { noteWidenedSql } from '@spaces/core/writes/read/can-read-sql'
import { normalizeEmail } from '@spaces/sdk/identity'
import { MeetingReadFailed, meetingDetailProgram } from './meeting-read'
import type { MeetingDetail, MeetingNotFound } from './meeting-read'
import { noteExcerpt } from '#/lib/notes/excerpt'
import { latestThreads } from '#/lib/timeline/threads'
import { viewerSelf } from '#/lib/timeline/record'
import type { MeetingRecord } from '#/lib/meetings/day'
import type {
  MeetingSheetExtras,
  RecentRow,
  SheetPerson,
} from '#/lib/meetings/sheet'

/**
 * The meeting sheet's read: the window's read (`meetingDetailProgram`) and
 * what the sheet adds over it. Whether it is the first meeting with its
 * company and who in it is new are both decided by what is stored from
 * before the meeting's start, never by what came after.
 */

export type MeetingSheetData = { meeting: MeetingDetail } & MeetingSheetExtras

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new MeetingReadFailed({ cause }),
  })

/** How many rows `Recent` shows. */
export const RECENT_ROWS = 3

/** How far back `Recent` reads before it picks: enough to fold a thread. */
const RECENT_READ = 20

const cancelledSql = sql`coalesce(${interaction.meta} ->> 'status', '') = 'cancelled'`

/** Every member's address and every connected account's, lowercased. */
const internalAddresses = () =>
  Effect.gen(function* () {
    const [members, accounts] = yield* Effect.all([
      query(() => db.select({ email: member.email }).from(member)),
      query(() =>
        db
          .select({ email: accountConnection.externalEmail })
          .from(accountConnection),
      ),
    ])
    return new Set([...members, ...accounts].map((m) => m.email.toLowerCase()))
  })

/**
 * Whether an earlier meeting or call, not cancelled, is edged to `companyId`.
 * The meeting itself and anything at or after its start do not count.
 */
const metBefore = (companyId: string, meetingId: string, startsAt: Date) =>
  query(() =>
    db
      .select({ id: interaction.id })
      .from(interactionEntity)
      .innerJoin(
        interaction,
        eq(interaction.id, interactionEntity.interactionId),
      )
      .where(
        and(
          eq(interactionEntity.entityId, companyId),
          inArray(interaction.kind, ['meeting', 'call']),
          ne(interaction.id, meetingId),
          lt(interaction.occurredAt, startsAt),
          sql`not (${cancelledSql})`,
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0))

/** The person records holding each address, with their title and companies. */
const peopleByAddress = (emails: ReadonlyArray<string>) =>
  emails.length === 0
    ? Effect.succeed(
        new Map<
          string,
          {
            id: string
            name: string
            title: string | null
            companies: Array<{ id: string; name: string }>
          }
        >(),
      )
    : Effect.gen(function* () {
        const rows = yield* query(() =>
          db
            .select({
              email: entityAlias.valueNorm,
              id: entity.id,
              name: entity.canonicalName,
              title: sql<
                string | null
              >`nullif(trim(${entity.values} ->> 'job_title'), '')`,
            })
            .from(entityAlias)
            .innerJoin(entity, eq(entity.id, entityAlias.entityId))
            .where(
              and(
                eq(entityAlias.kind, 'email'),
                inArray(entityAlias.valueNorm, [...emails]),
                eq(entity.kind, 'person'),
                isNull(entity.mergedIntoId),
              ),
            ),
        )
        const ids = [...new Set(rows.map((r) => r.id))]
        const companies =
          ids.length === 0
            ? []
            : yield* query(() =>
                db
                  .select({
                    personId: link.fromEntityId,
                    id: entity.id,
                    name: entity.canonicalName,
                  })
                  .from(link)
                  .innerJoin(entity, eq(entity.id, link.toEntityId))
                  .where(
                    and(
                      inArray(link.fromEntityId, ids),
                      eq(link.relation, 'references'),
                      eq(link.attrSlug, 'companies'),
                      isNull(entity.mergedIntoId),
                    ),
                  )
                  .orderBy(entity.canonicalName),
              )
        const out = new Map<
          string,
          {
            id: string
            name: string
            title: string | null
            companies: Array<{ id: string; name: string }>
          }
        >()
        for (const r of rows)
          out.set(r.email.toLowerCase(), {
            id: r.id,
            name: r.name,
            title: r.title,
            companies: companies
              .filter((c) => c.personId === r.id)
              .map((c) => ({ id: c.id, name: c.name })),
          })
        return out
      })

/**
 * The addresses and person records that appear in anything stored before
 * `startsAt`: an edge to an earlier interaction, or an earlier meeting's
 * invite list. What a meeting's `NEW` is decided against.
 */
const seenBefore = (
  emails: ReadonlyArray<string>,
  personIds: ReadonlyArray<string>,
  meetingId: string,
  startsAt: Date,
) =>
  Effect.gen(function* () {
    const [edged, invited] = yield* Effect.all([
      personIds.length === 0
        ? Effect.succeed([])
        : query(() =>
            db
              .selectDistinct({ id: interactionEntity.entityId })
              .from(interactionEntity)
              .innerJoin(
                interaction,
                eq(interaction.id, interactionEntity.interactionId),
              )
              .where(
                and(
                  inArray(interactionEntity.entityId, [...personIds]),
                  ne(interaction.id, meetingId),
                  lt(interaction.occurredAt, startsAt),
                ),
              ),
          ),
      emails.length === 0
        ? Effect.succeed([])
        : query(() =>
            db.execute<{ email: string }>(sql`
              select distinct lower(k.key) as email
              from interaction i,
                jsonb_object_keys(coalesce(i.meta -> 'rsvp', '{}'::jsonb)) as k(key)
              where i.kind = 'meeting'
                and i.id <> ${meetingId}::uuid
                and i.occurred_at < ${startsAt.toISOString()}::timestamptz
                and lower(k.key) in (${sql.join(
                  emails.map((e) => sql`${e}`),
                  sql`, `,
                )})
            `),
          ).pipe(Effect.map((r) => r.rows)),
    ])
    return {
      people: new Set(edged.map((r) => r.id)),
      addresses: new Set(invited.map((r) => r.email)),
    }
  })

/** `Company · Title`, either alone; the company the meeting is with first. */
function personLine(
  found:
    | { title: string | null; companies: Array<{ id: string; name: string }> }
    | undefined,
  meetingRecords: ReadonlySet<string>,
): string | null {
  if (found === undefined) return null
  const company =
    found.companies.find((c) => meetingRecords.has(c.id)) ??
    found.companies.at(0)
  const parts = [company?.name ?? null, found.title].filter(
    (p): p is string => p !== null,
  )
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * The last interactions and notes on the meeting's records that the reader
 * may read, newest first, a thread folded to its newest message. The meeting
 * itself and anything still ahead are left out; a row whose body or
 * write-up is private to someone else is left out whole.
 */
const recentOf = (
  reader: { id: string },
  meetingId: string,
  recordIds: ReadonlyArray<string>,
) =>
  recordIds.length === 0
    ? Effect.succeed<Array<RecentRow>>([])
    : Effect.gen(function* () {
        const [interactions, notes] = yield* Effect.all([
          query(() =>
            db
              .selectDistinct({
                id: interaction.id,
                kind: interaction.kind,
                subject: interaction.subject,
                occurredAt: interaction.occurredAt,
                noteId: interaction.noteId,
                threadId: interaction.threadId,
                meta: interaction.meta,
              })
              .from(interactionEntity)
              .innerJoin(
                interaction,
                eq(interaction.id, interactionEntity.interactionId),
              )
              .where(
                and(
                  inArray(interactionEntity.entityId, [...recordIds]),
                  ne(interaction.id, meetingId),
                  lte(interaction.occurredAt, sql`now()`),
                ),
              )
              .orderBy(desc(interaction.occurredAt))
              .limit(RECENT_READ),
          ),
          query(() =>
            db
              .selectDistinct({
                id: note.entityId,
                title: note.title,
                bodyMd: note.bodyMd,
                visibility: note.visibility,
                authorId: note.authorId,
                widened: noteWidenedSql(reader.id),
                createdAt: entity.createdAt,
              })
              .from(link)
              .innerJoin(note, eq(note.entityId, link.fromEntityId))
              .innerJoin(entity, eq(entity.id, note.entityId))
              .where(
                and(
                  inArray(link.toEntityId, [...recordIds]),
                  eq(link.relation, 'tagged_in'),
                  isNull(entity.mergedIntoId),
                  // A write-up or a meeting's own notes arrive with their
                  // interaction's row, not as a note of their own.
                  sql`not exists (select 1 from ${interaction} wi where wi.note_id = ${note.entityId})`,
                  sql`not exists (select 1 from ${interactionNote} wn where wn.note_id = ${note.entityId})`,
                ),
              )
              .orderBy(desc(entity.createdAt))
              .limit(RECENT_ROWS),
          ),
        ])
        const noteIds = interactions.flatMap((i) =>
          i.noteId === null ? [] : [i.noteId],
        )
        const bodies =
          noteIds.length === 0
            ? []
            : yield* query(() =>
                db
                  .select({
                    id: note.entityId,
                    bodyMd: sql<string>`left(${note.bodyMd}, 2000)`,
                    visibility: note.visibility,
                    authorId: note.authorId,
                    widened: noteWidenedSql(reader.id),
                  })
                  .from(note)
                  .where(inArray(note.entityId, noteIds)),
              )
        const bodyOf = new Map(bodies.map((b) => [b.id, b]))
        const readable = interactions.filter((i) => {
          if (i.noteId === null) return true
          const body = bodyOf.get(i.noteId)
          return body === undefined || canRead(reader, body)
        })
        const threads = latestThreads(
          readable.map((i) => ({ ...i, at: i.occurredAt.toISOString() })),
          RECENT_ROWS,
        )
        const fromInteractions = threads.map(
          ({ row: i, messages }): RecentRow => {
            const body = i.noteId === null ? undefined : bodyOf.get(i.noteId)
            const listing = emailListing(i.meta, true)
            return {
              id: i.id,
              kind: i.kind,
              subject: i.subject ?? '',
              noteId: i.noteId,
              privateBody: false,
              at: i.at,
              attendees: [],
              sent: false,
              attachments: 0,
              attachmentNames: [],
              summary:
                i.kind === 'email'
                  ? (listing.summary ?? listing.snippet)
                  : body === undefined
                    ? null
                    : noteExcerpt(body.bodyMd),
              messages,
            }
          },
        )
        const fromNotes = notes
          .filter((n) => canRead(reader, n))
          .map((n): RecentRow => ({
            id: n.id,
            kind: 'note',
            subject: n.title || 'Untitled',
            noteId: n.id,
            privateBody: false,
            at: n.createdAt.toISOString(),
            attendees: [],
            sent: false,
            attachments: 0,
            attachmentNames: [],
            summary: noteExcerpt(n.bodyMd),
            messages: 1,
          }))
        return [...fromInteractions, ...fromNotes]
          .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
          .slice(0, RECENT_ROWS)
      })

/** The meeting sheet's whole read, for one reader. */
export const meetingSheetProgram = Effect.fn('meetingSheetProgram')(function* (
  reader: { id: string },
  id: string,
): Effect.fn.Return<MeetingSheetData, MeetingReadFailed | MeetingNotFound> {
  const meeting = yield* meetingDetailProgram(reader, id)
  const row = (yield* query(() =>
    db
      .select({ kind: interaction.kind, meta: interaction.meta })
      .from(interaction)
      .where(eq(interaction.id, id)),
  )).at(0)
  const kind = row?.kind === 'call' ? 'call' : 'meeting'
  const meta: MeetingMeta | null =
    row?.meta?.kind === 'meeting' ? row.meta : null
  const startsAt = new Date(meeting.startsAt)
  const emails = meeting.participants.map((p) => p.email.toLowerCase())

  const [self, internal, found] = yield* Effect.all([
    viewerSelf(reader.id).pipe(
      Effect.mapError((cause) => new MeetingReadFailed({ cause })),
    ),
    internalAddresses(),
    peopleByAddress(emails),
  ])
  const outside = emails.filter((e) => !internal.has(e))
  const seen = yield* seenBefore(
    outside,
    outside.flatMap((e) => {
      const p = found.get(e)
      return p === undefined ? [] : [p.id]
    }),
    id,
    startsAt,
  )

  const company = meeting.records.find((r) => r.kind === 'company') ?? null
  const firstMeeting =
    company === null ? false : !(yield* metBefore(company.id, id, startsAt))

  const onMeeting = new Set(meeting.records.map((r) => r.id))
  const organizer = meta?.organizer?.toLowerCase() ?? null
  const people = meeting.participants.map((p): SheetPerson => {
    const email = p.email.toLowerCase()
    const person = found.get(email)
    const you = self.addresses.has(normalizeEmail(email) ?? email)
    const isNew =
      !internal.has(email) &&
      !seen.addresses.has(email) &&
      (person === undefined || !seen.people.has(person.id))
    return {
      email: p.email,
      name: p.name ?? person?.name ?? p.email,
      rsvp: p.rsvp,
      host: email === organizer,
      new: isNew,
      you,
      line: you ? null : personLine(person, onMeeting),
    }
  })

  const headRecord: MeetingRecord | null =
    company ?? meeting.records.find((r) => r.kind !== 'person') ?? null
  const rows = yield* recentOf(
    reader,
    id,
    meeting.records.map((r) => r.id),
  )
  return {
    meeting,
    kind,
    firstMeeting,
    people,
    recent: { record: headRecord, rows },
  }
})
