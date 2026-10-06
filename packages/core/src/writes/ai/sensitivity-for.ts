import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, workspace } from '@spaces/db/schema'
import { resolveSensitivity, workspaceDefaultOf } from '../../ai/sensitivity'
import type { ResolvedSensitivity } from '../../ai/sensitivity'

/**
 * `sensitivityFor(entityId)` — the live read `resolveSensitivity` answers
 * over, one query per job: the record's own `entity.sensitive`, the spaces it
 * is filed in (`entity_space → space`) with every ltree ancestor of one — and,
 * for a space, its own ancestors — and the workspace default from
 * `workspace.settings`.
 *
 * - The binding input is not read yet: `storage_binding` does not exist, so
 *   `null` is passed until it does.
 * - Every egress boundary calls this live — never a cached column.
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
