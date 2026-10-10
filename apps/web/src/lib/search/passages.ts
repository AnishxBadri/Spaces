import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { SearchQueryFailed } from '@spaces/core/writes/read/search'
import { renderWikiLinks } from '@spaces/core/context/wiki-link'
import { documentParentsProgram, semanticCtes } from './query'
import type { SearchParent, SearchSeam } from './query'
import { queryVectorOrNullProgram } from './query-embedding'
import type { QueryVector } from './query-embedding'

/**
 * Cmd-K's Passages: the semantic lane on its own, never fused into Records.
 * (D70)
 * - Places to go, never answers: each row is the record or file whose chunk
 *   sat nearest the query, with that chunk's text and page.
 * - No embedding pin, or an embed that fails, answers nothing — the group
 *   stays absent and Records is untouched.
 * - canRead and the pinned model are the lane's own filters (`semanticCtes`).
 */

/** How many passages the palette shows. */
export const PASSAGES_LIMIT = 8

export type Passage = {
  id: string
  kind: string
  name: string
  objectSlug: string | null
  /** The nearest chunk, plain: nothing matched a word, so nothing is marked. */
  snippet: string
  /** 1-based page of a deck or sheet, when extraction knew it. */
  page: number | null
  /** A document's destination: the record or space it is filed against. */
  parent: SearchParent | null
}

type PassageRow = {
  id: string
  kind: string
  name: string
  object_slug: string | null
  snippet: string | null
  page: number | null
}

export function passagesStatement(userId: string, vector: QueryVector): SQL {
  return sql`
      with ${semanticCtes(userId, vector)}
      select s.id,
             e.kind::text as kind,
             e.canonical_name as name,
             o.slug as object_slug,
             s.snippet,
             s.page
      from sem_hits s
      join entity e on e.id = s.id
      left join object o on o.id = e.object_id
      order by s.rnk
      limit ${PASSAGES_LIMIT}
    `
}

export const searchPassagesProgram = Effect.fn('searchPassagesProgram')(
  function* (
    { userId, q: raw }: { userId: string; q: string },
    seam: SearchSeam = {},
  ): Effect.fn.Return<Array<Passage>, SearchQueryFailed> {
    const q = raw.trim()
    if (q.length < 2) return []
    const vector = yield* queryVectorOrNullProgram(q, {
      caller: { type: 'user', id: userId },
      ...(seam.model === undefined ? {} : { model: seam.model }),
    })
    if (vector === null) return []

    const result = yield* Effect.tryPromise({
      try: () => db.execute<PassageRow>(passagesStatement(userId, vector)),
      catch: (cause) => new SearchQueryFailed({ cause }),
    })
    const rows = result.rows
    const parents = yield* documentParentsProgram(
      rows.filter((r) => r.kind === 'document').map((r) => r.id),
    )
    return rows.map((r): Passage => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      objectSlug: r.object_slug,
      snippet: renderWikiLinks(r.snippet ?? ''),
      page: r.page,
      parent: parents.get(r.id) ?? null,
    }))
  },
)
