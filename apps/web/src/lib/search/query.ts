import { Effect, Schema } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { unionAll } from 'drizzle-orm/pg-core'
import { entity, entitySpace, link, objectDef } from '@spaces/db/schema'
import type { EmbeddingModel } from 'ai'
import { queryVectorOrNullProgram } from './query-embedding'
import type { QueryVector } from './query-embedding'

/**
 * Unified search — one box over names, note bodies, and extracted document
 * text, fused in Postgres rather than merged in Node (SPA-148 moved it here
 * from `lib/server/search.ts`, Effect-first per CONTEXT.md "Backend
 * paradigm", so a test can call it without a request).
 *
 * Names, notes and documents are entities, so those three sources rank the
 * *same* id space and reciprocal rank fusion is the honest way to combine
 * them: scores from trigram similarity and ts_rank are not comparable, but
 * ranks are. Tasks are the exception (SPA-55): deliberately not entities
 * (CONTEXT.md 15b), so the fourth lane ranks a second id space. Every fused
 * row therefore carries a `row_kind` discriminator — 'entity' | 'task' — and
 * the fusion keys on `(row_kind, id)`, so a task can never fuse with an
 * entity that happens to share its uuid. The pgvector half (CONTEXT.md →
 * Search is hybrid, SPA-129) is the fifth lane, `sem_hits`, under the same
 * key: it ranks entity ids by their nearest `chunk`, and `SearchHit` gains
 * one `matchedIn` value, 'semantic', rather than a new shape. It is emitted
 * only when the caller hands the builder a query vector — the palette's
 * second wave, with a model pinned — so the per-keystroke statement is the
 * four-lane one whether or not a model is pinned, and embeds nothing.
 *
 * k = 60 is the standard RRF constant: large enough that a top hit in one
 * source doesn't automatically beat two decent hits across two sources. It
 * is the same constant the assembler ranks with (`rrfK` in
 * `lib/context/rank.ts`), and it appears once, in the final select.
 *
 * canRead is enforced in SQL on every lane that can reach a note — a
 * teammate's private note never enters the fusion. The task lane takes no
 * such clause: tasks carry no visibility flag, and any member sees any task
 * (the rule /tasks enforces). `query.test.ts` pins the invariants a rewrite
 * of this module must keep.
 */

export class SearchQueryFailed extends Schema.TaggedError<SearchQueryFailed>()(
  'SearchQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SearchQueryFailed({ cause }),
  })

/**
 * The `ts_headline` options every search snippet is cut with. `«` and `»`
 * mark the match; the palette renders them as text, never as HTML, so a
 * snippet cannot smuggle markup. Import this rather than spelling a second
 * one — a mentions rail cutting its own snippets differently would read as
 * a different product.
 */
export const HEADLINE_OPTIONS =
  'MaxWords=18, MinWords=6, ShortWord=3, MaxFragments=1, StartSel=«, StopSel=»'

// Spelled as a literal, not a bind parameter, so the emitted statement is the
// one the palette has always sent. The constant is ours; nothing user-typed
// reaches `sql.raw`.
const headlineOptions = sql.raw(`'${HEADLINE_OPTIONS}'`)

/**
 * canRead for a note, as a predicate over the entity aliased `e`: true
 * unless `e` is a note that is private to someone other than `userId`. It is
 * vacuous for every other kind, which is what lets the name lane apply it to
 * companies and decks alike; in the note lane `e` is the note itself (note's
 * key is its entity id), so it is exactly "shared, or mine".
 */
export const canReadNoteSql = (userId: string): SQL => sql`not exists (
            select 1 from note pn
            where pn.entity_id = e.id
              and pn.visibility = 'private'
              and pn.author_id <> ${userId}
          )`

/**
 * `semantic` is the palette's second wave (SPA-129): the same fused query
 * plus the vector lane, asked for 600ms after the last keystroke. Omitted,
 * the statement is lexical and nothing is embedded.
 */
