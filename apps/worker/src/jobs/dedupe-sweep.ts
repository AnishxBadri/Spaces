import { Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate, entity, entityAlias } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { MERGEABLE } from '@spaces/core/writes/entities/merge'
import { SIMILARITY_THRESHOLD } from '@spaces/core/writes/entities/sweep'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * entity.dedupe-sweep: the nightly duplicate scan. The at-create check only
 * sees a record's birth name, so records that drift together through a
 * rename are found only here.
 * - One statement, not a loop: a self-join of `entity_alias` name rows with
 *   both caps applied in SQL.
 * - `on conflict do nothing` against `duplicate_pair_unique` is the whole
 *   dismissal contract: a dismissed pair must never be re-asked.
 * - Pairs are ordered `entity_a < entity_b` as `suggestDuplicate` orders
 *   them; uuid text and byte forms sort alike, so SQL and JS agree on A.
 */

/**
 * Bounds on what one run proposes: a first pass on an established workspace
 * would otherwise land an unknown number of pairs in the owner's queue.
 * `perEntity` is a `row_number()` cut and `perRun` a `limit`, both in SQL.
 */
export const DEDUPE_SWEEP_BOUNDS = {
  /** Top-k candidates kept per entity, best score first. */
  perEntity: 3,
  /** Rows one run may offer. The rest wait for the next run. */
  perRun: 50,
} as const

/**
 * Nullish-tolerant: pg-boss stores `data = null` for the payload-less nightly
 * schedule, which a bare `z.object({...})` would fail as `invalid-data`.
 * `objectId` scopes a run to one object.
 */
export const dedupeSweepData = z
  .object({ objectId: z.string().uuid().optional() })
  .nullish()
  .transform((v) => v ?? {})

export type DedupeSweepData = z.infer<typeof dedupeSweepData>

export interface DedupeSweepResult {
  /** Alive, mergeable entities in scope for this run. */
  readonly scanned: number
  /** Pairs actually inserted — conflicts (dismissed, already open) excluded. */
  readonly suggested: number
  /** True when more pairs cleared both caps than `perRun` would take. */
  readonly capped: boolean
  readonly ms: number
}

export class DedupeSweepFailed extends Schema.TaggedError<DedupeSweepFailed>()(
  'DedupeSweepFailed',
  { cause: Schema.Defect() },
) {}

/** The three counts the statement reads off its own snapshot. */
type SweepCounts = {
  scanned: number
  eligible: number
  suggested: number
}

/**
 * The scan, in four stages:
 * - `alive`: unmerged rows (a loser still redirects; the executor refuses it)
 *   of a `MERGEABLE` kind, read from the executor so the inbox never shows a
 *   pair whose Merge button throws.
 * - `pairs`: the self-join, `a < b`, scoped to one object (every custom record
 *   shares kind `custom`), falling back to `kind` for a row with no object.
 *   `max()`/`array_agg` collapse multiple aliases into one best pair.
 * - `ranked`/`capped`: the two bounds. `inserted`: the conflict-ignoring append.
 * All three counts come off the same snapshot, so the log describes this run.
 */
