import { Effect, Schema } from 'effect'
import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk } from '@spaces/db/schema'
import { SensitivityReadFailed, sensitivityFor } from './sensitivity-for'
import type { SQL } from 'drizzle-orm'
import type { Tx } from '../attributes/values'
import type {
  SensitivityEntityNotFound,
  SensitivityRead,
} from './sensitivity-for'

/**
 * The only module that writes `chunk.sensitive`, a cache of the resolver so
 * retrieval can filter in SQL before scoring.
 * - `stampSensitivity` writes the live answer onto an entity's chunks (embed
 *   job, `sensitivity.restamp` job).
 * - `raiseSensitivity` runs inside the transaction that writes a sensitivity
 *   input. Raising needs no resolver (the OR can only go up); lowering is a
 *   job that resolves live, since another input may still hold it.
 * - The routing boundary never reads this column: `complete()` and `embed()`
 *   resolve live, because a stale cache where bytes leave the box is a leak.
 */

export class StampWriteFailed extends Schema.TaggedError<StampWriteFailed>()(
  'StampWriteFailed',
  { cause: Schema.Defect() },
) {}

export type StampOptions = {
  /** Committed in the same transaction as the stamp, before it. */
  within?: (tx: Tx) => Promise<void>
}

export type StampResult = SensitivityRead & {
  /** Rows whose flag this call changed. */
  stamped: number
}

export const stampSensitivity = Effect.fn('stampSensitivity')(function* (
  entityId: string,
  opts: StampOptions = {},
): Effect.fn.Return<
  StampResult,
  SensitivityReadFailed | SensitivityEntityNotFound | StampWriteFailed
> {
  const resolved = yield* sensitivityFor(entityId)
  const sensitive = resolved.sensitivity === 'sensitive'
  const stamped = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        if (opts.within) await opts.within(tx)
        const rows = await tx
          .update(chunk)
          .set({ sensitive })
          .where(
            and(eq(chunk.entityId, entityId), ne(chunk.sensitive, sensitive)),
          )
          .returning({ id: chunk.id })
        return rows.length
      }),
    catch: (cause) => new StampWriteFailed({ cause }),
  })
  return { ...resolved, stamped }
})

/** Which entities a change of one sensitivity input reaches. */
export type StampScope =
  /**
   * A record's own flag: the record, and — for a space — every entity filed
   * in it or a descendant space, and the descendant spaces themselves.
   */
  | { kind: 'flagged'; entityId: string }
  /** One entity filed into, or out of, one space. */
  | { kind: 'filed'; entityId: string; spaceId: string }
  /**
   * A space moved: the reach of `flagged`, raised when the space or any
   * ancestor at its current path is sensitive.
   */
  | { kind: 'moved'; spaceId: string }
  /** Every document a storage binding brought, raised when it is sensitive. */
  | { kind: 'binding'; bindingId: string }
  /** One document, raised when the binding that brought it is sensitive. */
  | { kind: 'bound'; entityId: string }
  /** Every chunk, raised when the workspace default is sensitive. */
  | { kind: 'workspace' }

/** The entity ids a `flagged` scope reaches. */
const flaggedReach = (entityId: string): SQL => sql`(
  select ${entityId}::uuid
  union
  select es.entity_id
  from entity_space es
  join space s on s.entity_id = es.space_id
  join space root on root.entity_id = ${entityId}::uuid
  where root.path @> s.path
  union
  select s.entity_id
  from space s
  join space root on root.entity_id = ${entityId}::uuid
  where root.path @> s.path
)`

/** True when the scope's input is sensitive now, so the raise may stamp. */
const inputSensitive = (scope: StampScope): SQL => {
  switch (scope.kind) {
    case 'flagged':
      return sql`exists (
        select 1 from entity e
        where e.id = ${scope.entityId}::uuid and e.sensitive
      )`
    case 'filed':
    case 'moved':
      return sql`exists (
        select 1
        from space filed
        join space anc on anc.path @> filed.path
        join entity ae on ae.id = anc.entity_id
        where filed.entity_id = ${scope.spaceId}::uuid and ae.sensitive
      )`
    case 'binding':
      return sql`exists (
        select 1 from storage_binding sb
        where sb.id = ${scope.bindingId}::uuid and sb.sensitivity = 'sensitive'
      )`
    case 'bound':
      return sql`exists (
        select 1
        from document d
        join storage_binding sb on sb.id = d.binding_id
        where d.entity_id = ${scope.entityId}::uuid
          and sb.sensitivity = 'sensitive'
      )`
    case 'workspace':
      return sql`exists (
        select 1 from workspace w
        where w.settings ->> 'sensitivity_default' = 'sensitive'
      )`
  }
}

const reach = (scope: StampScope): SQL => {
  switch (scope.kind) {
    case 'flagged':
      return sql`${chunk.entityId} in ${flaggedReach(scope.entityId)}`
    case 'moved':
      return sql`${chunk.entityId} in ${flaggedReach(scope.spaceId)}`
    case 'filed':
    case 'bound':
      return sql`${chunk.entityId} = ${scope.entityId}::uuid`
    case 'binding':
      return sql`${chunk.entityId} in (
        select d.entity_id from document d
        where d.binding_id = ${scope.bindingId}::uuid
      )`
    case 'workspace':
      return sql`true`
  }
}

/**
 * The set-based raise: every chunk in the scope goes `sensitive = true`, in
 * one statement, when the scope's input is sensitive — a record's own flag
 * for `flagged`, the space or one of its ancestors for `filed` and `moved`,
 * the binding for `binding` and `bound`, the default for `workspace`. A
 * no-op otherwise, so a caller runs it after every write of an input.
 * Answers the rows it changed.
 */
export async function raiseSensitivity(
  tx: Tx,
  scope: StampScope,
): Promise<number> {
  const rows = await tx
    .update(chunk)
    .set({ sensitive: true })
    .where(and(eq(chunk.sensitive, false), reach(scope), inputSensitive(scope)))
    .returning({ id: chunk.id })
  return rows.length
}

/**
 * The entities in the scope that own a chunk stamped `sensitive = true` —
 * the ones a lowering must hand to the `sensitivity.restamp` job. An entity
 * with nothing stamped has nothing to lower.
 */
export async function stampedSensitive(
  reader: Tx | typeof db,
  scope: StampScope,
): Promise<Array<string>> {
  const rows = await reader
    .selectDistinct({ entityId: chunk.entityId })
    .from(chunk)
    .where(and(eq(chunk.sensitive, true), reach(scope)))
  return rows.map((r) => r.entityId)
}

/**
 * The lowering after the workspace default goes back to normal: every
 * entity still stamped sensitive, restamped from the live resolver one by
 * one. An entity gone meanwhile is skipped. Answers how many entities it
 * read and how many chunk rows changed.
 */
export const restampStampedProgram = Effect.fn('restampStamped')(
  function* (): Effect.fn.Return<
    { entities: number; stamped: number },
    SensitivityReadFailed | StampWriteFailed
  > {
    const ids = yield* Effect.tryPromise({
      try: () => stampedSensitive(db, { kind: 'workspace' }),
      catch: (cause) => new SensitivityReadFailed({ cause }),
    })
    let stamped = 0
    for (const id of ids) {
      const r = yield* stampSensitivity(id).pipe(
        Effect.catchTag('SensitivityEntityNotFound', () =>
          Effect.succeed(null),
        ),
      )
      if (r !== null) stamped += r.stamped
    }
    return { entities: ids.length, stamped }
  },
)
