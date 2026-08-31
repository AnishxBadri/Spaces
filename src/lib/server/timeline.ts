import { createServerFn } from '@tanstack/react-start'
import { desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
import { entity, interaction, interactionEntity } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { requireUser } from './shared'
import type { Json } from './shared'

/**
 * Merged timeline: macro activity + attribute_event bursts. Bursts group
 * consecutive attribute changes by the same actor within 10 minutes —
 * read-time condensing, per CONTEXT.md.
 */
export const getRecordTimeline = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { attributeEvent } = await import('#/db/schema')

    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const userNames = new Map(users.map((u) => [u.id, u.name]))

    const macros = await db
      .select({
        id: activity.id,
        verb: activity.verb,
        actorId: activity.actorId,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.entityId))
      .orderBy(desc(activity.at))
      .limit(80)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, data.entityId))
      .orderBy(desc(attributeEvent.at))
      .limit(200)

    const GAP_MS = 10 * 60 * 1000
    type Burst = {
      type: 'attrs'
      actor: string | null
      at: string
      changes: Array<{ slug: string; to: Json }>
    }
    const bursts: Array<Burst> = []
    for (const ev of events) {
      const last = bursts.at(-1)
      if (
        last &&
        last.actor === (ev.actorId ?? null) &&
        new Date(last.at).getTime() - ev.at.getTime() < GAP_MS
      ) {
        last.changes.push({ slug: ev.attrSlug, to: ev.to as Json })
      } else {
        bursts.push({
          type: 'attrs',
          actor: ev.actorId ?? null,
          at: ev.at.toISOString(),
          changes: [{ slug: ev.attrSlug, to: ev.to as Json }],
        })
      }
    }

    // Interactions this entity participated in, with co-attendees.
    const myInteractions = await db
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
      .where(eq(interactionEntity.entityId, data.entityId))
      .orderBy(desc(interaction.occurredAt))
      .limit(50)
    const interactionIds = myInteractions.map((i) => i.id)
    const attendees =
      interactionIds.length > 0
        ? await db
            .select({
              interactionId: interactionEntity.interactionId,
              entityId: entity.id,
              name: entity.canonicalName,
              kind: entity.kind,
            })
            .from(interactionEntity)
            .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
            .where(inArray(interactionEntity.interactionId, interactionIds))
        : []
    const attendeesBy = new Map<
      string,
      Array<{ id: string; name: string; kind: string }>
    >()
    for (const a of attendees) {
      if (a.entityId === data.entityId) continue
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
        actorName: b.actor ? (userNames.get(b.actor) ?? null) : null,
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
