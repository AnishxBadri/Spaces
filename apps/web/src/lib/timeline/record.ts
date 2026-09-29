import { Effect, Schema } from 'effect'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { condenseBursts } from '@spaces/core/timeline/bursts'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  attributeEvent,
  entity,
  integration,
  interaction,
  interactionEntity,
  link,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import type { Json } from '@spaces/core/json'
import { resolveRefsProgram } from '#/lib/context/names'
import type { ResolvedRef } from '#/lib/context/names'

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
  function* (entityId: string) {
    const users = yield* query(() =>
      db.select({ id: user.id, name: user.name }).from(user),
    )
    const userNames = new Map(users.map((u) => [u.id, u.name]))

    // Capability id, not integration id: "apollo changed sector" is what the
    // reader needs, and the row id is the join, not the name.
    const integrations = yield* query(() =>
      db
        .select({ id: integration.id, capabilityId: integration.capabilityId })
        .from(integration),
    )
    const capabilityOf = new Map(
      integrations.map((i) => [i.id, i.capabilityId]),
    )

    const macros = yield* query(() =>
      db
        .select({
          id: activity.id,
          verb: activity.verb,
          actorId: activity.actorId,
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
    const kind = (yield* query(() =>
      db
        .select({ kind: entity.kind })
        .from(entity)
        .where(eq(entity.id, entityId)),
    )).at(0)?.kind
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
          actorName: m.actorId ? (userNames.get(m.actorId) ?? null) : null,
          at: m.at.toISOString(),
        })),
      ...bursts.map((b, i) => ({
        type: 'attrs' as const,
        id: `burst-${i}`,
        actorType: b.actorType,
        actorName: b.actor ? (userNames.get(b.actor) ?? null) : null,
        /**
         * The integration's manifest id. Null for every non-integration burst,
         * and — the check constraint being a biconditional — never null for an
         * integration one unless the join misses, which the FK prevents.
         */
        capabilityId: b.actorRef
          ? (capabilityOf.get(b.actorRef) ?? null)
          : null,
        source: b.source,
        at: b.at,
        changes: changesOf[i],
      })),
      ...myInteractions.map((i) => ({
        type: 'interaction' as const,
        id: i.id,
        kind: i.kind,
        subject: i.subject ?? '',
        noteId: i.noteId,
        at: i.occurredAt.toISOString(),
        attendees: attendeesBy.get(i.id) ?? [],
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1))

    return items.slice(0, 60)
  },
)
