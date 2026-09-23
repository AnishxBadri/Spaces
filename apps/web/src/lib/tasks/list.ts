import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, objectDef } from '@spaces/db/schema'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'

/**
 * The /tasks read (CONTEXT.md 15b), outside `lib/server/` so a test can run
 * it without a request — `listTasks` is the request half only. Effect-first
 * since SPA-87 opened it for the focused row (CONTEXT.md "Backend paradigm").
 *
 * Done is a window, not the log: the 50 most recently closed. A Cmd-K hit
 * routes to `/tasks?task=<id>` (15b, "hits route to /tasks with the row
 * focused"), and a hit on a task closed long ago falls outside that window —
 * so `focus` names a task the payload must carry whatever the window holds.
 */

/** How many closed tasks the Done tab lists. */
export const DONE_WINDOW = 50

export class TaskQueryFailed extends Schema.TaggedError<TaskQueryFailed>()(
  'TaskQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TaskQueryFailed({ cause }),
  })

/**
 * The records a task is linked to. `objectSlug` travels with every row —
 * a custom record's page lives under its object's slug, and `recordPath`
 * needs it to build `/o/:slug/:id` instead of dropping the link.
 */
type LinkedEntity = {
  id: string
  name: string
  kind: string
  objectSlug: string | null
}

const taskColumns = {
  id: task.id,
  content: task.content,
  dueDate: task.dueDate,
  assigneeId: task.assigneeId,
  assigneeName: user.name,
  doneAt: task.doneAt,
  createdAt: task.createdAt,
}

export type ListTasksInput = {
  includeDone?: boolean | undefined
  /** A task the payload must carry even outside the Done window. */
  focus?: string | undefined
}

const linkedEntitiesProgram = Effect.fn('linkedEntitiesProgram')(function* (
  taskIds: Array<string>,
): Effect.fn.Return<Map<string, Array<LinkedEntity>>, TaskQueryFailed> {
  const map = new Map<string, Array<LinkedEntity>>()
  if (taskIds.length === 0) return map
  const rows = yield* query(() =>
    db
      .select({
        taskId: taskEntity.taskId,
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(taskEntity)
      .innerJoin(entity, eq(entity.id, taskEntity.entityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(inArray(taskEntity.taskId, taskIds)),
  )
  for (const r of rows) {
    const list = map.get(r.taskId) ?? []
    list.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      objectSlug: r.objectSlug,
    })
    map.set(r.taskId, list)
  }
  return map
})

/** Every read here selects the same row, with the assignee's name. */
const selectTasks = () =>
  db
    .select(taskColumns)
    .from(task)
    .innerJoin(user, eq(user.id, task.assigneeId))
    .$dynamic()

export const listTasksProgram = Effect.fn('listTasksProgram')(function* ({
  includeDone,
  focus,
}: ListTasksInput) {
  const open = yield* query(() =>
    selectTasks()
      .where(isNull(task.doneAt))
      .orderBy(asc(task.dueDate), asc(task.createdAt)),
  )
  const recent = includeDone
    ? yield* query(() =>
        selectTasks()
          .where(isNotNull(task.doneAt))
          .orderBy(desc(task.doneAt))
          .limit(DONE_WINDOW),
      )
    : []
  // An open task is always in `open` — only Done is capped. A closed one
  // outside the window is fetched by id and appended: it is older than every
  // row the window holds, so `done_at desc` still reads true. An unknown id
  // fetches nothing and the page renders unfocused.
  const outside =
    includeDone &&
    focus !== undefined &&
    !open.some((t) => t.id === focus) &&
    !recent.some((t) => t.id === focus)
      ? yield* query(() =>
          selectTasks()
            .where(and(eq(task.id, focus), isNotNull(task.doneAt)))
            .limit(1),
        )
      : []
  const done = [...recent, ...outside]
  const all = [...open, ...done]
  const links = yield* linkedEntitiesProgram(all.map((t) => t.id))
  const serialize = (t: (typeof all)[number]) => ({
    ...t,
    doneAt: t.doneAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    entities: links.get(t.id) ?? [],
  })
  return { open: open.map(serialize), done: done.map(serialize) }
})
