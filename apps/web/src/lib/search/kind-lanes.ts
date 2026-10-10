import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { SearchQueryFailed } from '@spaces/core/writes/read/search'

/**
 * A Records row's kind lane: `company · seed · Proptech › Property ops`.
 * (D70)
 * - `singular` is the object's singular; null for a space or a term, which
 *   belong to no object.
 * - `stage` is the stage word the record carries: a company's funding
 *   stage, a deal's pipeline stage, as their option labels.
 * - `space` is the first space it was filed in, with its ancestors, and
 *   never an archived one.
 */
export type KindLane = {
  singular: string | null
  stage: string | null
  space: string | null
}

/** The attribute that holds each kind's stage word. */
const STAGE_SLUG = { company: 'funding_stage', deal: 'stage' } as const

type LaneRow = {
  id: string
  singular: string | null
  stage: string | null
  space: string | null
}

export const kindLanesProgram = Effect.fn('kindLanesProgram')(function* (
  ids: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, KindLane>, SearchQueryFailed> {
  if (ids.length === 0) return new Map()
  const result = yield* Effect.tryPromise({
    try: () =>
      db.execute<LaneRow>(sql`
        select e.id,
               o.singular,
               (select opt ->> 'label'
                from attribute a
                cross join jsonb_array_elements(a.options -> 'options') opt
                where a.object_id = e.object_id
                  and (
                    (e.kind = 'company' and a.slug = ${STAGE_SLUG.company})
                    or (e.kind = 'deal' and a.slug = ${STAGE_SLUG.deal})
                  )
                  and opt ->> 'id' = e.values ->> a.slug
                limit 1) as stage,
               (select string_agg(ae.canonical_name, ' › ' order by nlevel(anc.path))
                from (
                  select es.space_id
                  from entity_space es
                  join space s on s.entity_id = es.space_id and s.archived_at is null
                  where es.entity_id = e.id
                  order by es.created_at, es.space_id
                  limit 1
                ) filed
                join space fs on fs.entity_id = filed.space_id
                join space anc on anc.path @> fs.path
                join entity ae on ae.id = anc.entity_id) as space
        from entity e
        left join object o on o.id = e.object_id
        where e.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `),
    catch: (cause) => new SearchQueryFailed({ cause }),
  })
  return new Map(
    result.rows.map((r) => [
      r.id,
      { singular: r.singular, stage: r.stage, space: r.space },
    ]),
  )
})
