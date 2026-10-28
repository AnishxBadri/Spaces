import { Effect } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { unionAll } from 'drizzle-orm/pg-core'
import { entity, entitySpace, link, objectDef } from '@spaces/db/schema'
import type { EmbeddingModel } from 'ai'
import {
  SearchQueryFailed,
  canReadNoteSql,
  fusedStatement as coreFusedStatement,
} from '@spaces/core/writes/read/search'
import type { FusedRow } from '@spaces/core/writes/read/search'
import { excerpt } from '@spaces/core/context/excerpt'
import { queryVectorOrNullProgram } from './query-embedding'
import type { QueryVector } from './query-embedding'

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SearchQueryFailed({ cause }),
  })

/**
 * Unified search: one box over names, note bodies and document text, fused
 * in Postgres by reciprocal rank fusion (trigram and ts_rank scores are not
 * comparable; ranks are).
 * - Tasks are not entities, so every row carries `row_kind` and the fusion
 *   keys on `(row_kind, id)`: a task never fuses with an entity sharing its uuid.
 * - The vector lane (`sem_hits`) is emitted only when the caller hands a query
 *   vector, so the per-keystroke statement embeds nothing.
 * - k = 60, the standard RRF constant and the assembler's `rrfK`; it appears
 *   once, in the final select.
 * - canRead is enforced in SQL on every lane that can reach a note. The task
 *   lane takes none: any member sees any task.
 * The tests pin the invariants a rewrite must keep.
 */

/**
 * `semantic` is the palette's second wave: the same fused query plus the
 * vector lane. Omitted, the statement is lexical and nothing is embedded.
 */
export type SearchAllInput = {
  userId: string
  q: string
  semantic?: boolean
  /**
   * Narrow the answer to one object's records (MCP's
   * `search_records(query, object?)`). Without it the statement is exactly
   * the palette's.
   */
  objectId?: string
}

/** What the builder takes: the query vector, when the second wave has one. */
export type FusedRowsInput = {
  userId: string
  q: string
  vector?: QueryVector
  /** One object's records only; tasks, which belong to no object, drop out. */
  objectId?: string
}

/** `model` replaces the embedding wire in tests; see `queryVector`. */
export type SearchSeam = { model?: EmbeddingModel }

/** A document's destination: the record or space it is filed against. */
export type SearchParent = {
  id: string
  kind: (typeof entity.$inferSelect)['kind']
  name: string
  objectSlug: string | null
}

/** What a task hit carries that an entity hit has no use for. */
export type SearchTask = { dueDate: string | null; done: boolean }

/**
 * One hit shape for every lane; a new lane extends it rather than reshaping
 * it. `task` is non-null exactly when `rowKind` is 'task'; `parent` is only
 * ever set on a document.
 */
type SearchHitFields = {
  id: string
  kind: string
  name: string
  objectSlug: string | null
  snippet: string | null
  matchedIn: string
  parent: SearchParent | null
}

export type SearchHit =
  | (SearchHitFields & { rowKind: 'entity'; task: null })
  | (SearchHitFields & { rowKind: 'task'; task: SearchTask })

/**
 * The semantic lane's CTEs; absent without a query vector. Passages run them
 * alone, and the fused statement takes them as its fifth lane.
 * - Never filters `source_kind`: any chunk ranks the moment it is written.
 * - `embedding_model` must be the pin's: another model's vector is garbage
 *   here, so search never mixes models mid-migration.
 * - canRead via `canReadNoteSql`, the predicate the lexical note lane takes.
 * - The inner subquery is a bare `order by embedding <=> <constant> limit n`,
 *   the only shape pgvector walks the HNSW index for; filters apply to its
 *   answer, and `qv` makes the vector an init-plan constant.
 */
export function semanticCtes(
  userId: string,
  { vector, model }: QueryVector,
): SQL {
  const literal = `[${vector.join(',')}]`
  return sql`
      qv as (
        select ${literal}::vector as v
      ),

      sem_hits as (
        select c.entity_id as id,
               row_number() over (order by min(c.distance), c.entity_id) as rnk,
               left(btrim(regexp_replace(translate(
                 (array_agg(c.text order by c.distance))[1], '«»', ''),
                 '[[:space:]]+', ' ', 'g')), 160) as snippet,
               (array_agg(c.page order by c.distance))[1] as page
        from (
          select ch.entity_id, ch.embedding_model, ch.text, ch.page,
                 ch.embedding <=> (select v from qv) as distance
          from chunk ch
          order by ch.embedding <=> (select v from qv)
          limit 100
        ) c
        join entity e on e.id = c.entity_id and e.merged_into_id is null
          and e.archived_at is null
        where c.embedding_model = ${model}
          and ${canReadNoteSql(userId)}
        group by c.entity_id
        order by rnk
        limit 40
      )`
}

