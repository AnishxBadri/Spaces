import { Effect, Schema } from 'effect'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, objectDef } from '@spaces/db/schema'

/**
 * Unified search — one box over names, note bodies, and extracted document
 * text, fused in Postgres rather than merged in Node (SPA-148 moved it here
 * from `lib/server/search.ts`, Effect-first per CONTEXT.md "Backend
 * paradigm", so a test can call it without a request).
 *
 * Everything searchable is an entity, so the three sources rank the *same*
 * id space and reciprocal rank fusion is the honest way to combine them:
 * scores from trigram similarity and ts_rank are not comparable, but ranks
 * are. RRF also generalises — when the pgvector half lands (CONTEXT.md →
 * Search is hybrid), it joins as a fourth CTE and nothing else changes.
 *
 * k = 60 is the standard RRF constant: large enough that a top hit in one
 * source doesn't automatically beat two decent hits across two sources. It
 * is the same constant the assembler ranks with (`rrfK` in
 * `lib/context/rank.ts`), and it appears once, in the final select.
 *
 * canRead is enforced in SQL on every lane that can reach a note — a
 * teammate's private note never enters the fusion. `query.test.ts` pins the
 * invariants a rewrite of this module must keep.
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

export type SearchAllInput = { userId: string; q: string }

/** One fused row, as Postgres returns it — `score` is `numeric`, a string. */
export type FusedRow = {
  id: string
  kind: string
  name: string
  object_slug: string | null
  snippet: string | null
  sources: Array<string>
  score: string
}

export type SearchHit = {
  id: string
  kind: string
  name: string
  objectSlug: string | null
  snippet: string | null
  matchedIn: string
  parent: {
    id: string
    kind: (typeof entity.$inferSelect)['kind']
    name: string
    objectSlug: string | null
  } | null
}

/** The fused statement: three lanes, one RRF, top 20. */
export const fusedRowsProgram = Effect.fn('fusedRowsProgram')(function* ({
  userId,
  q,
}: SearchAllInput): Effect.fn.Return<Array<FusedRow>, SearchQueryFailed> {
  const rows = yield* query(() =>
    db.execute<FusedRow>(sql`
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

      fused as (
        select id, 'name' as source, rnk, null::text as snippet from name_hits
        union all
        select id, 'note', rnk, snippet from note_hits
        union all
        select id, 'document', rnk, snippet from doc_hits
      )

      select f.id,
             e.kind,
             e.canonical_name as name,
             o.slug as object_slug,
             (array_remove(array_agg(f.snippet order by f.rnk), null))[1] as snippet,
             array_agg(distinct f.source) as sources,
             sum(1.0 / (60 + f.rnk)) as score
      from fused f
      join entity e on e.id = f.id
      left join object o on o.id = e.object_id
      group by f.id, e.kind, e.canonical_name, o.slug
      order by score desc, e.canonical_name
      limit 20
    `),
  )
  return rows.rows
})

/** What Cmd-K shows: the fused rows, each deck carrying the record it is filed on. */
export const searchAllProgram = Effect.fn('searchAllProgram')(function* ({
  userId,
  q: raw,
}: SearchAllInput): Effect.fn.Return<Array<SearchHit>, SearchQueryFailed> {
  const q = raw.trim()
  if (q.length < 2) return []

  const hits = yield* fusedRowsProgram({ userId, q })
  if (hits.length === 0) return []

  // Documents have no page of their own — they are filed against a record,
  // so a result has to send you to that record or it is a dead end.
  const documentIds = hits.filter((h) => h.kind === 'document').map((h) => h.id)
  const parents =
    documentIds.length > 0
      ? yield* query(() =>
          db
            .select({
              documentId: link.fromEntityId,
              parentId: entity.id,
              parentKind: entity.kind,
              parentName: entity.canonicalName,
              parentObjectSlug: objectDef.slug,
            })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
            .where(
              and(
                inArray(link.fromEntityId, documentIds),
                eq(link.relation, 'tagged_in'),
              ),
            ),
        )
      : []

  return hits.map((h) => {
    const parent = parents.find((p) => p.documentId === h.id)
    return {
      id: h.id,
      kind: h.kind,
      name: h.name,
      objectSlug: h.object_slug,
      snippet: h.snippet?.replace(/\s+/g, ' ').trim() ?? null,
      matchedIn: h.sources.includes('name') ? 'name' : (h.sources[0] ?? 'name'),
      parent: parent
        ? {
            id: parent.parentId,
            kind: parent.parentKind,
            name: parent.parentName,
            objectSlug: parent.parentObjectSlug,
          }
        : null,
    }
  })
})
