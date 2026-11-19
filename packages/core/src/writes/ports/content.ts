import { Readable } from 'node:stream'
import {
  Effect,
  Layer,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  integration,
  interaction,
  signal,
  user,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Content, JobPermanent, JobRetryable } from '@spaces/sdk'
import type {
  DocumentClaim,
  DomainEvent,
  EmailClaim,
  EmailResult,
  InteractionClaim,
  JobError,
  JsonObject,
  JsonValue,
  MeetingCancellation,
  MeetingClaim,
  MeetingResult,
  RecordedNote,
  RecordedNoteGone,
  RecordedNoteResult,
  SignalClaim,
} from '@spaces/sdk'
import { ref } from '../../context/ref'
import { DOCUMENT_KINDS } from '../../documents'
import { finite, int, uuidString } from '../../attributes/registry'
import { jsonValue, toJson } from '../../json'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '../documents/intake'
import {
  ArtifactNotOwned,
  writeIntegrationInteraction,
  writeRecordedInteraction,
} from '../interactions/write'
import type { BodyVisibility, RecordedArtifact } from '../interactions/write'
import { MeetingLane } from '../interactions/meeting-lane'
import {
  fileRecordedTranscriptProgram,
  recorderKey,
  removeRecordedNotesProgram,
  writeRecordedNote,
} from '../interactions/recorded-note'
import type {
  RecordedNoteInput,
  RecordedNoteOwner,
} from '../interactions/recorded-note'
import { EmailLane } from '../interactions/email-lane'
import type {
  MeetingInput,
  ParticipantInput,
} from '../interactions/meeting-lane'
import { dispatchDomainEvent } from '../events/dispatch'
import type { DocumentFilingTarget } from '../../documents/filing'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import type { Json } from '@spaces/db/json'
import type { DocumentIntakeFailure } from '../documents/intake'
import type { Tx } from '../attributes/values'
import type { BoundIntegration } from './binding'
import { integrationMeta } from './identity'
import { ReceiptNotOwned, checkReceipt, insertReceipt } from './receipts'

/**
 * ContentLive's interaction, signal and document lanes. Every row is stamped
 * `source_class 'integration'` + `source_ref` = the bound row **by the
 * port**: claims carry no source, and rows are built field by field, never
 * by spreading the claim, so a job cannot change who wrote them.
 * - `logInteraction` runs `writeIntegrationInteraction`: one row per
 *   `messageId` (a duplicate hands back the existing id), a new row each time
 *   without one. Merged ids follow `merged_into_id`; an unknown id is a
 *   permanent failure.
 * - The body is the interaction's note and its visibility is the port's: the
 *   claim must not grow a visibility field. Born `private`, authored by the
 *   connection user, else the installing admin, else the first admin.
 * - `emitSignal` writes one `signal` row plus a `signal.emitted` activity
 *   row; evidence, never an attribute. A keyed claim is written once per
 *   (record, integration, key) under an advisory lock on the triple.
 * - `fileDocument` is a thin port over `intakeDocumentProgram`: nothing here
 *   writes a `document` row, hashes a byte or touches the blob store — a
 *   copy would let the plugin lane and hand upload drift apart.
 * - A `recorder` payload is stored as a receipt first, then handed to
 *   `writeRecordedInteraction`; it writes no note. `logRecordedNote` is the
 *   recorder note contract (`writeRecordedNote`, `removeRecordedNotesProgram`).
 * - `interaction.logged` events are dispatched once the write commits.
 */

/**
 * `logMeeting` checks the claim — a bundle is JavaScript — and
 * hands it to the `MeetingLane`, which this Layer requires: the noise rules
 * and the participants module are the arrival lane's, and a second copy of
 * either here is how a calendar attendee and a mail participant would drift
 * apart. Records it creates are created by the body author below.
 *
 * `logEmail` checks and decodes the claim and hands it to the
 * `EmailLane` the same way: the parser, noise rules, exclude list and the
 * body's visibility are the arrival lane's, read from the bound connection.
 */

/** A body written through `logInteraction` is private to its author. */
export const PLUGIN_BODY_VISIBILITY: BodyVisibility = 'private'

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

const retryable = (what: string) => (cause: unknown) =>
  new JobRetryable({ reason: `Content.${what} failed: ${messageOf(cause)}` })

/** The live survivor of each id, or the ids that name nothing. */
const survivors = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: entity.id, mergedIntoId: entity.mergedIntoId })
          .from(entity)
          .where(inArray(entity.id, [...ids])),
      catch: retryable('entity lookup'),
    })
    const byId = new Map(rows.map((r) => [r.id, r.mergedIntoId ?? r.id]))
    const missing = ids.filter((id) => !byId.has(id))
    return { missing, ids: ids.flatMap((id) => byId.get(id) ?? []) }
  })

