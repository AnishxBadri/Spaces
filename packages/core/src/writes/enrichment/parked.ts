import { Clock, Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { QUEUES } from '../../queue/names'

/**
 * Runs parked at a source's daily cap, for Today's notices band: per source,
 * how many records wait and when they resume. "Auto-enrich paused ·
 * Apollo cap reached · 14 waiting · resumes 00:00 UTC".
 * - Read from pg-boss's own job table: a parked run is a queued
 *   `enrichment.run` whose `startAfter` is still ahead and whose data names
 *   the source it waits on. No second store to drift from the queue.
 * - Empty, never a failure, before the worker has made the queue schema.
 */

export class ParkedReadFailed extends Schema.TaggedError<ParkedReadFailed>()(
  'ParkedReadFailed',
  { cause: Schema.Defect() },
) {}

export type ParkedSource = {
  readonly integrationId: string
  /** The source's name from its manifest, else its capability id. */
  readonly source: string
  readonly waiting: number
  /** ISO instant the earliest parked run becomes due. */
  readonly resumesAt: string
}

const row = z.object({
  integration_id: z.string(),
  source: z.string(),
  waiting: z.coerce.number(),
  resumes_ms: z.coerce.number(),
})

export const parkedEnrichmentProgram = Effect.fn('parkedEnrichmentProgram')(
  function* (): Effect.fn.Return<Array<ParkedSource>, ParkedReadFailed> {
    const now = new Date(yield* Clock.currentTimeMillis)
    const rows = yield* Effect.tryPromise({
      try: async () => {
        const present = await db.execute(
          sql`select to_regclass('pgboss.job') is not null as present`,
        )
        if (present.rows.at(0)?.['present'] !== true) return []
        const result = await db.execute(sql`
          select j.data ->> 'parkedBy' as integration_id,
                 coalesce(i.manifest ->> 'name', i.capability_id) as source,
                 count(*) as waiting,
                 (extract(epoch from min(j.start_after)) * 1000)::float8 as resumes_ms
          from pgboss.job j
          join integration i on i.id::text = j.data ->> 'parkedBy'
          where j.name = ${QUEUES.enrichmentRun}
            and j.state = 'created'
            and j.start_after > ${now.toISOString()}::timestamptz
          group by 1, 2
          order by 2`)
        return result.rows.map((r): ParkedSource => {
          const parsed = row.parse(r)
          return {
            integrationId: parsed.integration_id,
            source: parsed.source,
            waiting: parsed.waiting,
            resumesAt: new Date(parsed.resumes_ms).toISOString(),
          }
        })
      },
      catch: (cause) => new ParkedReadFailed({ cause }),
    })
    return rows
  },
)
