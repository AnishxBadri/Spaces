import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { condenseBursts } from '@spaces/core/timeline/bursts'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  attributeEvent,
  document,
  entity,
  integration,
  interaction,
  interactionDocument,
  interactionEntity,
  link,
  note,
} from '@spaces/db/schema'
import type { InteractionMeta } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { investment } from '@spaces/db/schema/portfolio'
import { jsonRecord, jsonString, jsonStrings } from '@spaces/core/json'
import { sinceRemoved } from '@spaces/core/plugins/registry'
import { canRead } from '@spaces/core/read-policy'
import { emailListing } from '@spaces/core/interactions/email-listing'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'
import type { Json } from '@spaces/core/json'
import { resolveRefsProgram } from '@spaces/core/writes/context/names'
import type { ResolvedRef } from '@spaces/core/writes/context/names'

/**
 * Merged timeline: macro activity + attribute_event bursts. Bursts group
 * consecutive attribute changes by the same actor within 10 minutes —
 * read-time condensing, per CONTEXT.md. The grouping itself is
 * `@spaces/core/timeline/bursts`, which is testable; this file is the
 * queries.
 *
 * Effect-first as of SPA-70 (the ratchet: an existing module converts when it
 * is open for behavioral change, in the same PR — it was open there because
 * the typed actor gained `actor_ref`). Effect stops at `Effect.runPromise`
 * inside the server fn; nothing of it reaches React.
 *
 * Out here rather than in `server/timeline.ts` since SPA-137, on the pattern
 * of `lib/entities/delete.ts` and `lib/notes/delete.ts`: `src/lib/
 * server-fns.ts` re-exports every `server/*` module wholesale to the client
 * (CLAUDE.md → Traps), so an exported Effect program in that folder would
 * drag Effect and the pg client into the browser bundle. Here it is
 * importable by the server fn and by the suite, and by nothing the client
 * sees — which is what lets a test assert that a logged interaction reaches
 * the record timeline.
 */

class TimelineQueryFailed extends Schema.TaggedError<TimelineQueryFailed>()(
  'TimelineQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TimelineQueryFailed({ cause }),
  })