/** Who a plugin-written body is authored by — see the module comment. */
export const bodyAuthor = async (
  integrationId: string,
): Promise<string | null> => {
  const bound = (
    await db
      .select({
        createdBy: integration.createdBy,
        connectionUser: accountConnection.userId,
      })
      .from(integration)
      .leftJoin(
        accountConnection,
        eq(accountConnection.id, integration.connectionId),
      )
      .where(eq(integration.id, integrationId))
  ).at(0)
  const named = bound?.connectionUser ?? bound?.createdBy ?? null
  if (named !== null) return named
  const admin = (
    await db
      .select({ id: user.id })
      .from(user)
      .orderBy(sql`${user.role} = 'admin' desc`, asc(user.createdAt))
      .limit(1)
  ).at(0)
  return admin?.id ?? null
}

/** The `signal.payload` a claim becomes: its declared fields, nothing else. */
const signalPayload = (claim: SignalClaim): JsonObject => {
  const out: { [key: string]: JsonValue } = { kind: claim.kind }
  if (claim.title !== undefined) out.title = claim.title
  if (claim.url !== undefined) out.url = claim.url
  if (claim.publishedAt !== undefined) out.publishedAt = claim.publishedAt
  if (claim.payload !== undefined) out.payload = claim.payload
  if (claim.receiptId !== undefined) out.refs = [ref.event(claim.receiptId)]
  if (claim.key !== undefined) out.key = claim.key
  return out
}

const parseTimestamp = (what: string, iso: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? Effect.fail(
        new JobPermanent({
          reason: `Content.${what}: ${JSON.stringify(iso)} is not an ISO timestamp`,
        }),
      )
    : Effect.succeed(at)
}

/** Gmail's own ceiling on a message, attachments included. */
export const MAX_EMAIL_BYTES = 35 * 1024 * 1024

/** Unknown keys refuse the claim rather than being dropped. */
const strict = { parseOptions: { onExcessProperty: 'error' } } as const

const maxLength = (max: number) => Schema.String.check(Schema.isMaxLength(max))

/** A string trimmed, then held to `max` characters. */
const trimmedTo = (max: number) => Schema.Trim.check(Schema.isMaxLength(max))

/**
 * An ISO 8601 instant with a zone: a real calendar day, `T`, hours and
 * minutes, optional seconds and fraction, then `Z` or a `±hh:mm` offset.
 */
const ISO_INSTANT =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** A bundle is JavaScript: the claim is checked field by field. */
export const emailClaim = Schema.Struct({
  providerMessageId: Schema.Trim.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  raw: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/, { message: 'not base64url' }),
  ),
  receivedAt: Schema.String.check(
    Schema.isPattern(ISO_INSTANT, { message: 'Invalid ISO datetime' }),
  ),
  labels: Schema.mutable(Schema.Array(trimmedTo(256))).check(
    Schema.isMaxLength(200),
  ),
  snippet: Schema.optional(trimmedTo(1000)),
})

const text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000))

/** Anything `new Date` reads as a real instant, handed on as that Date. */
const instant = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformOrFail({
      decode: (iso: string) => {
        const at = new Date(iso)
        return Number.isNaN(at.getTime())
          ? Effect.fail(
              new SchemaIssue.InvalidValue({
                message: 'an ISO timestamp',
              }),
            )
          : Effect.succeed(at)
      },
      encode: (at: Date) => Effect.succeed(at.toISOString()),
    }),
  ),
)

/**
 * An http(s) URL with its `//`, `new URL` parsing it once trimmed; handed on
 * trimmed, not normalized, and held to 2000 characters.
 */
const httpUrl = Schema.String.pipe(
  Schema.decodeTo(
    maxLength(2000),
    SchemaTransformation.transformOrFail({
      decode: (raw: string) => {
        const url = raw.trim()
        return /^https?:\/\//i.test(url) && URL.canParse(url)
          ? Effect.succeed(url)
          : Effect.fail(
              new SchemaIssue.InvalidValue({
                message: 'Invalid URL',
              }),
            )
      },
      encode: (url: string) => Effect.succeed(url),
    }),
  ),
)

