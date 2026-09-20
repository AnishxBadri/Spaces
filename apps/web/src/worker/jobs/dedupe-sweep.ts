import { Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { duplicateCandidate, entity, entityAlias } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { MERGEABLE } from '#/lib/entities/merge'
import { SIMILARITY_THRESHOLD } from '#/lib/entities/sweep'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * entity.dedupe-sweep — the nightly half of the promise CONTEXT.md makes
 * under "Entity resolution & merge": *at-create check + nightly sweep job*.
 * The at-create check (`lib/entities/sweep.ts`) only ever sees the name a
 * record is born with, so two records that drift into similarity through a
 * rename are invisible to it forever. This job is what finds them, and until
 * SPA-81 its queue was wired to `stub()` and had never run for any kind.
 *
 * **One statement, not a loop.** The scan is a single self-join of
 * `entity_alias` name rows — no `select` of every entity into memory, and
 * both caps (top-k per entity, rows per run) applied in SQL rather than in
 * JS after the fact. That is what lets it stay one query on a workspace
 * where the per-entity sweep would be one query per record.
 *
 * The insert is `on conflict do nothing` against `duplicate_pair_unique`,
 * which is the whole dismissal contract: "not a duplicate" is a negative
 * assertion the user made once, and a sweep that could re-insert a dismissed
 * pair would re-ask the question every night forever. The pair is ordered
 * `entity_a < entity_b` the same way `suggestDuplicate` orders it — the
 * uuid's text form and its byte form sort alike, so Postgres's `<` and the
 * JS `<` agree on which side is A.
 */

/**
 * The bound this job proposes against, and the reason it is `hitl`: its
 * first pass on an established workspace lands an unknown number of pairs in
 * a queue the owner reads daily. Both numbers in one object so moving them
 * is one line.
 *
 * `perEntity` is a `row_number()` cut, `perRun` a `limit` — neither is a
 * JS slice, so a workspace with ten thousand near-names costs the same query.
 */
export const DEDUPE_SWEEP_BOUNDS = {
  /** Top-k candidates kept per entity, best score first. */
  perEntity: 3,
  /** Rows one run may offer. The rest wait for tomorrow's run. */
  perRun: 50,
} as const

/**
 * Nullish-tolerant on purpose. pg-boss stores `data = null` for a schedule
 * registered with no payload (`manager.js`: `const { name, data = null }`),
 * and the 03:30 schedule is registered exactly that way — a bare
 * `z.object({...})` would fail every nightly run as `invalid-data` before
 * the handler ever ran. The optional `objectId` is what a test (and the
 * `/inbox` button, later) uses to scope a run to one object.
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
 * The scan. Read it as four stages:
 *
 *  - `alive` — the population: `merged_into_id is null` (a loser row still
 *    exists and still redirects; suggesting it would be a merge the executor
 *    refuses) and `kind in MERGEABLE`, which is read from the executor rather
 *    than re-derived, so the inbox can never show a pair whose Merge button
 *    throws.
 *  - `pairs` — the self-join, `a.entity_id < b.entity_id` so a pair appears
 *    once and never as a self-pair, scoped to one object. `object_id` is the
 *    scope because every custom record shares the kind `custom`; the `kind`
 *    branch is the fallback for a row written without its object, exactly as
 *    `sweep.ts` documents. `max()`/`array_agg` collapse the several name
 *    aliases two records may each hold into one best pair + the name that
 *    matched.
 *  - `ranked`/`capped` — the two bounds, in SQL.
 *  - `inserted` — the append, conflict-ignoring.
 *
 * The final select reads all three counts off the same snapshot, so the
 * logged line describes the run that actually happened.
 */
const scan = (data: DedupeSweepData) =>
  Effect.tryPromise({
    try: async () => {
      // No `::text` on the column. Casting an enum away from its own type
      // is what hides the column's statistics from the planner: with
      // `kind::text in (…)` the `alive` scan estimated 6 rows out of 400
      // and every join above it inherited the error. Untyped parameters let
      // Postgres infer `entity_kind` from the comparison instead.
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
 * The job body, exported so a test drives it with a payload and no pg-boss
 * in sight — the `extract-document.ts` shape, minus its Layer: this job's
 * whole I/O is one statement against the same `db` every other read uses,
 * and faking that would assert nothing the statement itself is about.
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
  // The announcement, and the whole of it: the count, in the worker log.
  // Nothing is written to the inbox beyond the rows themselves.
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
  // No `refs`: a sweep is about no one row, which is the case `JobRunRefs`
  // documents both of its fields as optional for.
  run: (data) =>
    dedupeSweepProgram(data).pipe(
      Effect.asVoid,
      // A failed scan is one statement that did not run — Postgres was busy,
      // a lock was held. Nothing partial survives it (the insert is inside
      // the statement), so the next attempt is a clean re-run.
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
