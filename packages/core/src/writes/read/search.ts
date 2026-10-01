import { Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'

/**
 * The lexical half of unified search, in core since SPA-198 (extracted from
 * `apps/web/src/lib/search/query.ts`, which composes it with its semantic
 * lane and re-exports what moved): the fused four-lane statement, its
 * `canReadNoteSql` predicate and the snippet options. Cmd-K sends exactly the
 * statement it always has — `apps/web` builds the fifth lane (the query
 * vector belongs to web's embedding stack) and hands it in — and the plugin
 * SDK's `Read.search` (`../ports/read.ts`) runs the lexical statement alone,
 * which embeds nothing (D56).
 *
 * canRead is enforced in SQL on every lane that can reach a note — a
 * private note never enters the fusion for anyone but its author. The
 * task lane takes no such clause: tasks carry no visibility flag.
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

/** What the fused statement takes; `semantic` is web's fifth lane, if any. */
export type LexicalFusedInput = {
  userId: string
  q: string
  semantic?: SQL | null
  /** One object's records only; tasks, which belong to no object, drop out. */
  objectId?: string
}

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

/**
 * The fused statement: four lexical lanes — names (trigram + ilike, so
 * typos land), note bodies, document text and tasks — one RRF, top 20. A
 * caller with a fifth lane hands its CTE as `semantic`: it must define
 * `sem_hits (id, rnk, snippet)` and end with a comma, and it is fused under
 * the source `'semantic'`. Without it the statement embeds nothing and is
 * exactly the per-keystroke one.
 */
export function fusedStatement({
  userId,
  q,
  semantic = null,
  objectId,
}: LexicalFusedInput): SQL {
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

/** The lexical statement alone — no vector, no embedding call. */
export const lexicalRowsProgram = Effect.fn('lexicalRowsProgram')(function* (
  input: Omit<LexicalFusedInput, 'semantic'>,
): Effect.fn.Return<Array<FusedRow>, SearchQueryFailed> {
  const rows = yield* query(() => db.execute<FusedRow>(fusedStatement(input)))
  return rows.rows
})