/** The fifth lane as the fused statement takes it: the CTEs and a comma. */
function semanticLane(userId: string, vector: QueryVector): SQL {
  return sql`${semanticCtes(userId, vector)},
`
}

/** The fused statement: four lanes (five with a query vector), one RRF, top 20. */
export function fusedStatement({
  userId,
  q,
  vector,
  objectId,
}: FusedRowsInput): SQL {
  return coreFusedStatement({
    userId,
    q,
    semantic: vector === undefined ? null : semanticLane(userId, vector),
    ...(objectId === undefined ? {} : { objectId }),
  })
}

export const fusedRowsProgram = Effect.fn('fusedRowsProgram')(function* (
  input: FusedRowsInput,
): Effect.fn.Return<Array<FusedRow>, SearchQueryFailed> {
  const rows = yield* query(() => db.execute<FusedRow>(fusedStatement(input)))
  return rows.rows
})

/**
 * Where each document hit sends you: documents have no page, so the record
 * (`link(tagged_in)`) or space (`entity_space`) it is filed against.
 * The winner is chosen in SQL, not by driver row order:
 * - a record parent always beats a space parent;
 * - within a kind the earliest wins: `created_at`, then the edge id
 *   (`link.id`, or `space_id` for `entity_space`).
 */
export const documentParentsProgram = Effect.fn('documentParentsProgram')(
  function* (
    documentIds: ReadonlyArray<string>,
  ): Effect.fn.Return<Map<string, SearchParent>, SearchQueryFailed> {
    if (documentIds.length === 0) return new Map()

    const filed = db
      .select({
        documentId: link.fromEntityId,
        parentId: link.toEntityId,
        precedence: sql<number>`0`.as('precedence'),
        filedAt: link.createdAt,
        tiebreak: link.id,
      })
      .from(link)
      .where(
        and(
          inArray(link.fromEntityId, [...documentIds]),
          eq(link.relation, 'tagged_in'),
        ),
      )
    const spaced = db
      .select({
        documentId: entitySpace.entityId,
        parentId: entitySpace.spaceId,
        precedence: sql<number>`1`.as('precedence'),
        filedAt: entitySpace.createdAt,
        tiebreak: entitySpace.spaceId,
      })
      .from(entitySpace)
      .where(inArray(entitySpace.entityId, [...documentIds]))
    const edges = unionAll(filed, spaced).as('edges')

    const rows = yield* query(() =>
      db
        .selectDistinctOn([edges.documentId], {
          documentId: edges.documentId,
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
          objectSlug: objectDef.slug,
        })
        .from(edges)
        .innerJoin(entity, eq(entity.id, edges.parentId))
        .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
        .orderBy(
          edges.documentId,
          edges.precedence,
          edges.filedAt,
          edges.tiebreak,
        ),
    )
    return new Map(
      rows.map(({ documentId, ...parent }) => [documentId, parent] as const),
    )
  },
)

/**
 * What Cmd-K shows: the fused rows, each document with where it is filed
 * and each task with its due date and done state.
 * With `semantic: true` the query is embedded and the vector lane added. No
 * pin, or a failed embed, falls back to the lexical statement with one log
 * line, never an error per pause.
 */
export const searchAllProgram = Effect.fn('searchAllProgram')(function* (
  { userId, q: raw, semantic = false, objectId }: SearchAllInput,
  seam: SearchSeam = {},
): Effect.fn.Return<Array<SearchHit>, SearchQueryFailed> {
  const q = raw.trim()
  if (q.length < 2) return []

  const vector = semantic
    ? yield* queryVectorOrNullProgram(q, {
        caller: { type: 'user', id: userId },
        ...(seam.model === undefined ? {} : { model: seam.model }),
      })
    : null

  const hits = yield* fusedRowsProgram({
    userId,
    q,
    ...(vector === null ? {} : { vector }),
    ...(objectId === undefined ? {} : { objectId }),
  })
  if (hits.length === 0) return []

  const parents = yield* documentParentsProgram(
    hits
      .filter((h) => h.row_kind === 'entity' && h.kind === 'document')
      .map((h) => h.id),
  )

  return hits.map((h): SearchHit => {
    const fields = {
      id: h.id,
      kind: h.kind,
      name: h.name,
      objectSlug: h.object_slug,
      // A mention reads as its name, never as `[[Name|entity:id]]`.
      snippet: h.snippet === null ? null : excerpt(h.snippet),
      matchedIn: h.sources.includes('name') ? 'name' : (h.sources[0] ?? 'name'),
    }
    return h.row_kind === 'task'
      ? {
          ...fields,
          rowKind: 'task',
          parent: null,
          task: { dueDate: h.due_date, done: h.done === true },
        }
      : {
          ...fields,
          rowKind: 'entity',
          parent: parents.get(h.id) ?? null,
          task: null,
        }
  })
})
