import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, workspace } from '@spaces/db/schema'
import { resolveSensitivity, workspaceDefaultOf } from './sensitivity'
import type { ResolvedSensitivity } from './sensitivity'

/**
 * `sensitivityFor(entityId)` — the live read `resolveSensitivity` answers
 * over (SPA-61). One query per job: the record's own `entity.sensitive`, the
 * spaces it is filed in (`entity_space → space`) with every ltree ancestor
 * of one (`path @>`) — and, when the record is itself a space, its own
 * ancestors — each carrying its `entity.sensitive`, and the workspace
 * default from `workspace.settings`, the same bag `base_currency` lives in.
 *
 * The binding input is not read: `storage_binding` and `document.binding_id`
 * are storage-8a's migration, which has not landed. The resolver already
 * takes the binding (and is tested with it); when storage-8a lands, this
 * query joins `document.binding_id → storage_binding.sensitivity` and passes
 * it instead of `null`.
 *
 * Every egress boundary calls this live — never a cached column. Exported
 * for SPA-90's deck reader and every later lane.
 */

export class SensitivityReadFailed extends Schema.TaggedError<SensitivityReadFailed>()(
  'SensitivityReadFailed',
  { cause: Schema.Defect() },
) {}

export class SensitivityEntityNotFound extends Schema.TaggedError<SensitivityEntityNotFound>()(
  'SensitivityEntityNotFound',
  { entityId: Schema.String },
) {}

type SpaceInput = { name: string; sensitive: boolean }

export type SensitivityRead = ResolvedSensitivity & { own: boolean }

export const sensitivityFor = Effect.fn('sensitivityFor')(function* (
  entityId: string,
): Effect.fn.Return<
  SensitivityRead,
  SensitivityReadFailed | SensitivityEntityNotFound
> {
  const row = (yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          own: entity.sensitive,
          workspaceDefault: sql<
            string | null
          >`(select ${workspace.settings} ->> 'sensitivity_default' from ${workspace} limit 1)`,
          // Nearest first, so `via` names the closest sensitive space.
          spaces: sql<Array<SpaceInput>>`coalesce((
            select json_agg(
              json_build_object('name', ae.canonical_name, 'sensitive', ae.sensitive)
              order by nlevel(anc.path) desc, ae.canonical_name
            )
            from space anc
            join entity ae on ae.id = anc.entity_id
            where anc.entity_id <> ${entityId}::uuid
              and exists (
                select 1 from space filed
                where anc.path @> filed.path
                  and (
                    filed.entity_id = ${entityId}::uuid
                    or filed.entity_id in (
                      select es.space_id from entity_space es
                      where es.entity_id = ${entityId}::uuid
                    )
                  )
              )
          ), '[]'::json)`,
        })
        .from(entity)
        .where(eq(entity.id, entityId))
        .limit(1),
    catch: (cause) => new SensitivityReadFailed({ cause }),
  })).at(0)
  if (!row) return yield* new SensitivityEntityNotFound({ entityId })
  return {
    own: row.own,
    ...resolveSensitivity({
      own: row.own,
      spaces: row.spaces,
      binding: null, // storage-8a: storage_binding does not exist yet
      workspaceDefault: workspaceDefaultOf(row.workspaceDefault),
    }),
  }
})

/**
 * Write a record's own flag — the one write `entity.sensitive` has. Any
 * member may flag a record. Inheritance never writes a row: a company filed
 * under a sensitive space keeps `sensitive = false` and resolves sensitive
 * at read. And this is an egress flag, never access control — `canRead`
 * stays the only thing that hides a row from a user.
 */
export const setEntitySensitiveProgram = Effect.fn('setEntitySensitive')(
  function* (
    entityId: string,
    sensitive: boolean,
  ): Effect.fn.Return<
    SensitivityRead,
    SensitivityReadFailed | SensitivityEntityNotFound
  > {
    const updated = yield* Effect.tryPromise({
      try: () =>
        db
          .update(entity)
          .set({ sensitive })
          .where(eq(entity.id, entityId))
          .returning({ id: entity.id }),
      catch: (cause) => new SensitivityReadFailed({ cause }),
    })
    if (updated.length === 0)
      return yield* new SensitivityEntityNotFound({ entityId })
    return yield* sensitivityFor(entityId)
  },
)
