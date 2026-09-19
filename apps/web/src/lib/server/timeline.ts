import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { condenseBursts } from '@spaces/core/timeline/bursts'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import {
  attributeEvent,
  entity,
  integration,
  interaction,
  interactionEntity,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { requireUser } from './shared'

/**
 * Merged timeline: macro activity + attribute_event bursts. Bursts group
 * consecutive attribute changes by the same actor within 10 minutes —
 * read-time condensing, per CONTEXT.md. The grouping itself is
 * `@spaces/core/timeline/bursts`, which is testable; this file is the
 * queries, which are not.
 *
 * Effect-first as of SPA-70 (the ratchet: an existing module converts when it
 * is open for behavioral change, in the same PR — it is open here because the
 * typed actor gained `actor_ref`). Effect stops at `Effect.runPromise` inside
 * the handler; nothing of it reaches React.
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

const recordTimelineProgram = Effect.fn('recordTimelineProgram')(function* (
  entityId: string,
) {
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
  const capabilityOf = new Map(integrations.map((i) => [i.id, i.capabilityId]))

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

  // Interactions this entity participated in, with co-attendees.
  const myInteractions = yield* query(() =>
    db
      .select({
        id: interaction.id,
        kind: interaction.kind,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
      })
      .from(interactionEntity)
      .innerJoin(
        interaction,
        eq(interaction.id, interactionEntity.interactionId),
      )
      .where(eq(interactionEntity.entityId, entityId))
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
      capabilityId: b.actorRef ? (capabilityOf.get(b.actorRef) ?? null) : null,
      source: b.source,
      at: b.at,
      changes: b.changes,
    })),
    ...myInteractions.map((i) => ({
      type: 'interaction' as const,
      id: i.id,
      kind: i.kind,
      subject: i.subject ?? '',
      at: i.occurredAt.toISOString(),
      attendees: attendeesBy.get(i.id) ?? [],
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))

  return items.slice(0, 60)
})

export const getRecordTimeline = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(recordTimelineProgram(data.entityId))
  })

/** Workspace-wide recent activity — the Today page's feed. */
export const getWorkspaceActivity = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: activity.id,
      verb: activity.verb,
      at: activity.at,
      actorName: user.name,
      subjectId: activity.subjectEntityId,
      subjectName: entity.canonicalName,
      subjectKind: entity.kind,
    })
    .from(activity)
    .leftJoin(user, eq(user.id, activity.actorId))
    .leftJoin(entity, eq(entity.id, activity.subjectEntityId))
    .orderBy(desc(activity.at))
    .limit(15)
  return rows.map((r) => ({
    id: r.id,
    verb: r.verb,
    at: r.at.toISOString(),
    actorName: r.actorName ?? 'System',
    subjectId: r.subjectId,
    subjectName: r.subjectName,
    subjectKind: r.subjectKind,
  }))
})
