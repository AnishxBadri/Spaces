import { Readable } from 'node:stream'
import { Effect, Layer } from 'effect'
import { z } from 'zod'
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
  SignalClaim,
} from '@spaces/sdk'
import { ref } from '../../context/ref'
import { DOCUMENT_KINDS } from '../../documents'
import { jsonValue } from '../../json'
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
import { EmailLane } from '../interactions/email-lane'
import type {
  MeetingInput,
  ParticipantInput,
} from '../interactions/meeting-lane'
import { dispatchDomainEvent } from '../events/dispatch'
import type { DocumentFilingTarget } from '../../documents/filing'
import type { Enqueue } from '../../queue/enqueue'
import type { Json } from '@spaces/db/json'
import type { DocumentIntakeFailure } from '../documents/intake'
import type { Tx } from '../attributes/values'
import type { BoundIntegration } from './binding'
import { integrationMeta } from './identity'
import { ReceiptNotOwned, checkReceipt, insertReceipt } from './receipts'

/**
 * ContentLive's interaction and signal lanes (sdk-7b; spec §4, D52, D57):
 * the evidence rows a syncer, a researcher or a webhook job writes, stamped
 * `source_class 'integration'` + `source_ref` = the bound row **by the
 * port**. The claim types carry no source (D52), and nothing below reads a
 * field a claim does not declare — the rows are built field by field, never
 * by spreading the claim — so a job cannot change who wrote them.
 *
 * - `logInteraction` is core's integration interaction lane,
 *   `writeIntegrationInteraction` (`../interactions/write.ts`), the one the
 *   forwarding mailbox runs on: one row per `messageId` through
 *   `interaction_message_id_unique` — a duplicate writes nothing and hands
 *   back the existing row's id — and a new row every time when the claim
 *   has no key, as on the manual path. An edge per entity, a merged-away id
 *   following `merged_into_id` to the survivor; an id that does not exist is
 *   a permanent failure, since retrying would name it again.
 * - **The body is the interaction's note, and its visibility is the
 *   port's** (D30, D49): the claim carries no visibility field and must not
 *   grow one. A body written through `logInteraction` is born **`private`**,
 *   authored by the bound row's connection user, else the admin who
 *   installed it, else the first admin. Synced mail is `logEmail`'s, whose
 *   lane reads the connection's own setting (D67).
 * - `emitSignal` writes one `signal` row on the entity — `source` is the
 *   manifest id (display text), the claim's own fields and its `payload`
 *   kept whole in `payload`, a cited receipt (this integration's own) as
 *   `refs: ['event:<receiptId>']` — and one `signal.emitted` activity row with no
 *   user and the integration in `meta`, which is how the record timeline
 *   names the plugin (sdk-7a). Evidence, not a fact: it never touches an
 *   attribute. A claim with a `key` is written once per (record,
 *   integration, key), decided under a transaction-scoped advisory lock on
 *   the triple: a re-emit writes nothing and hands back the first id.
 * - `fileDocument` (sdk-8, D52) is a **thin port over core's intake** and
 *   has no pipeline of its own: it validates the claim, opens the plugin's
 *   bytes as a `Readable`, and hands them to `intakeDocumentProgram` with
 *   `source_class 'integration'`, `source_ref` = the bound row and the actor
 *   `{ integrationId }` — so `uploaded_by` and the activity row's
 *   `actor_id` are null and the integration is named by the ref. The size
 *   meter (`MAX_UPLOAD_BYTES`, which no claim field can raise), the digest,
 *   the store write, birth's per-target dedupe and the post-commit
 *   extraction enqueue (core's `Enqueue`, which is why this Layer requires
 *   one) are all intake's and birth's. Nothing here writes a `document` row,
 *   hashes a byte or touches the blob store — copying any of that is how the
 *   plugin lane and the hand upload would drift apart, and the
 *   workspace-rooted greps in `../documents/intake.test.ts` fail naming a
 *   second writer. Targets follow `merged_into_id` to the survivor, as the
 *   interaction lane's edges do.
 * - `logInteraction` with a `recorder` payload (D68) stores the payload as a
 *   receipt with no record before anything else, resolves its participants
 *   through the `MeetingLane`'s participants module, and hands the rest to
 *   `writeRecordedInteraction`, which attaches it to the calendar meeting or
 *   births a call. It writes no note: what the notes become is the host's
 *   landing rules' (D78).
 * - Every interaction write's `interaction.logged` events are dispatched
 *   once it commits.
 */

/**
 * `logMeeting` (SDK 1.5) checks the claim — a bundle is JavaScript — and
 * hands it to the `MeetingLane`, which this Layer requires: the noise rules
 * and the participants module are the arrival lane's, and a second copy of
 * either here is how a calendar attendee and a mail participant would drift
 * apart. Records it creates are created by the body author below.
 *
 * `logEmail` (SDK 1.5) checks and decodes the claim and hands it to the
 * `EmailLane` the same way: the parser, noise rules, exclude list and the
 * body's visibility are the arrival lane's, read from the bound connection.
 */