/** What a meeting claim must be, read at runtime; an unknown field is refused. */
const meetingClaim = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('meeting'),
    uid: text,
    eventId: text,
    status: Schema.Literals(['scheduled', 'cancelled']),
    startsAt: instant,
    endsAt: instant,
    subject: Schema.optional(maxLength(2000)),
    organizer: Schema.optional(text),
    conferenceUrl: Schema.optional(text),
    recurringInstanceId: Schema.optional(text),
    attendees: Schema.Array(
      Schema.Struct({
        email: text,
        name: Schema.optional(maxLength(400)),
        rsvp: Schema.Literals([
          'accepted',
          'declined',
          'tentative',
          'needs_action',
        ]),
        self: Schema.optional(Schema.Boolean),
      }).annotate(strict),
    ).check(Schema.isMaxLength(1000)),
  }).annotate(strict),
  Schema.Struct({
    _tag: Schema.Literal('meeting-cancelled'),
    eventId: text,
    uid: Schema.optional(text),
  }).annotate(strict),
])

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Every refusal in one line, each named by its dotted path under `at`:
 * `recorder.artifacts.0.url: Invalid URL`. A refusal of the whole value
 * is named `at` alone, or `fallback` when there is no `at`.
 */
const issueLine = (
  issue: SchemaIssue.Issue,
  at: string | null,
  fallback = 'claim',
) =>
  formatIssues(issue)
    .issues.map(({ path, message }) => {
      const keys = (path ?? []).map((s) =>
        String(Predicate.isObject(s) ? s.key : s),
      )
      const named = (at === null ? keys : [at, ...keys]).join('.')
      return `${named === '' ? fallback : named}: ${message}`
    })
    .join('; ')

/** `raw` decoded by `schema`, every refusal at once. */
const decodeAll = <TSchema extends Schema.Decoder<unknown>>(
  schema: TSchema,
  raw: unknown,
) => SchemaParser.decodeUnknownResult(schema, { errors: 'all' })(raw)

const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The claim, checked and normalized, or the reason it is not one. */
export const readMeetingClaim = (
  claim: MeetingClaim | MeetingCancellation,
): { ok: true; input: MeetingInput } | { ok: false; reason: string } => {
  const parsed = decodeAll(meetingClaim, claim)
  if (Result.isFailure(parsed))
    return { ok: false, reason: issueLine(parsed.failure, null) }
  const c = parsed.success
  if (c._tag === 'meeting-cancelled')
    return {
      ok: true,
      input: { _tag: c._tag, eventId: c.eventId, uid: c.uid ?? null },
    }
  if (c.endsAt.getTime() < c.startsAt.getTime())
    return { ok: false, reason: 'endsAt: before startsAt' }
  return {
    ok: true,
    input: {
      _tag: 'meeting',
      uid: c.uid,
      eventId: c.eventId,
      status: c.status,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      subject: blankToNull(c.subject),
      organizer: c.organizer?.toLowerCase() ?? null,
      conferenceUrl: c.conferenceUrl ?? null,
      recurringInstanceId: c.recurringInstanceId ?? null,
      attendees: c.attendees.map((a) => ({
        email: a.email.toLowerCase(),
        name: blankToNull(a.name),
        rsvp: a.rsvp,
        self: a.self ?? false,
      })),
    },
  }
}

/** Dispatch what a committed write handed back; never fails. */
const dispatchAll = (events: ReadonlyArray<DomainEvent>) =>
  Effect.forEach(events, (event) => dispatchDomainEvent(event))

const participantShape = Schema.Struct({
  email: text,
  name: Schema.optional(maxLength(400)),
}).annotate(strict)

const participantList = Schema.Array(participantShape).check(
  Schema.isMaxLength(1000),
)

const artifactShape = Schema.Union([
  Schema.Struct({
    role: Schema.Literal('recording_link'),
    url: httpUrl,
    title: Schema.optional(maxLength(400)),
  }).annotate(strict),
  Schema.Struct({
    role: Schema.Literals(['transcript', 'attachment']),
    documentId: uuidString,
  }).annotate(strict),
])

/** Stored as the bundle sent it: a required key, any JSON value. */
const rawJson = Schema.suspend((): Schema.Decoder<Json> => jsonValue)

const recorderShape = Schema.Struct({
  providerEventId: text,
  icalUid: Schema.optional(text),
  calendarEventId: Schema.optional(text),
  durationSeconds: Schema.optional(
    Schema.Number.check(finite, int, Schema.isGreaterThanOrEqualTo(0)),
  ),
  raw: rawJson,
  artifacts: Schema.optional(
    Schema.Array(artifactShape).check(Schema.isMaxLength(50)),
  ),
}).annotate(strict)

/** A recorder payload, checked: the writer's keys and artifacts. */
type RecorderInput = {
  providerEventId: string
  icalUid: string | null
  calendarEventId: string | null
  durationSeconds: number | null
  raw: Json
  artifacts: Array<RecordedArtifact>
}

