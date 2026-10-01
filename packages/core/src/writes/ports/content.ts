import { Readable } from 'node:stream'
import { Effect, Layer } from 'effect'
import { asc, eq, inArray, sql } from 'drizzle-orm'
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
  InteractionClaim,
  JobError,
  JsonObject,
  JsonValue,
  SignalClaim,
} from '@spaces/sdk'
import { DOCUMENT_KINDS } from '../../documents'
import { jsonValue } from '../../json'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '../documents/intake'
import { writeIntegrationInteraction } from '../interactions/write'
import type { DocumentFilingTarget } from '../../documents/filing'
import type { Enqueue } from '../../queue/enqueue'
import type { DocumentIntakeFailure } from '../documents/intake'
import type { BodyVisibility } from '../interactions/write'
import type { BoundIntegration } from './binding'
import { integrationMeta } from './identity'

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
 *   grow one. A synced mailbox's body is `private` to the connection's user
 *   (D30), a forwarded one `shared` (D49 — the core mailbox, which does not
 *   come through here). Until a syncer exists (arrival-10) every
 *   plugin-written body is born **`private`**, authored by the bound row's
 *   connection user, else the admin who installed it, else the first admin.
 * - `emitSignal` writes one `signal` row on the entity — `source` is the
 *   manifest id (display text), the claim's own fields and its `payload`
 *   kept whole in `payload` — and one `signal.emitted` activity row with no
 *   user and the integration in `meta`, which is how the record timeline
 *   names the plugin (sdk-7a). Evidence, not a fact: it never touches an
 *   attribute.
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
 */

/** Until arrival-10's syncer decides per connection, a plugin's body is private (D30). */
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
const bodyAuthor = async (integrationId: string): Promise<string | null> => {
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
): Layer.Layer<Content, never, Enqueue> => {
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
  ) {
    const occurredAt = yield* parseTimestamp('logInteraction', claim.occurredAt)
    const edges = yield* survivors(claim.entityIds)
    if (edges.missing.length > 0) {
      return yield* new JobPermanent({
        reason: `Content.logInteraction: no record ${edges.missing.join(', ')}`,
      })
    }
    const messageId = claim.messageId ?? null

    let authorId: string | null = null
    if (claim.body !== undefined) {
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
            edges: edges.ids,
          }),
        ),
      catch: retryable('logInteraction'),
    })
    if (written.kind === 'written')
      return { interactionId: written.interactionId }

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

  const emitSignal = Effect.fn('Content.emitSignal')(function* (
    claim: SignalClaim,
  ) {
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
      catch: retryable('emitSignal'),
    })
    return { signalId }
  })

  return Layer.effect(
    Content,
    Effect.gen(function* () {
      // The extraction enqueue at the end of birth runs on the process's
      // own `Enqueue`, captured once here as `FactsLive` captures it.
      const context = yield* Effect.context<Enqueue>()
      return Content.of({
        fileDocument: (claim) =>
          fileDocument(claim).pipe(Effect.provide(context)),
        logInteraction,
        emitSignal,
      })
    }),
  )
}
