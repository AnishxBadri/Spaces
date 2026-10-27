import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { user } from '@spaces/db/schema/auth'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { recordTimelineProgram } from '../timeline/record'
import { jsonString } from '@spaces/core/json'
import { requireUser } from './shared'

/**
 * The timeline server fns. The merged record timeline is its own program;
 * this barrel-exported file holds the auth check and the `Effect.runPromise`
 * seam, and nothing Effect-shaped escapes it.
 */

export const getRecordTimeline = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const viewer = await requireUser()
    return Effect.runPromise(recordTimelineProgram(data.entityId, viewer))
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
      meta: activity.meta,
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
    // What the verb acted on when it is not a record: a filed file's name.
    objectName: jsonString(r.meta.filename),
  }))
})