const scan = (data: DedupeSweepData) =>
  Effect.tryPromise({
    try: async () => {
      // No `::text` on the column: casting the enum hides its statistics
      // from the planner and every join above inherits the misestimate.
      // Untyped parameters let Postgres infer `entity_kind` instead.
      const kinds = sql.join(
        [...MERGEABLE].map((k) => sql`${k}`),
        sql`, `,
      )
      const scope =
        data.objectId === undefined
          ? sql.empty()
          : sql`and e.object_id = ${data.objectId}`
      const rows = await db.execute<SweepCounts>(sql`
        with alive as (
          select e.id, e.object_id, e.kind
          from ${entity} e
          where e.merged_into_id is null
            and e.kind in (${kinds})
            ${scope}
        ),
        pairs as (
          select
            la.entity_id as a_id,
            lb.entity_id as b_id,
            max(similarity(la.value_norm, lb.value_norm)) as score,
            (array_agg(
              lb.value_norm
              order by similarity(la.value_norm, lb.value_norm) desc
            ))[1] as matched
          from ${entityAlias} la
          join alive ea on ea.id = la.entity_id
          join ${entityAlias} lb
            on lb.kind = 'name' and lb.entity_id > la.entity_id
          join alive eb on eb.id = lb.entity_id
          where la.kind = 'name'
            and (
              (ea.object_id is not null and ea.object_id = eb.object_id)
              or (
                ea.object_id is null
                and eb.object_id is null
                and ea.kind = eb.kind
              )
            )
            and la.value_norm % lb.value_norm
            and similarity(la.value_norm, lb.value_norm) >= ${SIMILARITY_THRESHOLD}
          group by la.entity_id, lb.entity_id
        ),
        ranked as (
          select
            a_id, b_id, score, matched,
            row_number() over (
              partition by a_id order by score desc, b_id
            ) as rn
          from pairs
        ),
        capped as (
          select a_id, b_id, score, matched
          from ranked
          where rn <= ${DEDUPE_SWEEP_BOUNDS.perEntity}
          order by score desc, a_id, b_id
          limit ${DEDUPE_SWEEP_BOUNDS.perRun}
        ),
        inserted as (
          insert into ${duplicateCandidate} (entity_a, entity_b, score, reason)
          select a_id, b_id, score, jsonb_build_object('name_similarity', matched)
          from capped
          on conflict (entity_a, entity_b) do nothing
          returning id
        )
        select
          (select count(*) from alive)::int as scanned,
          (select count(*) from ranked
            where rn <= ${DEDUPE_SWEEP_BOUNDS.perEntity})::int as eligible,
          (select count(*) from inserted)::int as suggested
      `)
      return rows.rows.at(0) ?? { scanned: 0, eligible: 0, suggested: 0 }
    },
    catch: (cause) => new DedupeSweepFailed({ cause }),
  })

/**
 * The job body, exported so a test drives it without pg-boss. No Layer: its
 * only I/O is one statement, and faking `db` would test nothing.
 */
export const dedupeSweepProgram = Effect.fn('dedupeSweep')(function* (
  data: DedupeSweepData,
): Effect.fn.Return<DedupeSweepResult, DedupeSweepFailed> {
  const started = Date.now()
  const counts = yield* scan(data)
  const result: DedupeSweepResult = {
    scanned: counts.scanned,
    suggested: counts.suggested,
    capped: counts.eligible > DEDUPE_SWEEP_BOUNDS.perRun,
    ms: Date.now() - started,
  }
  // The only announcement is this log line; the inbox gets just the rows.
  console.log(
    `[worker] ${QUEUES.dedupeSweep} scanned ${String(result.scanned)} · suggested ${String(result.suggested)}${result.capped ? ` · capped at ${String(DEDUPE_SWEEP_BOUNDS.perRun)}` : ''} · ${String(result.ms)}ms`,
  )
  return result
})

/** Promise seam for the pg-boss handler's tests and for a direct drive. */
export const runDedupeSweepJob = (
  data: DedupeSweepData,
): Promise<DedupeSweepResult> => Effect.runPromise(dedupeSweepProgram(data))

export const dedupeSweep: JobDef<DedupeSweepData> = {
  name: QUEUES.dedupeSweep,
  schema: dedupeSweepData,
  // No `refs`: a sweep is about no one row.
  run: (data) =>
    dedupeSweepProgram(data).pipe(
      Effect.asVoid,
      // A failed scan is one statement that did not run; the insert is
      // inside it, so nothing partial survives and a retry is a clean re-run.
      Effect.catchTag(
        'DedupeSweepFailed',
        (err) =>
          new JobRetryable({
            reason: `dedupe sweep query failed: ${messageOf(err.cause)}`,
          }),
      ),
    ),
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
