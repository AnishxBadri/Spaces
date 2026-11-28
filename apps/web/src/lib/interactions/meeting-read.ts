import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
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
  interactionNote,
  link,
  note,
  objectDef,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { user as member } from '@spaces/db/schema/auth'
import type {
  InteractionMeta,
  MeetingMeta,
} from '@spaces/db/schema/interactions'
import { readNotePayload } from '@spaces/core/ai/note'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { sinceRemoved } from '@spaces/core/plugins/registry'
import { KEYED_PROVIDER_IDS } from '@spaces/core/providers/keyed'
import { readTaskPayload } from '@spaces/core/ai/task'
import { ref } from '@spaces/core/context/ref'
import { canRead } from '@spaces/core/read-policy'
import { recomputeInteractionStats } from '@spaces/core/writes/interactions/stats'
import { canReadNoteSql } from '@spaces/core/writes/read/search'
import { participantName } from '#/lib/meetings/day'
import type {
  ArtifactRole,
  DayMeeting,
  MeetingParticipant,
  MeetingRecord,
  TodayMeeting,
} from '#/lib/meetings/day'
import {
  MONTH,
  NO_MEETING_FILTERS,
  filtersFor,
  knownTimeZone,
  meetingFiltersOn,
} from '#/lib/meetings/filter'
import type {
  MeetingKind,
  MeetingsFilters,
  WriteUpFilter,
} from '#/lib/meetings/filter'
import { PAST_STEP } from '#/lib/meetings/list'
import type {
  ListedMeeting,
  MeetingsPage,
  MeetingsQuery,
  MonthCount,
  WriteUpState,
} from '#/lib/meetings/list'
import { GRACE_MS, isUnwritten } from '#/lib/meetings/unwritten'
import { noteExcerpt } from '#/lib/notes/excerpt'
import {
  beforeMonthEndSql,
  cancelledSql,
  nothingToNoteSql,
  meetingFilterConditions,
  monthKeySql,
  pastBandKeySql,
  writeUpSql,
} from './meeting-filter-sql'
import type { MeetingsFacet } from './meeting-filter-sql'
import { recorderLinksProgram } from './recorder-links'
import { notesViaProgram } from '../notes/via'
import type { NoteVia } from '../notes/via-mark'
import type { RecorderLink } from './recorder-links'

/**
 * The meeting reads behind Today's Meetings section, its Needs-you rows, the
 * Meetings page and the meeting window, plus the one write the window owns: pinning a record.
 * A meeting is an `interaction` of kind `meeting`; nothing here is stored
 * beyond what the calendar sync wrote.
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

/** A linked record with what the reads need beyond `MeetingRecord`. */
type LinkedRecord = MeetingRecord & {
  emails: Array<string>
  sensitive: boolean
}

