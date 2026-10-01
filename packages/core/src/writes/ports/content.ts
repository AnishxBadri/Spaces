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
  InteractionClaim,
  JsonObject,
  JsonValue,
  SignalClaim,
} from '@spaces/sdk'
import { jsonValue } from '../../json'
import { writeIntegrationInteraction } from '../interactions/write'
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
 *
 * `fileDocument` is sdk-8's (a thin port over the documents intake); until
 * it lands the method fails permanently rather than half-filing bytes.
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

export const ContentLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
): Layer.Layer<Content> => {
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

  return Layer.succeed(
    Content,
    Content.of({
      fileDocument: () =>
        Effect.fail(
          new JobPermanent({
            reason:
              'Content.fileDocument is not implemented yet (sdk-8: a thin port over the documents intake)',
          }),
        ),
      logInteraction,
      emitSignal,
    }),
  )
}