export const recordTimelineProgram = Effect.fn('recordTimelineProgram')(
  function* (entityId: string, viewer: { id: string }) {
    const users = yield* query(() =>
      db.select({ id: user.id, name: user.name }).from(user),
    )
    const userNames = new Map(users.map((u) => [u.id, u.name]))

    // A name, not the integration id: "Apollo changed sector" is what the
    // reader needs, and the row id is the join, not the name (sdk-9). The
    // manifest's `name` once the loader has validated the plugin
    // (`integration.manifest`, sdk-11); the capability id before that, and
    // for a first-party `core.*` row, which has no manifest. An uninstalled
    // plugin keeps its row, so what it wrote reads "Apollo, since removed".
    const integrations = yield* query(() =>
      db
        .select({
          id: integration.id,
          capabilityId: integration.capabilityId,
          manifest: integration.manifest,
          removedAt: integration.removedAt,
        })
        .from(integration),
    )
    const integrationNames = new Map(
      integrations.map((i) => [
        i.id,
        sinceRemoved(
          jsonString(jsonRecord(i.manifest).name) ?? i.capabilityId,
          i.removedAt,
        ),
      ]),
    )

    const macros = yield* query(() =>
      db
        .select({
          id: activity.id,
          verb: activity.verb,
          actorId: activity.actorId,
          meta: activity.meta,
          at: activity.at,
        })
        .from(activity)
        .where(eq(activity.subjectEntityId, entityId))
        .orderBy(desc(activity.at))
        .limit(80),
    )

    const events = yield* query(() =>
      db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, entityId))
        .orderBy(desc(attributeEvent.at))
        .limit(200),
    )
    const bursts = condenseBursts(events)

    // Every change's receipts, resolved in one pass (`names.ts` — one query
    // per ref kind) so the timeline ships labels and the component renders
    // strings. A ref whose target was deleted comes back `missing`.
    const resolved = yield* resolveRefsProgram(
      bursts.flatMap((b) => b.changes.flatMap((c) => c.refs)),
    ).pipe(Effect.mapError((cause) => new TimelineQueryFailed({ cause })))
    let at = 0
    const changesOf: Array<
      Array<{ slug: string; to: Json | null; citations: Array<ResolvedRef> }>
    > = bursts.map((b) =>
      b.changes.map((c) => ({
        slug: c.slug,
        to: c.to,
        citations: resolved.slice(at, (at += c.refs.length)),
      })),
    )

    // Whose interactions this timeline reads. A record reads its own; a deal
    // also reads its company's and its contacts' (D49, SPA-56): a thread
    // reaches a deal by derivation, never by an edge written at arrival, so
    // a company carrying two deals shows every thread on both. The deal's
    // own edges still count — the one explicit pin D49 keeps.
    const self = (yield* query(() =>
      db
        .select({ kind: entity.kind, values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId)),
    )).at(0)
    const kind = self?.kind
    const derived =
      kind === 'deal'
        ? (yield* query(() =>
            db
              .select({ id: link.toEntityId })
              .from(link)
              .where(
                and(
                  eq(link.fromEntityId, entityId),
                  eq(link.relation, 'references'),
                  inArray(link.attrSlug, ['company', 'people']),
                ),
              ),
          )).map((r) => r.id)
        : []
    const readFrom = [...new Set([entityId, ...derived])]

    // Interactions this entity participated in, with co-attendees.
    const myInteractions = yield* query(() =>
      db
        .selectDistinct({
          id: interaction.id,
          kind: interaction.kind,
          subject: interaction.subject,
          occurredAt: interaction.occurredAt,
          // The write-up, when there is one (SPA-123). Null is the ordinary
          // case — a meeting logged in twenty seconds has no body — and the
          // row renders exactly as it did before.
          noteId: interaction.noteId,
          sourceRef: interaction.sourceRef,
          meta: interaction.meta,
          hasAttachments: hasAttachmentsSql(),
        })
        .from(interactionEntity)
        .innerJoin(
          interaction,
          eq(interaction.id, interactionEntity.interactionId),
        )
        .where(inArray(interactionEntity.entityId, readFrom))
        .orderBy(desc(interaction.occurredAt))
        .limit(50),
    )
    const interactionIds = myInteractions.map((i) => i.id)
    const attendees =
      interactionIds.length > 0
        ? yield* query(() =>
            db
              .select({
                interactionId: interactionEntity.interactionId,
                entityId: entity.id,
                name: entity.canonicalName,
                kind: entity.kind,
              })
              .from(interactionEntity)
              .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
              .where(inArray(interactionEntity.interactionId, interactionIds)),
          )
        : []
    // The row's end lane: who logged it or which integration wrote it, and
    // how many attachments hang off it.
    const loggers =
      interactionIds.length > 0
        ? yield* query(() =>
            db
              .select({
                interactionId: sql<string>`${activity.meta} ->> 'interactionId'`,
                actorId: activity.actorId,
              })
              .from(activity)
              .where(
                and(
                  like(activity.verb, 'interaction.%'),
                  isNotNull(activity.actorId),
                  inArray(
                    sql<string>`${activity.meta} ->> 'interactionId'`,
                    interactionIds,
                  ),
                ),
              ),
          )
        : []
    const loggedBy = new Map(
      loggers.flatMap((l) => {
        const name = l.actorId ? userNames.get(l.actorId) : undefined
        return name === undefined ? [] : [[l.interactionId, name] as const]
      }),
    )
    const attachmentRows =
      interactionIds.length > 0
        ? yield* query(() =>
            db
              .select({
                interactionId: interactionDocument.interactionId,
                n: sql<number>`count(*)::int`,
              })
              .from(interactionDocument)
              .innerJoin(
                document,
                eq(document.entityId, interactionDocument.documentId),
              )
              .where(
                and(
                  inArray(interactionDocument.interactionId, interactionIds),
                  eq(interactionDocument.role, 'attachment'),
                  // Only the attachments the viewer may read are counted.
                  canReadDocumentSql(viewer.id),
                ),
              )
              .groupBy(interactionDocument.interactionId),
          )
        : []
    const attachmentsBy = new Map(
      attachmentRows.map((r) => [r.interactionId, r.n]),
    )
    // canRead on every write-up: a body the viewer may not read is not
    // linked, and its row says so. Subject, participants and date stay; an
    // email its owner widened to the viewer reads like their own (D67).
    const noteIds = myInteractions.flatMap((i) =>
      i.noteId === null ? [] : [i.noteId],
    )
    const bodies =
      noteIds.length > 0
        ? yield* query(() =>
            db
              .select({
                id: note.entityId,
                visibility: note.visibility,
                authorId: note.authorId,
                widened: noteWidenedSql(viewer.id),
              })
              .from(note)
              .where(inArray(note.entityId, noteIds)),
          )
        : []
    const unreadable = new Set(
      bodies.filter((b) => !canRead(viewer, b)).map((b) => b.id),
    )
    // The viewer's own private bodies: what their Interactions `···` widens.
    const ownPrivate = new Set(
      bodies
        .filter((b) => b.visibility === 'private' && b.authorId === viewer.id)
        .map((b) => b.id),
    )
    // A person's own emails, so a meeting row can say how they answered.
    const ownEmails =
      kind === 'person' && self ? jsonStrings(self.values.emails) : []

    // A deal's checks, read off the ledger by `deal_id`: each original with
    // the instant it was voided, so History can strike it. (D12)
    const checks =
      kind === 'deal'
        ? yield* query(() =>
            db
              .select({
                id: investment.id,
                reversesId: investment.reversesId,
                amount: investment.amount,
                currency: investment.currency,
                instrument: investment.instrument,
                date: investment.date,
                createdBy: investment.createdBy,
                createdAt: investment.createdAt,
              })
              .from(investment)
              .where(eq(investment.dealId, entityId)),
          )
        : []
    const checkIds = checks.map((c) => c.id)
    const reversals =
      checkIds.length > 0
        ? yield* query(() =>
            db
              .select({
                reversesId: investment.reversesId,
                createdAt: investment.createdAt,
              })
              .from(investment)
              .where(inArray(investment.reversesId, checkIds)),
          )
        : []
    const voidedAt = new Map(
      reversals.flatMap((r) =>
        r.reversesId === null
          ? []
          : [[r.reversesId, r.createdAt.toISOString()] as const],
      ),
    )

    const attendeesBy = new Map<
      string,
      Array<{ id: string; name: string; kind: string }>
    >()
    for (const a of attendees) {
      if (a.entityId === entityId) continue
      attendeesBy.set(a.interactionId, [
        ...(attendeesBy.get(a.interactionId) ?? []),
        { id: a.entityId, name: a.name, kind: a.kind },
      ])
    }

    const items = [
      ...macros
        .filter(
          (m) =>
            !['company.updated', 'person.updated'].includes(m.verb) &&
            !m.verb.startsWith('interaction.'),
        )
        .map((m) => ({
          type: 'macro' as const,
          id: m.id,
          verb: m.verb,
          // A plugin's port writes its activity with no user (sdk-7a): the
          // integration it ran as is in `meta.integrationId`, and the row
          // reads as that plugin's name, never as a person.
          actorName: m.actorId
            ? (userNames.get(m.actorId) ?? null)
            : (integrationNames.get(
                jsonString(jsonRecord(m.meta).integrationId) ?? '',
              ) ?? null),
          at: m.at.toISOString(),
        })),
      ...bursts.map((b, i) => ({
        type: 'attrs' as const,
        id: `burst-${i}`,
        actorType: b.actorType,
        actorName: b.actor ? (userNames.get(b.actor) ?? null) : null,
        /**
         * The integration's manifest name, else its capability id. Null for
         * every non-integration burst, and — the check constraint being a
         * biconditional — never null for an integration one unless the join
         * misses, which the FK prevents.
         */
        integrationName: b.actorRef
          ? (integrationNames.get(b.actorRef) ?? null)
          : null,
        source: b.source,
        at: b.at,
        changes: changesOf[i],
      })),
      ...myInteractions.map((i) => {
        const privateBody = i.noteId !== null && unreadable.has(i.noteId)
        // Body-derived, so private with the body (D67).
        const listing = emailListing(i.meta, !privateBody)
        return {
          type: 'interaction' as const,
          id: i.id,
          kind: i.kind,
          subject: i.subject ?? '',
          noteId: privateBody ? null : i.noteId,
          /** The write-up exists and is private to someone else. */
          privateBody,
          /** The write-up is the viewer's own and private by default. */
          ownPrivate: i.noteId !== null && ownPrivate.has(i.noteId),
          at: i.occurredAt.toISOString(),
          attendees: attendeesBy.get(i.id) ?? [],
          via: i.sourceRef
            ? (integrationNames.get(i.sourceRef) ?? null)
            : (loggedBy.get(i.id) ?? null),
          // Attachments are private with the body (D67): no count, no filter.
          attachments: privateBody ? 0 : (attachmentsBy.get(i.id) ?? 0),
          hasAttachments: !privateBody && i.hasAttachments,
          answer: meetingAnswer(i.meta, ownEmails),
          /** The cached one-line summary; null until a lane writes one. */
          summary: listing.summary,
          /** The mailbox's preview, shown unmarked when there is no summary. */
          snippet: listing.snippet,
          categories: listing.categories,
        }
      }),
      ...checks
        .filter((c) => c.reversesId === null)
        .map((c) => ({
          type: 'ledger' as const,
          id: c.id,
          verb: 'investment.added',
          actorName: c.createdBy ? (userNames.get(c.createdBy) ?? null) : null,
          amount: Number(c.amount),
          currency: c.currency,
          instrument: c.instrument,
          date: c.date,
          voidedAt: voidedAt.get(c.id) ?? null,
          at: c.createdAt.toISOString(),
        })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1))

    return items.slice(0, 60)
  },
)

/**
 * Whether an interaction carries an attachment: the "has attachments" filter,
 * an exists over `interaction_document`.
 */
export const hasAttachmentsSql = (): SQL<boolean> =>
  // Qualified by hand: drizzle drops the table name in a one-table select,
  // and an unqualified `id` inside the subquery would bind to the wrong row.
  sql<boolean>`exists (select 1 from interaction_document d where d.interaction_id = "interaction"."id" and d.role = 'attachment')`

/**
 * The word a meeting row ends on: `cancelled`, else how this person
 * answered the invite. Null for an email or a call, and for no answer yet.
 */
export function meetingAnswer(
  meta: InteractionMeta | null,
  ownEmails: ReadonlyArray<string>,
): string | null {
  if (meta?.kind !== 'meeting') return null
  if (meta.status === 'cancelled') return 'cancelled'
  const own = new Set(ownEmails.map((e) => e.toLowerCase()))
  for (const [email, answer] of Object.entries(meta.rsvp)) {
    if (own.has(email.toLowerCase()) && answer !== 'needs_action') return answer
  }
  return null
}