/**
 * The parts of an interaction claim a bundle could get wrong at runtime: its
 * participants, its recorder payload, and having somewhere to live.
 */
export const readInteractionShape = (
  claim: InteractionClaim,
):
  | {
      ok: true
      participants: Array<ParticipantInput>
      recorder: RecorderInput | null
    }
  | { ok: false; reason: string } => {
  const people = decodeAll(participantList, claim.participants ?? [])
  if (Result.isFailure(people))
    return { ok: false, reason: issueLine(people.failure, 'participants') }
  const participants = [
    ...new Map(
      people.success.map((p) => {
        const email = p.email.toLowerCase()
        return [email, { email, name: blankToNull(p.name) }]
      }),
    ).values(),
  ]
  if ((claim.entityIds ?? []).length === 0 && participants.length === 0)
    return {
      ok: false,
      reason: 'an interaction names at least one entity or participant',
    }
  if (claim.recorder === undefined)
    return { ok: true, participants, recorder: null }
  // The type forbids a body here; a bundle is JavaScript.
  if (Object.hasOwn(claim, 'body'))
    return {
      ok: false,
      reason: "a recorder's payload carries no body: its notes are the host's",
    }
  const parsed = decodeAll(recorderShape, claim.recorder)
  if (Result.isFailure(parsed))
    return { ok: false, reason: issueLine(parsed.failure, 'recorder') }
  const r = parsed.success
  return {
    ok: true,
    participants,
    recorder: {
      providerEventId: r.providerEventId,
      icalUid: r.icalUid ?? null,
      calendarEventId: r.calendarEventId ?? null,
      durationSeconds: r.durationSeconds ?? null,
      raw: r.raw,
      artifacts: (r.artifacts ?? []).map((a): RecordedArtifact =>
        a.role === 'recording_link'
          ? {
              role: a.role,
              url: a.url,
              title: blankToNull(a.title) ?? 'Recording',
            }
          : { role: a.role, documentId: a.documentId },
      ),
    },
  }
}

const longText = maxLength(1_000_000)

/** What a recorded note must be, read at runtime; an unknown field is refused. */
const recordedNoteShape = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('recorded-note'),
    providerNoteId: text,
    title: Schema.optional(maxLength(2000)),
    startedAt: instant,
    endedAt: Schema.optional(instant),
    attendees: participantList,
    calendarEventId: Schema.optional(text),
    icalUid: Schema.optional(text),
    summary: Schema.optional(longText),
    typedNotes: Schema.optional(longText),
    transcript: Schema.optional(longText),
    webUrl: Schema.optional(httpUrl),
    recordingUrl: Schema.optional(httpUrl),
    folderIds: Schema.optional(
      Schema.Array(text).check(Schema.isMaxLength(1000)),
    ),
    deletedAt: Schema.optional(instant),
    raw: rawJson,
  }).annotate(strict),
  Schema.Struct({
    _tag: Schema.Literal('recorded-note-gone'),
    providerNoteId: text,
  }).annotate(strict),
])

/** The note, checked: gone, or the writer's input with its participants. */
export const readRecordedNote = (
  claim: RecordedNote | RecordedNoteGone,
):
  | { ok: true; gone: string }
  | {
      ok: true
      gone: null
      input: RecordedNoteInput
      participants: Array<ParticipantInput>
    }
  | { ok: false; reason: string } => {
  const parsed = decodeAll(recordedNoteShape, claim)
  if (Result.isFailure(parsed))
    return { ok: false, reason: issueLine(parsed.failure, 'note') }
  const c = parsed.success
  if (c._tag === 'recorded-note-gone' || c.deletedAt !== undefined)
    return { ok: true, gone: c.providerNoteId }
  if (c.endedAt !== undefined && c.endedAt.getTime() < c.startedAt.getTime())
    return { ok: false, reason: 'note.endedAt: before startedAt' }
  const participants = [
    ...new Map(
      c.attendees.map((p) => {
        const email = p.email.toLowerCase()
        return [email, { email, name: blankToNull(p.name) }]
      }),
    ).values(),
  ]
  const blank = (v: string | undefined) =>
    v === undefined || v.trim() === '' ? null : v
  return {
    ok: true,
    gone: null,
    participants,
    input: {
      providerNoteId: c.providerNoteId,
      title: blankToNull(c.title),
      startedAt: c.startedAt,
      durationSeconds:
        c.endedAt === undefined
          ? null
          : Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000),
      emails: participants.map((p) => p.email),
      calendarEventId: c.calendarEventId ?? null,
      icalUid: c.icalUid ?? null,
      summary: blank(c.summary),
      typedNotes: blank(c.typedNotes),
      transcript: blank(c.transcript),
      webUrl: c.webUrl ?? null,
      recordingUrl: c.recordingUrl ?? null,
      raw: c.raw,
    },
  }
}

