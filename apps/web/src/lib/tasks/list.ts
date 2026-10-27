import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, objectDef } from '@spaces/db/schema'
import { task, taskEntity } from '@spaces/db/schema/tasks'
import { user } from '@spaces/db/schema/auth'
import type { DueDay } from './due'

/**
 * The /tasks read, outside the server-fn barrel so a test can run it without
 * a request — `listTasks` is the request half only.
 *
 * Done is a window, not the log: the 50 most recently closed. A Cmd-K hit
 * routes to `/tasks?task=<id>`, and a task closed long ago falls outside the
 * window — so `focus` names a task the payload must carry regardless.
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
  /** AI never reads it; Today marks the row with a lock. */
  sensitive: boolean
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
  /** Only the tasks linked to this record. */
  record?: string | undefined
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
        sensitive: entity.sensitive,
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
      sensitive: r.sensitive,
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

/** The record a `record` filter names, by its name; null for an unknown id. */
export type TaskScope = { id: string; name: string; kind: string }

export const listTasksProgram = Effect.fn('listTasksProgram')(function* ({
  includeDone,
  focus,
  record,
}: ListTasksInput) {
  // The Done window is the record's own 50 when the list is narrowed to it,
  // not the workspace's 50 filtered after the cut.
  const linked =
    record === undefined
      ? undefined
      : sql`exists (select 1 from ${taskEntity} where ${taskEntity.taskId} = ${task.id} and ${taskEntity.entityId} = ${record})`
  const open = yield* query(() =>
    selectTasks()
      .where(and(isNull(task.doneAt), linked))
      .orderBy(asc(task.dueDate), asc(task.createdAt)),
  )
  const recent = includeDone
    ? yield* query(() =>
        selectTasks()
          .where(and(isNotNull(task.doneAt), linked))
          .orderBy(desc(task.doneAt))
          .limit(DONE_WINDOW),
      )
    : []
  const scope: TaskScope | null =
    record === undefined
      ? null
      : ((yield* query(() =>
          db
            .select({
              id: entity.id,
              name: entity.canonicalName,
              kind: entity.kind,
            })
            .from(entity)
            .where(eq(entity.id, record))
            .limit(1),
        )).at(0) ?? null)
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
            .where(and(eq(task.id, focus), isNotNull(task.doneAt), linked))
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
  return {
    open: open.map(serialize),
    done: done.map(serialize),
    record: scope,
  }
})

/**
 * Open tasks with a due date, counted per day up to tomorrow: the overdue
 * ones and every day a reader's clock could call today.
 */
export const dueDaysProgram = Effect.fn('dueDaysProgram')(
  function* (): Effect.fn.Return<Array<DueDay>, TaskQueryFailed> {
    const rows = yield* query(() =>
      db
        .select({ day: task.dueDate, n: count() })
        .from(task)
        .where(
          and(isNull(task.doneAt), lte(task.dueDate, sql`current_date + 1`)),
        )
        .groupBy(task.dueDate),
    )
    return rows.flatMap((r) => (r.day === null ? [] : [{ day: r.day, n: r.n }]))
  },
)
