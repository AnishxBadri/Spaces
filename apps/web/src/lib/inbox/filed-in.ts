import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { readFileRecordPayload } from '@spaces/core/ai/discovery'
import { InboxQueryFailed } from './queue'
import type { InboxRow } from './queue'

/** The records the queue's file-here cards would file. */
const fileHereRecords = (rows: ReadonlyArray<InboxRow>): string[] => [
  ...new Set(
    rows.flatMap((r) =>
      r.kind !== 'discovery'
        ? []
        : r.suggestions.flatMap((s) => {
            const card =
              s.kind === 'file_record' ? readFileRecordPayload(s.payload) : null
            return card === null ? [] : [card.entityId]
          }),
    ),
  ),
]

/**
 * Where each file-here card's record is filed now: its earliest live filing,
 * by the path of names (`Proptech / Rental software`), keyed by record id.
 */
export const filedInProgram = Effect.fn('filedInProgram')(function* (
  rows: ReadonlyArray<InboxRow>,
): Effect.fn.Return<Record<string, string>, InboxQueryFailed> {
  const entityIds = fileHereRecords(rows)
  if (entityIds.length === 0) return {}
  const found = yield* Effect.tryPromise({
    try: () =>
      db.execute<{ id: string; path: string }>(sql`
        select f.entity_id as id,
          string_agg(e.canonical_name, ' / ' order by nlevel(a.path)) as path
        from (
          select distinct on (es.entity_id) es.entity_id, es.space_id
          from entity_space es
          join space s on s.entity_id = es.space_id
          join entity se on se.id = s.entity_id
          where s.archived_at is null and se.merged_into_id is null
            and es.entity_id in (${sql.join(
              entityIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          order by es.entity_id, es.created_at, es.space_id
        ) f
        join space s on s.entity_id = f.space_id
        join space a on a.path @> s.path
        join entity e on e.id = a.entity_id
        group by f.entity_id
      `),
    catch: (cause) => new InboxQueryFailed({ cause }),
  })
  return Object.fromEntries(found.rows.map((r) => [r.id, r.path]))
})