/** Who a recorded note is by: the bound connection's member, else the body author. */
const recordedNoteOwner = async (row: {
  id: string
  connectionId?: string | null
}): Promise<RecordedNoteOwner | null> => {
  const connectionId = row.connectionId ?? null
  if (connectionId !== null) {
    const held = (
      await db
        .select({ userId: accountConnection.userId })
        .from(accountConnection)
        .where(eq(accountConnection.id, connectionId))
    ).at(0)
    return held === undefined
      ? null
      : { integrationId: row.id, connectionId, authorId: held.userId }
  }
  const authorId = await bodyAuthor(row.id)
  return authorId === null
    ? null
    : { integrationId: row.id, connectionId: null, authorId }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FILING_KINDS: ReadonlySet<string> = new Set(['record', 'space'])

/** The limits the browser lane's validator holds a filename and a mime to. */
const MAX_FILENAME = 400
const MAX_MIME = 200

/**
 * Intake's answer as a job outcome. A refusal — too large, a target that
 * will not take the filing — is permanent, since the same bytes would be
 * refused again; a broken read or write is retryable, and a retry re-runs
 * the job, which opens the source afresh.
 */
const intakeOutcome = (failure: DocumentIntakeFailure): JobError => {
  const reason = `Content.fileDocument: ${documentIntakeMessage(failure)}`
  return failure._tag === 'DocumentIntakeFailed' ||
    failure._tag === 'DocumentBirthFailed'
    ? new JobRetryable({ reason })
    : new JobPermanent({ reason })
}

/**
 * A web stream's chunks, for `Readable.from`. Not `Readable.fromWeb`: its
 * parameter is node's own `stream/web` type, which the DOM lib's
 * `ReadableStream` the SDK declares does not satisfy. When intake's pipeline
 * destroys the `Readable` — the meter passed `MAX_UPLOAD_BYTES`, or the temp
 * write broke — the generator is returned early and the `finally` cancels the
 * plugin's source, so a runaway provider stops being read from.
 */
async function* chunksOf(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Buffer> {
  const reader = stream.getReader()
  let done = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        done = true
        return
      }
      yield Buffer.from(
        next.value.buffer,
        next.value.byteOffset,
        next.value.byteLength,
      )
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** The plugin's bytes as the `Readable` intake drains, with what it declared. */
const openBody = (
  body: DocumentClaim['body'],
): { stream: Readable; declaredSize: number | null } | null => {
  if ('bytes' in body && body.bytes instanceof Uint8Array) {
    const bytes = body.bytes
    return {
      stream: Readable.from([
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ]),
      // Measured off the bytes in hand, never a number the plugin supplied:
      // intake refuses an over-limit size before reading, and the meter
      // counts again regardless.
      declaredSize: bytes.byteLength,
    }
  }
  if ('stream' in body && body.stream instanceof ReadableStream) {
    return { stream: Readable.from(chunksOf(body.stream)), declaredSize: null }
  }
  return null
}

/** Release a stream the port refused before intake ever read it. */
const discard = (body: DocumentClaim['body']) =>
  'stream' in body && body.stream instanceof ReadableStream
    ? Effect.promise(() => body.stream.cancel().catch(() => undefined))
    : Effect.void

export const ContentLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'> &
    Partial<Pick<BoundIntegration, 'connectionId'>>,
): Layer.Layer<Content, never, Enqueue | MeetingLane | EmailLane> => {
  const refuse = (body: DocumentClaim['body'], reason: string) =>
    discard(body).pipe(
      Effect.andThen(
        Effect.fail(
          new JobPermanent({ reason: `Content.fileDocument: ${reason}` }),
        ),
      ),
    )

  const fileDocument = Effect.fn('Content.fileDocument')(function* (
    claim: DocumentClaim,
  ): Effect.fn.Return<{ documentId: string }, JobError, Enqueue> {
    const filename = claim.filename.trim()
    if (filename.length === 0 || filename.length > MAX_FILENAME) {
      return yield* refuse(
        claim.body,
        `a filename of 1–${MAX_FILENAME} characters is required`,
      )
    }
    if (claim.mime !== null && claim.mime.length > MAX_MIME) {
      return yield* refuse(claim.body, 'the mime type is too long')
    }
    const kind = DOCUMENT_KINDS.find((k) => k === (claim.kind ?? 'other'))
    if (kind === undefined) {
      return yield* refuse(
        claim.body,
        `${JSON.stringify(claim.kind)} is not a document kind`,
      )
    }

    // The kind is checked at runtime against a set because a bundle is
    // JavaScript: the claim's type says `record | space`, the bytes may not.
    const malformed = claim.fileAgainst.find(
      (t) => !UUID.test(t.entityId) || !FILING_KINDS.has(t.kind),
    )
    if (malformed !== undefined) {
      return yield* refuse(
        claim.body,
        `${JSON.stringify(malformed)} is not a filing target`,
      )
    }
    const found =
      claim.fileAgainst.length === 0
        ? { missing: [], ids: [] }
        : yield* survivors(claim.fileAgainst.map((t) => t.entityId))
    if (found.missing.length > 0) {
      return yield* refuse(claim.body, `no record ${found.missing.join(', ')}`)
    }
    // `survivors` keeps order and length, so target i is survivor i.
    const fileAgainst: Array<DocumentFilingTarget> = []
    claim.fileAgainst.forEach((target, i) => {
      const entityId = found.ids[i]
      if (
        !fileAgainst.some(
          (t) => t.kind === target.kind && t.entityId === entityId,
        )
      )
        fileAgainst.push({ kind: target.kind, entityId })
    })

    const opened = openBody(claim.body)
    if (opened === null) {
      return yield* refuse(claim.body, 'the body is neither bytes nor a stream')
    }

    const { id } = yield* intakeDocumentProgram({
      stream: opened.stream,
      declaredSize: opened.declaredSize,
      filename,
      url: claim.url ?? null,
      mime: claim.mime,
      kind,
      // Provenance is the port's: the claim carries none, and these
      // are the only values intake is ever handed from here.
      sourceClass: 'integration',
      sourceRef: row.id,
      provenance: {},
      fileAgainst,
      actor: { integrationId: row.id },
    }).pipe(Effect.mapError(intakeOutcome))
    return { documentId: id }
  })

  const logInteraction = Effect.fn('Content.logInteraction')(function* (
    claim: InteractionClaim,
  ): Effect.fn.Return<
    { interactionId: string },
    JobError,
    Enqueue | MeetingLane
  > {
    const occurredAt = yield* parseTimestamp('logInteraction', claim.occurredAt)
    const read = readInteractionShape(claim)
    if (!read.ok) {
      return yield* new JobPermanent({
        reason: `Content.logInteraction: ${read.reason}`,
      })
    }
    const { participants, recorder } = read

    // The payload first, whole, before anything it claims is applied.
    const receiptId =
      recorder === null
        ? null
        : yield* Effect.tryPromise({
            try: () =>
              insertReceipt(row, {
                entityId: null,
                raw: recorder.raw,
                creditsUsed: null,
              }),
            catch: retryable('logInteraction'),
          })

    const given = claim.entityIds ?? []
    const edges =
      given.length === 0 ? { missing: [], ids: [] } : yield* survivors(given)
    if (edges.missing.length > 0) {
      return yield* new JobPermanent({
        reason: `Content.logInteraction: no record ${edges.missing.join(', ')}`,
      })
    }

    let authorId: string | null = null
    if (claim.body !== undefined || participants.length > 0) {
      authorId = yield* Effect.tryPromise({
        try: () => bodyAuthor(row.id),
        catch: retryable('logInteraction'),
      })
      if (authorId === null) {
        return yield* new JobPermanent({
          reason:
            'Content.logInteraction: no workspace user to author the body',
        })
      }
    }
    const people =
      participants.length === 0 || authorId === null
        ? []
        : yield* (yield* MeetingLane).participants(
            { integrationId: row.id, authorId },
            participants,
          )
    const entityIds = [...edges.ids, ...people]

    if (recorder !== null && receiptId !== null) {
      const recorded = yield* Effect.tryPromise({
        try: () =>
          db.transaction((tx) =>
            writeRecordedInteraction(tx, {
              integrationId: row.id,
              providerEventId: recorder.providerEventId,
              icalUid: recorder.icalUid,
              calendarEventId: recorder.calendarEventId,
              occurredAt,
              subject: blankToNull(claim.subject),
              durationSeconds: recorder.durationSeconds,
              emails: participants.map((p) => p.email),
              receiptId,
              edges: entityIds,
              artifacts: recorder.artifacts,
            }),
          ),
        catch: (cause) =>
          cause instanceof ArtifactNotOwned
            ? new JobPermanent({
                reason: `Content.logInteraction: ${cause.message}`,
              })
            : retryable('logInteraction')(cause),
      })
      yield* dispatchAll(recorded.events)
      return { interactionId: recorded.interactionId }
    }

    const messageId = claim.messageId ?? null
    const body =
      claim.body === undefined || authorId === null
        ? null
        : {
            title: claim.subject ?? '',
            text: claim.body,
            authorId,
            visibility: PLUGIN_BODY_VISIBILITY,
          }

    const written = yield* Effect.tryPromise({
      try: () =>
        db.transaction((tx) =>
          writeIntegrationInteraction(tx, {
            integrationId: row.id,
            kind: claim.kind,
            messageId,
            threadId: claim.threadId ?? null,
            subject: claim.subject ?? null,
            occurredAt,
            body,
            edges: entityIds,
          }),
        ),
      catch: retryable('logInteraction'),
    })
    if (written.kind === 'written') {
      yield* dispatchAll(written.events)
      return { interactionId: written.interactionId }
    }

    // A duplicate: the row the index kept is the answer (one row per
    // messageId), whoever wrote it.
    const kept = yield* Effect.tryPromise({
      try: async () =>
        messageId === null
          ? undefined
          : (
              await db
                .select({ id: interaction.id })
                .from(interaction)
                .where(eq(interaction.messageId, messageId))
            ).at(0),
      catch: retryable('logInteraction'),
    })
    if (kept === undefined) {
      return yield* new JobRetryable({
        reason: `Content.logInteraction: ${String(messageId)} conflicted but no row holds it`,
      })
    }
    return { interactionId: kept.id }
  })

  /** The signal this integration already wrote under `key`, after locking the triple. */
  const keyedSignal = async (
    tx: Tx,
    entityId: string,
    key: string,
  ): Promise<string | null> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`signal ${entityId} ${row.id} ${key}`}, 0))`,
    )
    const held = (
      await tx
        .select({ id: signal.id })
        .from(signal)
        .where(
          and(
            eq(signal.entityId, entityId),
            eq(signal.sourceRef, row.id),
            sql`${signal.payload} ->> 'key' = ${key}`,
          ),
        )
        .limit(1)
    ).at(0)
    return held?.id ?? null
  }

  const emitSignal = Effect.fn('Content.emitSignal')(function* (
    claim: SignalClaim,
  ) {
    const { receiptId } = claim
    if (receiptId !== undefined && !UUID.test(receiptId)) {
      return yield* new JobPermanent({
        reason: `Content.emitSignal: no receipt ${receiptId}`,
      })
    }
    const target = yield* survivors([claim.entityId])
    const entityId = target.ids.at(0)
    if (entityId === undefined) {
      return yield* new JobPermanent({
        reason: `Content.emitSignal: no record ${claim.entityId}`,
      })
    }
    const payload = yield* Effect.try({
      try: () => toJson(signalPayload(claim)),
      catch: () =>
        new JobPermanent({
          reason: 'Content.emitSignal: the payload is not JSON',
        }),
    })
    const signalId = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          if (receiptId !== undefined) await checkReceipt(tx, row.id, receiptId)
          if (claim.key !== undefined) {
            const held = await keyedSignal(tx, entityId, claim.key)
            if (held !== null) return held
          }
          const inserted = (
            await tx
              .insert(signal)
              .values({
                entityId,
                source: row.capabilityId,
                payload,
                sourceClass: 'integration',
                sourceRef: row.id,
              })
              .returning({ id: signal.id })
          ).at(0)
          if (!inserted) throw new Error('signal insert returned no row')
          await tx.insert(activity).values({
            actorId: null,
            verb: 'signal.emitted',
            subjectEntityId: entityId,
            meta: {
              ...integrationMeta(row),
              signalId: inserted.id,
              kind: claim.kind,
              ...(claim.title === undefined ? {} : { title: claim.title }),
            },
          })
          return inserted.id
        }),
      catch: (cause) =>
        cause instanceof ReceiptNotOwned
          ? new JobPermanent({
              reason: `Content.emitSignal: ${cause.message}`,
            })
          : retryable('emitSignal')(cause),
    })
    return { signalId }
  })

  const logMeeting = Effect.fn('Content.logMeeting')(function* (
    claim: MeetingClaim | MeetingCancellation,
  ): Effect.fn.Return<MeetingResult, JobError, MeetingLane> {
    const read = readMeetingClaim(claim)
    if (!read.ok) {
      return yield* new JobPermanent({
        reason: `Content.logMeeting: ${read.reason}`,
      })
    }
    const authorId = yield* Effect.tryPromise({
      try: () => bodyAuthor(row.id),
      catch: retryable('logMeeting'),
    })
    if (authorId === null) {
      return yield* new JobPermanent({
        reason: 'Content.logMeeting: no workspace user to create records as',
      })
    }
    return yield* (yield* MeetingLane).log(
      { integrationId: row.id, authorId },
      read.input,
    )
  })

  const logEmail = Effect.fn('Content.logEmail')(function* (
    claim: EmailClaim,
  ): Effect.fn.Return<EmailResult, JobError, EmailLane> {
    const decoded = decodeAll(emailClaim, claim)
    if (Result.isFailure(decoded)) {
      return yield* new JobPermanent({
        reason: `Content.logEmail: ${issueLine(decoded.failure, null)}`,
      })
    }
    const email = decoded.success
    const raw = Buffer.from(email.raw, 'base64url')
    if (raw.length === 0 || raw.length > MAX_EMAIL_BYTES) {
      return yield* new JobPermanent({
        reason: `Content.logEmail: a message of 1 byte to ${MAX_EMAIL_BYTES / 1024 / 1024} MB is required`,
      })
    }
    return yield* (yield* EmailLane).log(
      { integrationId: row.id },
      {
        providerMessageId: email.providerMessageId,
        raw,
        receivedAt: new Date(email.receivedAt),
        labels: email.labels.filter((l) => l.length > 0),
        ...(email.snippet ? { snippet: email.snippet } : {}),
      },
    )
  })

  const logRecordedNote = Effect.fn('Content.logRecordedNote')(function* (
    claim: RecordedNote | RecordedNoteGone,
  ): Effect.fn.Return<RecordedNoteResult, JobError, Enqueue | MeetingLane> {
    const read = readRecordedNote(claim)
    if (!read.ok) {
      return yield* new JobPermanent({
        reason: `Content.logRecordedNote: ${read.reason}`,
      })
    }
    const owner = yield* Effect.tryPromise({
      try: () => recordedNoteOwner(row),
      catch: retryable('logRecordedNote'),
    })
    if (owner === null) {
      return yield* new JobPermanent({
        reason:
          'Content.logRecordedNote: the bound connection is gone, or no workspace user can author the note',
      })
    }
    if (read.gone !== null) {
      const [interactionId] = yield* removeRecordedNotesProgram(owner, [
        recorderKey(owner.integrationId, owner.connectionId, read.gone),
      ]).pipe(Effect.mapError(retryable('logRecordedNote')))
      return { outcome: 'removed', interactionId: interactionId ?? null }
    }
    const edges =
      read.participants.length === 0
        ? []
        : yield* (yield* MeetingLane).participants(
            { integrationId: row.id, authorId: owner.authorId },
            read.participants,
          )
    const written = yield* Effect.tryPromise({
      try: () => writeRecordedNote(owner, read.input, edges),
      catch: (cause) =>
        cause instanceof ArtifactNotOwned
          ? new JobPermanent({
              reason: `Content.logRecordedNote: ${cause.message}`,
            })
          : retryable('logRecordedNote')(cause),
    })
    yield* dispatchAll(written.events)
    const transcript = written.followUp?.transcript ?? null
    const tasks = written.followUp?.tasks ?? null
    // Before the transcript: a retry finds the note held and queues nothing.
    if (tasks !== null)
      yield* (yield* Enqueue).enqueue(
        QUEUES.recordedNoteTasks,
        { ...tasks },
        { singletonKey: tasks.noteId },
      )
    if (transcript !== null)
      yield* fileRecordedTranscriptProgram(
        owner,
        written.interactionId,
        transcript,
      ).pipe(
        Effect.catchTags({
          // Refused for good: the note stands without it.
          DocumentTooLarge: () =>
            Effect.logWarning(
              'logRecordedNote: transcript over the size limit',
            ),
          DocumentBirthRejected: (refused) =>
            Effect.logWarning(`logRecordedNote: ${refused.reason}`),
        }),
        Effect.mapError(retryable('logRecordedNote')),
      )
    return { outcome: written.outcome, interactionId: written.interactionId }
  })

  return Layer.effect(
    Content,
    Effect.gen(function* () {
      // The extraction enqueue at the end of birth runs on the process's
      // own `Enqueue`, captured once here as `FactsLive` captures it; the
      // meeting and mail lanes the same way.
      const context = yield* Effect.context<Enqueue | MeetingLane | EmailLane>()
      return Content.of({
        fileDocument: (claim) =>
          fileDocument(claim).pipe(Effect.provide(context)),
        logInteraction: (claim) =>
          logInteraction(claim).pipe(Effect.provide(context)),
        emitSignal,
        logMeeting: (claim) => logMeeting(claim).pipe(Effect.provide(context)),
        logEmail: (claim) => logEmail(claim).pipe(Effect.provide(context)),
        logRecordedNote: (claim) =>
          logRecordedNote(claim).pipe(Effect.provide(context)),
      })
    }),
  )
}