export type SearchAllInput = {
  userId: string
  q: string
  semantic?: boolean
  /**
   * Narrow the answer to one object's records (SPA-28, the MCP
   * `search_records(query, object?)`). Cmd-K never passes it, and without it
   * the statement is exactly the palette's.
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

/** `model` replaces the embedding wire in tests; see `query-embedding.ts`. */
export type SearchSeam = { model?: EmbeddingModel }

/** Which id space a fused row's `id` belongs to. */
export type SearchRowKind = 'entity' | 'task'

/**
 * One fused row, as Postgres returns it — `score` is `numeric`, a string.
 * `kind` is the entity kind, or `'task'` for a task row; `due_date` and
 * `done` are null for every entity row.
 */
export type FusedRow = {
  row_kind: SearchRowKind
  id: string
  kind: string
  name: string
  object_slug: string | null
  snippet: string | null
  sources: Array<string>
  score: string
  due_date: string | null
  done: boolean | null
}

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
 * The hit contract (SPA-55) — one shape for every lane, pinned here so a
 * later lane extends it instead of reshaping it. `task` is non-null exactly
 * when `rowKind` is 'task'; `parent` is only ever set on a document.
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
 * The semantic lane (SPA-129) — the fifth CTE, and the only one that exists
 * conditionally: no query vector, no fragment, so a workspace with no pin
 * (or a keystroke that has not paused) sends exactly the four-lane
 * statement.
 *
 * It joins `chunk` on `entity_id` and **never filters `source_kind`**: a
 * document's chunks, a note's and an attribute's (a deal's close_reason) all
 * rank here the moment something writes them, with no further search edit.
 * What it does filter:
 *
 * - `embedding_model` must be the pin's. A row embedded by another model is
 *   garbage in this vector space (the dimension trap's quieter cousin), so
 *   it is skipped even when it is the closest — search never mixes models
 *   mid-migration (spec-ai-substrate §9).
 * - canRead, the same predicate the lexical note lane takes. For a
 *   note-sourced chunk `e` is the note itself (a note chunk's entity is the
 *   note), so `canReadNoteSql` joins `note` and holds a teammate's private
 *   note out by meaning exactly as it is held out by words. An
 *   attribute-sourced chunk joins nothing extra: its entity is the record
 *   the attribute belongs to, and records carry no visibility flag — any
 *   member reads any record's attributes on its page — so the predicate is
 *   vacuous for it, as it is for a document.
 *
 * The shape is for the HNSW index (`chunk_embedding_hnsw_idx`, 0045):
 * pgvector only walks it for a bare `order by embedding <=> <constant>
 * limit n`, so the inner subquery is exactly that, and the model and canRead
 * filters apply to its answer. The query vector sits in its own CTE, `qv`,
 * so it is sent once and reaches the index as an init-plan constant. The
 * inner limit is above 40 because several chunks of one record collapse into
 * one row; pgvector's `hnsw.ef_search` (40 by default) still bounds how many
 * the index hands back, which is plenty for a palette of 20.
 *
 * The snippet is the nearest chunk's text, whitespace-collapsed, cut to 160
 * characters, with any « » removed: nothing matched a word, so nothing is
 * marked, and `Highlighted` renders it as plain text.
 */
function semanticLane(userId: string, { vector, model }: QueryVector): SQL {
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
                 '[[:space:]]+', ' ', 'g')), 160) as snippet
        from (
          select ch.entity_id, ch.embedding_model, ch.text,
                 ch.embedding <=> (select v from qv) as distance
          from chunk ch
          order by ch.embedding <=> (select v from qv)
          limit 100
        ) c
        join entity e on e.id = c.entity_id and e.merged_into_id is null
        where c.embedding_model = ${model}
          and ${canReadNoteSql(userId)}
        group by c.entity_id
        order by rnk
        limit 40
      ),
