import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { interactionEntity, interactionStat } from '@spaces/db/schema'
import type { Tx } from '../entities/resolve'

/**
 * `interaction_stat` upkeep: first, last and next interaction per entity and
 * kind, plus `any` (D67).
 * - Recomputed from the interactions, never patched: a write hands over the
 *   entities it touched and their rows are rebuilt from every edge they hold.
 * - Runs in the caller's transaction, so a rolled-back interaction leaves the
 *   stats as they were.
 * - A cancelled meeting counts nowhere. A meeting has happened once it
 *   starts (the transaction's `now()`), and until then it is `next`; an email
 *   or a call has always happened, so a clock a second ahead of the
 *   database's never hides one.
 */

const uuidArray = (ids: ReadonlyArray<string>) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`

/**
 * The rows for `ids`, rebuilt. Takes a transaction-scoped advisory lock per
 * entity first, in id order, so two writers touching one person serialize and
 * the second reads the first's committed interaction.
 * - Never compute before the lock: the statement's snapshot is what it counts.
 */
export async function recomputeInteractionStats(
  tx: Tx,
  entityIds: ReadonlyArray<string>,
): Promise<void> {
  const ids = [...new Set(entityIds)].sort()
  if (ids.length === 0) return
  const arr = uuidArray(ids)
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended('interaction_stat:' || s.id::text, 0))
    from (select unnest(${arr}) as id order by 1) s
  `)
  await tx.execute(sql`
    with ids as (select unnest(${arr}) as entity_id),
    live as (
      select ie.entity_id, i.id, i.kind::text as kind, i.occurred_at,
             (i.kind <> 'meeting' or i.occurred_at <= now()) as happened
      from interaction_entity ie
      join interaction i on i.id = ie.interaction_id
      where ie.entity_id in (select entity_id from ids)
        and not (i.kind = 'meeting' and coalesce(i.meta ->> 'status', '') = 'cancelled')
    ),
    tagged as (
      select entity_id, id, kind, occurred_at, happened from live
      union all
      select entity_id, id, 'any', occurred_at, happened from live
    ),
    computed as (
      select entity_id, kind,
        (array_agg(id order by occurred_at, id) filter (where happened))[1] as first_id,
        min(occurred_at) filter (where happened) as first_at,
        (array_agg(id order by occurred_at desc, id desc) filter (where happened))[1] as last_id,
        max(occurred_at) filter (where happened) as last_at,
        (array_agg(id order by occurred_at, id) filter (where not happened))[1] as next_id,
        min(occurred_at) filter (where not happened) as next_at
      from tagged
      group by entity_id, kind
    ),
    upserted as (
      insert into interaction_stat
        (entity_id, kind, first_id, first_at, last_id, last_at, next_id, next_at)
      select entity_id, kind, first_id, first_at, last_id, last_at, next_id, next_at
      from computed
      where first_at is not null or next_at is not null
      on conflict (entity_id, kind) do update set
        first_id = excluded.first_id, first_at = excluded.first_at,
        last_id = excluded.last_id, last_at = excluded.last_at,
        next_id = excluded.next_id, next_at = excluded.next_at
      returning entity_id, kind
    )
    delete from interaction_stat s
    using ids
    where s.entity_id = ids.entity_id
      and not exists (
        select 1 from upserted u where u.entity_id = s.entity_id and u.kind = s.kind
      )
  `)
}

/** Every entity edged to `interactionId` — the set a change to it touches. */
export async function interactionParticipants(
  tx: Tx,
  interactionId: string,
): Promise<Array<string>> {
  const rows = await tx
    .select({ entityId: interactionEntity.entityId })
    .from(interactionEntity)
    .where(eq(interactionEntity.interactionId, interactionId))
  return rows.map((r) => r.entityId)
}

export class InteractionStatRollFailed extends Schema.TaggedError<InteractionStatRollFailed>()(
  'InteractionStatRollFailed',
  { cause: Schema.Defect() },
) {}

/**
 * The clock's half: a `next` meeting that has started is now `last`, and
 * nothing wrote an interaction to say so. Rebuilds every entity whose
 * `next_at` has passed, one transaction per batch.
 */
export const rollElapsedInteractionStatsProgram = Effect.fn(
  'rollElapsedInteractionStatsProgram',
)(function* (
  batch: number = 500,
): Effect.fn.Return<{ readonly rolled: number }, InteractionStatRollFailed> {
  let rolled = 0
  for (;;) {
    const n = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const due = await tx
            .selectDistinct({ entityId: interactionStat.entityId })
            .from(interactionStat)
            .where(sql`${interactionStat.nextAt} <= now()`)
            .limit(batch)
          await recomputeInteractionStats(
            tx,
            due.map((d) => d.entityId),
          )
          return due.length
        }),
      catch: (cause) => new InteractionStatRollFailed({ cause }),
    })
    rolled += n
    if (n < batch) return { rolled }
  }
})