/** Records edged to each interaction, live ones only, by name. */
const recordsOf = (ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(new Map<string, Array<LinkedRecord>>())
    : Effect.gen(function* () {
        const rows = yield* query(() =>
          db
            .select({
              interactionId: interactionEntity.interactionId,
              id: entity.id,
              kind: entity.kind,
              name: entity.canonicalName,
              objectSlug: objectDef.slug,
              sensitive: entity.sensitive,
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
        const out = new Map<string, Array<LinkedRecord>>()
        for (const r of rows) {
          const list = out.get(r.interactionId) ?? []
          list.push({
            id: r.id,
            kind: r.kind,
            name: r.name,
            objectSlug: r.objectSlug,
            emails: r.emails,
            sensitive: r.sensitive,
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

const stripEmails = (r: LinkedRecord): MeetingRecord => ({
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
 * The meetings that start inside `[from, to)`, earliest first, each with who
 * outside the workspace it is with. External meetings only, because internal
 * ones are never stored; a cancelled one stays, marked.
 */
export const dayMeetingsProgram = Effect.fn('dayMeetingsProgram')(function* (
  from: Date,
  to: Date,
): Effect.fn.Return<Array<TodayMeeting>, MeetingReadFailed> {
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
  const [meetings, internal] = yield* Effect.all([
    hydrate(rows),
    rows.length === 0 ? Effect.succeed(new Set<string>()) : internalAddresses(),
  ])
  const links = new Map(
    rows.map((r) => [r.id, meetingMeta(r.meta)?.conference_url ?? null]),
  )
  return meetings.map((m): TodayMeeting => ({
    ...m,
    external: m.participants
      .filter((p) => !internal.has(p.email.toLowerCase()))
      .map(participantName),
    callLink: links.get(m.id) ?? null,
  }))
})

/** Who reads the list: canRead's id, and the address their invites name. */
export type MeetingReader = { id: string; email: string }

/** The write-up's entity, aliased `e` because `canReadNoteSql` reads `e`. */
const writeUp = alias(entity, 'e')

/** A list of lowercased addresses as a Postgres `text[]`. */
const addressArray = (emails: ReadonlySet<string>) =>
  emails.size === 0
    ? sql`array[]::text[]`
    : sql`array[${sql.join(
        [...emails].map((e) => sql`${e}`),
        sql`, `,
      )}]::text[]`

/** The meeting's organiser or an invitee is one of `emails`, case-blind. */
const attendedBySql = (emails: ReadonlySet<string>) =>
  emails.size === 0
    ? sql`false`
    : sql`(lower(coalesce(${interaction.meta} ->> 'organizer', '')) = any(${addressArray(emails)}) or exists (select 1 from jsonb_object_keys(case when jsonb_typeof(${interaction.meta} -> 'rsvp') = 'object' then ${interaction.meta} -> 'rsvp' else '{}'::jsonb end) k where lower(k) = any(${addressArray(emails)})))`

/** When a row ended: a meeting's `ends_at`, else (a call) its start. */
const endSql = sql`coalesce(case when ${interaction.meta} ->> 'kind' = 'meeting' then (${interaction.meta} ->> 'ends_at')::timestamptz end, ${interaction.occurredAt})`

/**
 * Past's cursor: whether the last row owed a write-up, its start as
 * Postgres printed it (so no precision is lost on the way back) and its id.
 */
type PastCursor = { unwritten: boolean; at: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PG_INSTANT =
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/

const encodeCursor = (c: PastCursor): string =>
  Buffer.from(`${c.unwritten ? '1' : '0'}|${c.at}|${c.id}`).toString(
    'base64url',
  )

/** The cursor, or null when it is not one this read wrote. */
const decodeCursor = (raw: string): PastCursor | null => {
  const [u, at, id] = Buffer.from(raw, 'base64url').toString().split('|')
  if ((u !== '0' && u !== '1') || !PG_INSTANT.test(at) || !UUID.test(id))
    return null
  return { unwritten: u === '1', at, id }
}

/** Every member by id and every address that is theirs, lowercased. */
const membersProgram = () =>
  Effect.gen(function* () {
    const [members, accounts] = yield* Effect.all([
      query(() =>
        db
          .select({ id: member.id, name: member.name, email: member.email })
          .from(member),
      ),
      query(() =>
        db
          .select({
            userId: accountConnection.userId,
            email: accountConnection.externalEmail,
            provider: accountConnection.provider,
            status: accountConnection.status,
          })
          .from(accountConnection),
      ),
    ])
    const byAddress = new Map<string, { id: string; name: string }>()
    for (const m of members)
      byAddress.set(m.email.toLowerCase(), { id: m.id, name: m.name })
    const nameOf = new Map(members.map((m) => [m.id, m.name]))
    for (const a of accounts)
      byAddress.set(a.email.toLowerCase(), {
        id: a.userId,
        name: nameOf.get(a.userId) ?? a.email,
      })
    const keyed: ReadonlyArray<string> = KEYED_PROVIDER_IDS
    const recording = new Set(
      accounts
        .filter((a) => keyed.includes(a.provider) && a.status !== 'revoked')
        .map((a) => a.userId),
    )
    const addressesOf = (ids: ReadonlySet<string>) =>
      new Set(
        [...byAddress].flatMap(([email, m]) => (ids.has(m.id) ? [email] : [])),
      )
    return { count: members.length, byAddress, addressesOf, recording }
  })

/**
 * One member's meetings as SQL over `interaction`: they organised it or
 * were invited, matched on every address that is theirs (and `login`, the
 * address their session names); a row with no invite list (a logged call or
 * meeting) is theirs when they logged it or wrote it up.
 */
const memberScopeProgram = (
  team: { addressesOf: (ids: ReadonlySet<string>) => Set<string> },
  memberId: string,
  login: string | null,
) =>
  Effect.gen(function* () {
    const addresses = team.addressesOf(new Set([memberId]))
    if (login !== null) addresses.add(login.toLowerCase())
    const logged = yield* query(() =>
      db
        .select({ id: sql<string>`${activity.meta} ->> 'interactionId'` })
        .from(activity)
        .where(
          and(
            eq(activity.actorId, memberId),
            inArray(activity.verb, ['interaction.meeting', 'interaction.call']),
          ),
        ),
    )
    const loggedIds = logged.flatMap((l) => (UUID.test(l.id) ? [l.id] : []))
    const noInvites = sql`coalesce(${interaction.meta} ->> 'kind', '') <> 'meeting'`
    const scopeSql = sql`(${attendedBySql(addresses)} or (${noInvites} and (${
      loggedIds.length === 0
        ? sql`false`
        : sql`${interaction.id} = any(array[${sql.join(
            loggedIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[])`
    } or exists (select 1 from note wn where wn.entity_id = ${interaction.noteId} and wn.author_id = ${memberId}))))`
    return { addresses, loggedIds, scopeSql }
  })

/**
 * What makes a meeting the reader's and whether it owes a write-up, as SQL
 * over `interaction`, so the Meetings page and Today's Write-ups agree.
 * - Mine: `memberScopeProgram` for the reader, their login address
 *   theirs even before a member row says so.
 * - Unwritten mirrors `isUnwritten`, recorder, grace hour and `Nothing to
 *   note` included.
 */
const readerScopeProgram = (reader: MeetingReader, now: Date) =>
  Effect.gen(function* () {
    const team = yield* membersProgram()
    const {
      addresses: mine,
      loggedIds,
      scopeSql: mineSql,
    } = yield* memberScopeProgram(team, reader.id, reader.email)
    const recorders = team.addressesOf(team.recording)
    const graceEnd = new Date(now.getTime() - GRACE_MS)
    const unwrittenSql = sql<boolean>`(${interaction.noteId} is null and not ${cancelledSql} and not ${nothingToNoteSql} and (not ${attendedBySql(recorders)} or ${endSql} <= ${graceEnd}))`
    return { team, mine, recorders, loggedIds, unwrittenSql, mineSql }
  })

/**
 * The parts every Meetings list read shares: the reader's scope, whose
 * meetings the tab holds, each tab's base and the search and filters.
 * - `Member` names one colleague's meetings whatever `Mine · Everyone`
 *   says, so with it on the tab's total is the team's.
 * - `counted` is what each tab holds for whose meetings, before the search
 *   and filters: the tab counts and the foot's `of 241`.
 */
const listScopeProgram = (reader: MeetingReader, params: MeetingsQuery) =>
  Effect.gen(function* () {
    const now = new Date(params.now)
    const scope = yield* readerScopeProgram(reader, now)
    const filters = filtersFor(params.filters ?? NO_MEETING_FILTERS, params.tab)
    const chosen =
      filters.member === null
        ? null
        : yield* memberScopeProgram(scope.team, filters.member, null)
    const whoseSql =
      filters.member === null && params.whose === 'mine'
        ? scope.mineSql
        : sql`true`
    const q = params.q?.trim() ?? ''
    const tz = knownTimeZone(params.tz)
    // Everything ahead: the agenda's two weeks and the `Later` fold after them.
    const aheadSql = sql`(${interaction.kind} = 'meeting' and ${endSql} > ${now})`
    const pastBaseSql = sql`(${interaction.kind} in ('meeting', 'call') and ${endSql} <= ${now})`
    const pastSql = sql`(${pastBaseSql} and not ${cancelledSql})`
    const tabSql = params.tab === 'upcoming' ? aheadSql : pastBaseSql
    const narrowedBy = (except: MeetingsFacet | null) =>
      meetingFilterConditions(
        {
          tab: params.tab,
          filters,
          q,
          readerId: reader.id,
          memberSql: chosen?.scopeSql ?? null,
        },
        except,
      )
    const narrowed = q !== '' || meetingFiltersOn(filters, params.tab) > 0
    return {
      ...scope,
      now,
      tz,
      filters,
      whoseSql,
      aheadSql,
      pastSql,
      tabSql,
      narrowedBy,
      narrowed,
    }
  })

/**
 * The Meetings page's read: one tab of the list for one params object.
 * - Upcoming: the meetings not yet ended, earliest first, cancelled ones
 *   kept and marked; those starting before `until` are the agenda's `rows`,
 *   the rest the `Later` fold's.
 * - Past: the meetings and calls that ended by `now`, cancelled ones left
 *   out; those owing a write-up first, then newest first, a page at a time.
 *   With `month` (`Jump to`) it reads from that month's end down, newest
 *   first alone, so the list opens on that month's band.
 * - `whose: 'mine'` keeps the reader's rows (`readerScopeProgram`); the
 *   counts follow the same choice, and `Member` overrides it.
 * - The search and filters narrow the rows, `shown` and, on Past, the band
 *   counts; the tab counts stay the tab's.
 * - A row owes a write-up by `isUnwritten`; the SQL that sorts and counts
 *   mirrors it, recorder and grace hour included.
 * - Every row is visible to every member; canRead decides only whether
 *   the reader may read the write-up and its summary.
 */
export const meetingListProgram = Effect.fn('meetingListProgram')(function* (
  reader: MeetingReader,
  params: MeetingsQuery,
): Effect.fn.Return<MeetingsPage & { members: number }, MeetingReadFailed> {
  const until = new Date(params.until)
  const {
    team,
    mine,
    recorders,
    loggedIds,
    unwrittenSql,
    now,
    tz,
    filters,
    whoseSql,
    aheadSql,
    pastSql,
    tabSql,
    narrowedBy,
    narrowed,
  } = yield* listScopeProgram(reader, params)
  const month =
    params.tab === 'past' &&
    params.month !== undefined &&
    MONTH.test(params.month)
      ? params.month
      : null
  // After `Jump to` the owing rows sit in their months rather than lead.
  const lead = month === null ? sql`${unwrittenSql}::int` : sql`0::int`

  const columns = {
    id: interaction.id,
    kind: interaction.kind,
    subject: interaction.subject,
    occurredAt: interaction.occurredAt,
    meta: interaction.meta,
    noteId: interaction.noteId,
    at: sql<string>`${interaction.occurredAt}::text`,
    bodyReadable: sql<boolean>`${canReadNoteSql(reader.id)}`,
    bodySource: writeUp.sourceRef,
    owes: sql<boolean>`${unwrittenSql}`,
    author: sql<
      string | null
    >`(select wa.author_id from note wa where wa.entity_id = ${interaction.noteId})`,
    body: sql<
      string | null
    >`case when ${canReadNoteSql(reader.id)} then (select left(wb.body_md, 2000) from note wb where wb.entity_id = ${interaction.noteId}) end`,
  }
  const cursor =
    params.cursor === undefined ? null : decodeCursor(params.cursor)
  // A cursor this read did not write reads nothing rather than page one again.
  const after =
    params.cursor === undefined
      ? undefined
      : cursor === null
        ? sql`false`
        : sql`(${lead}, ${interaction.occurredAt}, ${interaction.id}) < (${month === null && cursor.unwritten ? 1 : 0}, ${cursor.at}::timestamptz, ${cursor.id}::uuid)`
  const matching = and(tabSql, whoseSql, ...narrowedBy(null))
  const rowsRead =
    params.tab === 'upcoming'
      ? query(() =>
          db
            .select(columns)
            .from(interaction)
            .leftJoin(writeUp, eq(writeUp.id, interaction.noteId))
            .where(matching)
            .orderBy(asc(interaction.occurredAt), asc(interaction.id)),
        )
      : query(() =>
          db
            .select(columns)
            .from(interaction)
            .leftJoin(writeUp, eq(writeUp.id, interaction.noteId))
            .where(
              and(
                matching,
                month === null ? undefined : beforeMonthEndSql(month, tz),
                after,
              ),
            )
            .orderBy(
              desc(lead),
              desc(interaction.occurredAt),
              desc(interaction.id),
            )
            .limit(PAST_STEP + 1),
        )
  const bandsRead =
    params.tab === 'past' && narrowed
      ? query(() =>
          db
            .select({
              key: sql<string>`${pastBandKeySql({ now, tz, unwrittenSql: month === null ? unwrittenSql : null })}`,
              n: sql<number>`count(*)::int`,
            })
            .from(interaction)
            .where(matching)
            .groupBy(sql`1`),
        )
      : Effect.succeed(null)
  const [read, tally, shownTally, bandRows, named] = yield* Effect.all([
    rowsRead,
    query(() =>
      db
        .select({
          upcoming: sql<number>`count(*) filter (where ${aheadSql})::int`,
          past: sql<number>`count(*) filter (where ${pastSql})::int`,
          unwritten: sql<number>`count(*) filter (where ${pastSql} and ${unwrittenSql})::int`,
        })
        .from(interaction)
        .where(and(inArray(interaction.kind, ['meeting', 'call']), whoseSql)),
    ),
    narrowed
      ? query(() =>
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(interaction)
            .where(matching),
        )
      : Effect.succeed(null),
    bandsRead,
    namedProgram(filters, team),
  ])
  const more = params.tab === 'past' && read.length > PAST_STEP
  const rows = more ? read.slice(0, PAST_STEP) : read
  const ids = rows.map((r) => r.id)
  const sources = [
    ...new Set(
      rows.flatMap((r) => (r.bodySource === null ? [] : [r.bodySource])),
    ),
  ]
  const [records, names, summaries] = yield* Effect.all([
    recordsOf(ids),
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
    // The line its logger typed, kept on the log's activity row.
    ids.length === 0
      ? Effect.succeed([])
      : query(() =>
          db
            .select({
              id: sql<string>`${activity.meta} ->> 'interactionId'`,
              summary: sql<string | null>`${activity.meta} ->> 'summary'`,
            })
            .from(activity)
            .where(
              and(
                inArray(activity.verb, [
                  'interaction.meeting',
                  'interaction.call',
                ]),
                inArray(sql<string>`${activity.meta} ->> 'interactionId'`, ids),
              ),
            ),
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
  const typed = new Map(
    summaries.flatMap((s) =>
      s.summary === null || s.summary.trim() === ''
        ? []
        : [[s.id, s.summary.trim()] as const],
    ),
  )
  const listed = rows.map((r): ListedMeeting => {
    const meta = meetingMeta(r.meta)
    const linked = records.get(r.id) ?? []
    const invited = participantsOf(meta, linked)
    const ours = (email: string) => team.byAddress.get(email.toLowerCase())
    const people =
      meta === null
        ? linked.filter((l) => l.kind === 'person').map((l) => l.name)
        : invited
            .filter(
              (p) =>
                ours(p.email) === undefined && !mine.has(p.email.toLowerCase()),
            )
            .map(participantName)
    // The organiser and every invitee, by address.
    const attendees = [
      ...(meta === null || meta.organizer === null ? [] : [meta.organizer]),
      ...Object.keys(meta?.rsvp ?? {}),
    ].map((email) => email.toLowerCase())
    const members = [
      ...new Set(
        attendees.flatMap((email) => {
          const m = ours(email)
          return m === undefined || m.id === reader.id ? [] : [m.name]
        }),
      ),
    ]
    const state: WriteUpState =
      r.noteId === null ? 'none' : r.bodyReadable ? 'written' : 'private'
    const endsAt = endOf(r.occurredAt, meta)
    const cancelled = meta?.status === 'cancelled'
    const record = linked.find((l) => l.kind !== 'person')
    const isMine =
      meta === null
        ? loggedIds.includes(r.id) || r.author === reader.id
        : attendees.some((email) => mine.has(email))
    return {
      id: r.id,
      kind: r.kind === 'call' ? 'call' : 'meeting',
      title: r.subject,
      startsAt: r.occurredAt.toISOString(),
      endsAt,
      cancelled,
      people,
      record: record === undefined ? null : stripEmails(record),
      callLink: (meta?.conference_url ?? null) !== null,
      mine: isMine,
      members,
      noteId: r.noteId,
      writeUp: state,
      summary:
        state === 'written'
          ? (typed.get(r.id) ?? (r.body === null ? null : noteExcerpt(r.body)))
          : null,
      via:
        state === 'written' && r.bodySource !== null
          ? (nameOf.get(r.bodySource) ?? null)
          : null,
      unwritten: isUnwritten(
        {
          noteId: r.noteId,
          cancelled,
          endsAt,
          recorded: attendees.some((email) => recorders.has(email)),
          nothingToNote: meta?.nothing_to_note === true,
        },
        now,
      ),
    }
  })
  const last = rows.at(-1)
  const counts = tally.at(0) ?? { upcoming: 0, past: 0, unwritten: 0 }
  const split = until.getTime()
  return {
    rows:
      params.tab === 'upcoming'
        ? listed.filter((m) => Date.parse(m.startsAt) < split)
        : listed,
    later:
      params.tab === 'upcoming'
        ? listed.filter((m) => Date.parse(m.startsAt) >= split)
        : [],
    nextCursor:
      more && last !== undefined
        ? encodeCursor({
            unwritten: month === null && last.owes,
            at: last.at,
            id: last.id,
          })
        : null,
    counts,
    shown:
      shownTally?.at(0)?.n ??
      (params.tab === 'upcoming' ? counts.upcoming : counts.past),
    bands:
      bandRows === null
        ? null
        : Object.fromEntries(bandRows.map((b) => [b.key, b.n])),
    named,
    members: team.count,
  }
})

/** The names the applied `With` and `Member` filters print. */
const namedProgram = (
  filters: MeetingsFilters,
  team: { byAddress: ReadonlyMap<string, { id: string; name: string }> },
) =>
  Effect.gen(function* () {
    const withId = filters.with
    const withName =
      withId === null
        ? null
        : ((yield* query(() =>
            db
              .select({ name: entity.canonicalName })
              .from(entity)
              .where(eq(entity.id, withId)),
          )).at(0)?.name ?? null)
    const memberName =
      filters.member === null
        ? null
        : ([...team.byAddress.values()].find((m) => m.id === filters.member)
            ?.name ?? null)
    return { with: withName, member: memberName }
  })

/** The Filter panel's counts and `Jump to`'s months. */
export type MeetingFacets = {
  readonly kind: Readonly<Record<MeetingKind, number>>
  readonly writeUp: Readonly<Record<WriteUpFilter, number>>
  /** The cancelled meetings the tab holds under the other filters. */
  readonly cancelled: number
  /** Every member, for the `Member` picker, by name. */
  readonly members: ReadonlyArray<{
    readonly id: string
    readonly name: string
  }>
  /** Past's months with their meetings under the search and filters; empty on Upcoming. */
  readonly months: ReadonlyArray<MonthCount>
  /** The foot's `5 of 241`: what the search and filters leave, of the tab. */
  readonly shown: number
  readonly total: number
}

/**
 * The Filter panel's counts and `Jump to`'s months for one params object.
 * Each chip is counted under the open tab, whose meetings, the search and
 * every other facet's filters, with its own facet off: the number it prints
 * is the rows the list shows once it alone is on in its facet. The
 * `Cancelled` chip counts the cancelled meetings, which `Show` adds to Past
 * and `Hide` takes from Upcoming. Read when the panel or the menu opens,
 * never with the list.
 */
export const meetingFacetsProgram = Effect.fn('meetingFacetsProgram')(
  function* (
    reader: MeetingReader,
    params: MeetingsQuery,
  ): Effect.fn.Return<MeetingFacets, MeetingReadFailed> {
    const { tz, whoseSql, aheadSql, pastSql, tabSql, narrowedBy } =
      yield* listScopeProgram(reader, params)
    const past = params.tab === 'past'
    const counted = (except: MeetingsFacet | null, extra?: SQL) =>
      and(tabSql, whoseSql, ...narrowedBy(except), extra)
    const [kinds, writeUps, cancelled, shown, total, months, members] =
      yield* Effect.all([
        past
          ? query(() =>
              db
                .select({
                  meeting: sql<number>`count(*) filter (where ${interaction.kind} = 'meeting')::int`,
                  call: sql<number>`count(*) filter (where ${interaction.kind} = 'call')::int`,
                })
                .from(interaction)
                .where(counted('kind')),
            )
          : Effect.succeed([]),
        past
          ? query(() =>
              db
                .select({
                  written: sql<number>`count(*) filter (where ${writeUpSql('written', reader.id)})::int`,
                  none: sql<number>`count(*) filter (where ${writeUpSql('none', reader.id)})::int`,
                  recorder: sql<number>`count(*) filter (where ${writeUpSql('recorder', reader.id)})::int`,
                })
                .from(interaction)
                .where(counted('writeUp')),
            )
          : Effect.succeed([]),
        query(() =>
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(interaction)
            .where(counted('cancelled', cancelledSql)),
        ),
        query(() =>
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(interaction)
            .where(counted(null)),
        ),
        query(() =>
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(interaction)
            .where(and(past ? pastSql : aheadSql, whoseSql)),
        ),
        past
          ? query(() =>
              db
                .select({
                  month: sql<string>`${monthKeySql(tz)}`,
                  count: sql<number>`count(*)::int`,
                })
                .from(interaction)
                .where(counted(null))
                .groupBy(sql`1`)
                .orderBy(sql`1 desc`),
            )
          : Effect.succeed([]),
        query(() =>
          db
            .select({ id: member.id, name: member.name })
            .from(member)
            .orderBy(asc(member.name)),
        ),
      ])
    return {
      kind: kinds.at(0) ?? { meeting: 0, call: 0 },
      writeUp: writeUps.at(0) ?? { written: 0, none: 0, recorder: 0 },
      cancelled: cancelled.at(0)?.n ?? 0,
      members,
      months,
      shown: shown.at(0)?.n ?? 0,
      total: total.at(0)?.n ?? 0,
    }
  },
)

/** How far back Needs you looks for a meeting nobody wrote up. */
export const UNWRITTEN_DAYS = 14

/** A past meeting with no write-up: a Needs-you row with Write. */
export type UnwrittenMeeting = {
  id: string
  title: string | null
  startsAt: string
  /** The first linked record's name, for the row's context. */
  record: string | null
  /** The first participant outside the workspace, by name or address. */
  who: string | null
  /** The name of a linked record AI never reads; null when none is. */
  sensitive: string | null
}

/**
 * The first participant whose address is not a member's or a member's
 * connected account: the person the meeting was with.
 */
export function firstExternal(
  participants: ReadonlyArray<MeetingParticipant>,
  internal: ReadonlySet<string>,
): string | null {
  const hit = participants.find((p) => !internal.has(p.email.toLowerCase()))
  return hit === undefined ? null : (hit.name ?? hit.email)
}

/**
 * Today's Write-ups: the reader's own meetings from the last
 * `UNWRITTEN_DAYS` that ended and owe a write-up, oldest first. Mine and
 * owing are the Meetings page's rules (`readerScopeProgram`), so a recorded
 * meeting waits out the grace hour here too.
 */
export const unwrittenMeetingsProgram = Effect.fn('unwrittenMeetingsProgram')(
  function* (
    reader: MeetingReader,
    now: Date,
  ): Effect.fn.Return<Array<UnwrittenMeeting>, MeetingReadFailed> {
    const since = new Date(now.getTime() - UNWRITTEN_DAYS * 86_400_000)
    const { team, unwrittenSql, mineSql } = yield* readerScopeProgram(
      reader,
      now,
    )
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
            gte(interaction.occurredAt, since),
            sql`${endSql} <= ${now}`,
            unwrittenSql,
            mineSql,
          ),
        )
        .orderBy(asc(interaction.occurredAt), asc(interaction.id)),
    )
    const records = yield* recordsOf(rows.map((r) => r.id))
    const internal = new Set(team.byAddress.keys())
    return rows.map((r) => {
      const linked = records.get(r.id) ?? []
      const named = linked.find((l) => l.kind !== 'person') ?? linked.at(0)
      const people = participantsOf(meetingMeta(r.meta), linked)
      return {
        id: r.id,
        title: r.subject,
        startsAt: r.occurredAt.toISOString(),
        record: named?.name ?? null,
        who: firstExternal(people, internal),
        sensitive: linked.find((l) => l.sensitive)?.name ?? null,
      }
    })
  },
)

/** Whether any member has a live Google Calendar connection. */
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

/** One artifact in the window, by role. */
export type MeetingArtifact = {
  documentId: string
  role: ArtifactRole
  name: string
  /** Where a recording link opens: the provider's own page. */
  url: string | null
  /** Private to the viewer: their own transcript. */
  private: boolean
}

/** An open suggestion that cites this meeting, decided inline. */
export type MeetingSuggestion = {
  id: string
  kind: string
  /** What it proposes, in a line: the task's or the note's title. */
  summary: string
  /** A task's due day, `YYYY-MM-DD`; null for a dateless task or another kind. */
  due: string | null
}

/** A note the meeting carries beyond its write-up, readable by the viewer. */
export type MeetingCarriedNote = {
  id: string
  title: string
  role: 'recorder_note' | 'typed_notes'
  /** Private to the viewer: their own typed notes. */
  private: boolean
  /** "Open in <provider>": the note at the recorder that filed it. */
  openIn: RecorderLink | null
  /** "via <tool> · <author>". */
  via: NoteVia | null
}

export type MeetingDetail = {
  id: string
  title: string | null
  startsAt: string
  endsAt: string
  cancelled: boolean
  conferenceUrl: string | null
  participants: Array<MeetingParticipant>
  /** The edged records, then each edged company's open deals. */
  records: Array<MeetingRecord>
  /** The write-up; `title` is null when the reader may not see it. */
  note: {
    id: string
    title: string | null
    /** The write-up's text, shown inline; null when the reader may not see it. */
    body: string | null
    /** ISO instant it was written. */
    at: string
    openIn: RecorderLink | null
    via: NoteVia | null
  } | null
  /** Second notes and the viewer's typed notes, oldest first. */
  notes: Array<MeetingCarriedNote>
  artifacts: Array<MeetingArtifact>
  suggestions: Array<MeetingSuggestion>
  /**
   * Marked `Nothing to note`; null when the row cannot hold the mark (a
   * logged call or meeting carries no calendar metadata).
   */
  nothingToNote: boolean | null
}

/**
 * The open deals of `companyIds`: a deal reaches a meeting by derivation
 * from its company, never by an edge. A deal whose stage sits in the
 * `closed` option group is not open.
 */
const openDealsOf = (companyIds: ReadonlyArray<string>) =>
  companyIds.length === 0
    ? Effect.succeed<Array<MeetingRecord>>([])
    : query(() =>
        db
          .selectDistinct({
            id: entity.id,
            kind: entity.kind,
            name: entity.canonicalName,
            objectSlug: objectDef.slug,
          })
          .from(link)
          .innerJoin(entity, eq(entity.id, link.fromEntityId))
          .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
          .where(
            and(
              inArray(link.toEntityId, [...companyIds]),
              eq(link.relation, 'references'),
              eq(link.attrSlug, 'company'),
              eq(entity.kind, 'deal'),
              isNull(entity.mergedIntoId),
              sql`not exists (
                select 1 from attribute a, jsonb_array_elements(a.options -> 'options') o
                 where a.object_id = ${entity.objectId}
                   and a.slug = 'stage'
                   and o ->> 'group' = 'closed'
                   and o ->> 'id' = ${entity.values} ->> 'stage'
              )`,
            ),
          )
          .orderBy(asc(entity.canonicalName)),
      )

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
    const task = readTaskPayload(payload)
    if (task) return task.title
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
        .where(
          and(
            eq(interaction.id, id),
            inArray(interaction.kind, ['meeting', 'call']),
          ),
        ),
    )).at(0)
    if (!row) return yield* new MeetingNotFound({ id })
    const meta = meetingMeta(row.meta)
    const noteId = row.noteId
    const [records, artifacts, written, open, carried] = yield* Effect.all([
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
            visibility: document.visibility,
            authorId: document.authorId,
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
                bodyMd: note.bodyMd,
                createdAt: entity.createdAt,
                visibility: note.visibility,
                authorId: note.authorId,
                sourceRef: entity.sourceRef,
              })
              .from(note)
              .innerJoin(entity, eq(entity.id, note.entityId))
              .where(eq(note.entityId, noteId)),
          ),
      query(() =>
        db
          .select({
            id: suggestion.id,
            kind: suggestion.kind,
            payload: suggestion.payload,
            refs: suggestion.refs,
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
      query(() =>
        db
          .select({
            id: note.entityId,
            title: note.title,
            role: interactionNote.role,
            visibility: note.visibility,
            authorId: note.authorId,
            sourceRef: entity.sourceRef,
          })
          .from(interactionNote)
          .innerJoin(note, eq(note.entityId, interactionNote.noteId))
          .innerJoin(entity, eq(entity.id, note.entityId))
          .where(eq(interactionNote.interactionId, id))
          .orderBy(asc(entity.createdAt)),
      ),
    ])
    const linked = records.get(id) ?? []
    const body = written.at(0)
    const readableBody = body !== undefined && canRead(user, body)
    const readableNotes = carried.filter((n) => canRead(user, n))
    const deals = yield* openDealsOf(
      linked.filter((r) => r.kind === 'company').map((r) => r.id),
    )
    const links = yield* recorderLinksProgram(id, [
      ...(noteId !== null && readableBody ? [{ id: noteId, ...body }] : []),
      ...readableNotes,
    ]).pipe(Effect.mapError((cause) => new MeetingReadFailed({ cause })))
    const via = yield* notesViaProgram([
      ...(noteId !== null && readableBody ? [noteId] : []),
      ...readableNotes.map((n) => n.id),
    ]).pipe(Effect.mapError((cause) => new MeetingReadFailed({ cause })))
    return {
      id: row.id,
      title: row.subject,
      startsAt: row.occurredAt.toISOString(),
      endsAt: endOf(row.occurredAt, meta),
      cancelled: meta?.status === 'cancelled',
      conferenceUrl: meta?.conference_url ?? null,
      participants: participantsOf(meta, linked),
      records: [
        ...linked.map(stripEmails),
        ...deals.filter((d) => !linked.some((r) => r.id === d.id)),
      ],
      note:
        noteId === null
          ? null
          : {
              id: noteId,
              title: readableBody ? body.title || 'Untitled' : null,
              body: readableBody ? body.bodyMd : null,
              at: (body?.createdAt ?? row.occurredAt).toISOString(),
              openIn: links.get(noteId) ?? null,
              via: via.get(noteId) ?? null,
            },
      notes: readableNotes.map((n) => ({
        id: n.id,
        title: n.title || 'Untitled',
        role: n.role,
        private: n.visibility === 'private',
        openIn: links.get(n.id) ?? null,
        via: via.get(n.id) ?? null,
      })),
      // A transcript private to its member is theirs alone.
      artifacts: artifacts
        .filter((a) => canRead(user, a))
        .map((a) => ({
          documentId: a.documentId,
          role: a.role,
          name: a.filename ?? a.name,
          url: a.url ?? a.externalUrl,
          private: a.visibility === 'private',
        })),
      // What a write-up proposed shows only to a reader of the write-up.
      suggestions: open
        .filter(
          (s) =>
            noteId === null ||
            readableBody ||
            !s.refs.includes(ref.note(noteId)),
        )
        .map((s) => ({
          id: s.id,
          kind: s.kind,
          summary: suggestionSummary(s.kind, s.payload),
          due:
            s.kind === 'task'
              ? (readTaskPayload(s.payload)?.due ?? null)
              : null,
        })),
      nothingToNote: meta === null ? null : meta.nothing_to_note === true,
    }
  },
)

/**
 * Pin a record to a meeting: the one manual `interaction_entity` edge.
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