`
}

/** The fused statement: four lanes (five with a query vector), one RRF, top 20. */
export function fusedStatement({
  userId,
  q,
  vector,
  objectId,
}: FusedRowsInput): SQL {
  const semantic = vector === undefined ? null : semanticLane(userId, vector)
  return sql`
      with q as (
        select
          websearch_to_tsquery('english', ${q}) as tsq,
          ${q} as raw
      ),

      -- Names: trigram, so typos still land. Aliases count as names, which
      -- is how "Made In Space" finds a company stored under another label.
      name_hits as (
        select e.id,
               row_number() over (
                 order by greatest(
                   word_similarity((select raw from q), e.canonical_name),
                   coalesce(max(word_similarity((select raw from q), a.value_norm)), 0)
                 ) desc,
                 e.canonical_name
               ) as rnk
        from entity e
        left join entity_alias a
          on a.entity_id = e.id and a.kind = 'name'
        where e.merged_into_id is null
          -- canRead in SQL: private note titles are entities too.
          and ${canReadNoteSql(userId)}
          and (
            e.canonical_name ilike '%' || (select raw from q) || '%'
            -- word_similarity, not similarity: the percent operator compares
            -- whole strings, so a short query against a long name always
            -- scores below threshold and "orbitl" would never reach "Orbital
            -- Composites". The word-similarity operator scores the query
            -- against the best-matching word instead.
            or (select raw from q) <% e.canonical_name
            or a.value_norm ilike '%' || (select raw from q) || '%'
            or (select raw from q) <% a.value_norm
          )
        group by e.id, e.canonical_name
        limit 40
      ),

      note_hits as (
        select n.entity_id as id,
               row_number() over (order by ts_rank(n.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', n.body_md, (select tsq from q),
                 ${headlineOptions}
               ) as snippet
        from note n
        join entity e on e.id = n.entity_id and e.merged_into_id is null
        where n.tsv @@ (select tsq from q)
          and ${canReadNoteSql(userId)}
        limit 40
      ),

      doc_hits as (
        select d.entity_id as id,
               row_number() over (order by ts_rank(d.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', d.extracted_text, (select tsq from q),
                 ${headlineOptions}
               ) as snippet
        from document d
        join entity e on e.id = d.entity_id and e.merged_into_id is null
        where d.tsv @@ (select tsq from q)
        limit 40
      ),

      -- Tasks: a plain table, not an entity (CONTEXT.md 15b), so this lane
      -- ranks task ids, not entity ids. No canRead clause, unlike the
      -- private-note carve-out in the two lanes above, and on purpose: a
      -- task carries no visibility flag — any member sees any task, the
      -- rule /tasks already enforces — so there is nothing to carve out.
      -- Nor does it filter on done_at: a finished task is still a thing you
      -- may be looking for, and the hit says it is done.
      task_hits as (
        select t.id,
               row_number() over (order by ts_rank(t.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', t.content, (select tsq from q),
                 ${headlineOptions}
               ) as snippet
        from task t
        where t.tsv @@ (select tsq from q)
        limit 40
      ),
${semantic ?? sql``}

      -- row_kind keeps the two id spaces apart: a task id and an entity id
      -- are both uuids, and the fusion below keys on (row_kind, id) so they
      -- can never sum into one row.
      fused as (
        select 'entity' as row_kind, id, 'name' as source, rnk, null::text as snippet from name_hits
        union all
        select 'entity', id, 'note', rnk, snippet from note_hits
        union all
        select 'entity', id, 'document', rnk, snippet from doc_hits
        union all
        select 'task', id, 'task', rnk, snippet from task_hits
        ${
          semantic === null
            ? sql``
            : sql`union all
        select 'entity', id, 'semantic', rnk, snippet from sem_hits`
        }
      )

      -- Each join is gated on row_kind, and both are left joins: a task row
      -- finds no entity and supplies its own name, due date and done state.
      -- The columns grouped after (row_kind, id) are one value per key —
      -- they ride along for the select list and split nothing. A lexical
      -- snippet outranks a semantic one: a row that matched words shows
      -- the words, marked; the plain nearest-chunk cut is for a row found
      -- by meaning alone.
      select f.row_kind,
             f.id,
             coalesce(e.kind::text, 'task') as kind,
             coalesce(e.canonical_name, t.content) as name,
             o.slug as object_slug,
             (array_remove(array_agg(f.snippet order by f.source = 'semantic', f.rnk), null))[1] as snippet,
             array_agg(distinct f.source) as sources,
             sum(1.0 / (60 + f.rnk)) as score,
             t.due_date::text as due_date,
             case when t.id is null then null else t.done_at is not null end as done
      from fused f
      left join entity e on f.row_kind = 'entity' and e.id = f.id
      left join task t on f.row_kind = 'task' and t.id = f.id
      left join object o on o.id = e.object_id
      ${
        // After the lanes rank, so a narrowed hit keeps the score it has in
        // the palette; absent, nothing is emitted.
        objectId === undefined ? sql`` : sql`where e.object_id = ${objectId}`
      }
      group by f.row_kind, f.id,
               e.kind, e.canonical_name, o.slug,
               t.id, t.content, t.due_date, t.done_at
      order by score desc, name
      limit 20
    `
}

export const fusedRowsProgram = Effect.fn('fusedRowsProgram')(function* (
  input: FusedRowsInput,
): Effect.fn.Return<Array<FusedRow>, SearchQueryFailed> {
  const rows = yield* query(() => db.execute<FusedRow>(fusedStatement(input)))
  return rows.rows
})

/**
 * Where each document hit sends you. Documents have no page of their own —
 * they are filed against a record (`link(tagged_in)`) or into a space
 * (`entity_space`, spec-storage-sources §2), so a result has to send you to
 * one of those or it is a dead end.
 *
 * Both edge kinds come back in one statement, and the winner is chosen in
 * SQL rather than by whichever row the driver happened to return first:
 *
 *   1. a record parent always beats a space parent;
 *   2. among edges of one kind the earliest wins — `created_at` asc, then
 *      the edge's own id asc (`link.id`; `entity_space` has no id of its
 *      own, so its `space_id`).
 *
 * A space parent comes back as `{ kind: 'space' }`, which `recordPath`
 * already routes to `/spaces/<id>`, so the palette needs no branch for it.
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
 * What Cmd-K shows: the fused rows, each document carrying where it is
 * filed and each task its due date and done state.
 *
 * The second wave (`semantic: true`) embeds the query — once per (text,
 * model), `query-embedding.ts` — and adds the vector lane. No pin, or an
 * embed that fails (a cap reached, a provider down), and the wave is the
 * lexical statement again: the user's list stays as it was, and the failure
 * is one log line, never an error per pause.
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
      snippet: h.snippet?.replace(/\s+/g, ' ').trim() ?? null,
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