/** A body written through `logInteraction` is private to its author (D30). */
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

/** A bundle is JavaScript: the claim is checked field by field. */
const emailClaim = z.object({
  providerMessageId: z.string().trim().min(1).max(512),
  raw: z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, 'not base64url'),
  receivedAt: z.iso.datetime({ offset: true }),
  labels: z.array(z.string().trim().max(256)).max(200),
  snippet: z.string().trim().max(1000).optional(),
})

const text = z.string().trim().min(1).max(2000)
const instant = z
  .string()
  .refine((iso) => !Number.isNaN(new Date(iso).getTime()), 'an ISO timestamp')
  .transform((iso) => new Date(iso))

/** What a meeting claim must be, read at runtime; an unknown field is refused. */
const meetingClaim = z.discriminatedUnion('_tag', [
  z
    .object({
      _tag: z.literal('meeting'),
      uid: text,
      eventId: text,
      status: z.enum(['scheduled', 'cancelled']),
      startsAt: instant,
      endsAt: instant,
      subject: z.string().max(2000).optional(),
      organizer: text.optional(),
      conferenceUrl: text.optional(),
      recurringInstanceId: text.optional(),
      attendees: z
        .array(
          z
            .object({
              email: text,
              name: z.string().max(400).optional(),
              rsvp: z.enum([
                'accepted',
                'declined',
                'tentative',
                'needs_action',
              ]),
              self: z.boolean().optional(),
            })
            .strict(),
        )
        .max(1000),
    })
    .strict(),
  z
    .object({
      _tag: z.literal('meeting-cancelled'),
      eventId: text,
      uid: text.optional(),
    })
    .strict(),
])

const blankToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The claim, checked and normalized, or the reason it is not one. */
export const readMeetingClaim = (
  claim: MeetingClaim | MeetingCancellation,
): { ok: true; input: MeetingInput } | { ok: false; reason: string } => {
  const parsed = meetingClaim.safeParse(claim)
  if (!parsed.success)
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || 'claim'}: ${i.message}`)
        .join('; '),
    }
  const c = parsed.data
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

const participantShape = z
  .object({ email: text, name: z.string().max(400).optional() })
  .strict()

const artifactShape = z.union([
  z
    .object({
      role: z.literal('recording_link'),
      url: z.url({ protocol: /^https?$/ }).max(2000),
      title: z.string().max(400).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal(['transcript', 'attachment']),
      documentId: z.uuid(),
    })
    .strict(),
])

const recorderShape = z
  .object({
    providerEventId: text,
    icalUid: text.optional(),
    calendarEventId: text.optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
    raw: jsonValue,
    artifacts: z.array(artifactShape).max(50).optional(),
  })
  .strict()

/** A recorder payload, checked: the writer's keys and artifacts. */
type RecorderInput = {
  providerEventId: string
  icalUid: string | null
  calendarEventId: string | null
  durationSeconds: number | null
  raw: Json
  artifacts: Array<RecordedArtifact>
}

const issuesOf = (error: z.ZodError, at: string) =>
  error.issues
    .map((i) => `${[at, ...i.path.map(String)].join('.')}: ${i.message}`)
    .join('; ')

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
  const people = z
    .array(participantShape)
    .max(1000)
    .safeParse(claim.participants ?? [])
  if (!people.success)
    return { ok: false, reason: issuesOf(people.error, 'participants') }
  const participants = [
    ...new Map(
      people.data.map((p) => {
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
  const parsed = recorderShape.safeParse(claim.recorder)
  if (!parsed.success)
    return { ok: false, reason: issuesOf(parsed.error, 'recorder') }
  const r = parsed.data
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
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
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
      // Provenance is the port's (D52): the claim carries none, and these
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

    // The payload first, whole, before anything it claims is applied (D68).
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
      try: () => jsonValue.parse(signalPayload(claim)),
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
    const read = emailClaim.safeParse(claim)
    if (!read.success) {
      return yield* new JobPermanent({
        reason: `Content.logEmail: ${read.error.issues
          .map(
            (i) => `${i.path.map(String).join('.') || 'claim'}: ${i.message}`,
          )
          .join('; ')}`,
      })
    }
    const raw = Buffer.from(read.data.raw, 'base64url')
    if (raw.length === 0 || raw.length > MAX_EMAIL_BYTES) {
      return yield* new JobPermanent({
        reason: `Content.logEmail: a message of 1 byte to ${MAX_EMAIL_BYTES / 1024 / 1024} MB is required`,
      })
    }
    return yield* (yield* EmailLane).log(
      { integrationId: row.id },
      {
        providerMessageId: read.data.providerMessageId,
        raw,
        receivedAt: new Date(read.data.receivedAt),
        labels: read.data.labels.filter((l) => l.length > 0),
        ...(read.data.snippet ? { snippet: read.data.snippet } : {}),
      },
    )
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
      })
    }),
  )
}
