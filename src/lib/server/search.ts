import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, entityAlias, link } from '#/db/schema'
import { requireUser } from './shared'

/** Autocomplete over entities — mentions and reference pickers share it. */
export const searchEntities = createServerFn()
  .validator(
    z.object({
      q: z.string().max(120),
      kinds: z
        .array(
          z.enum([
            'company',
            'person',
            'organization',
            'deal',
            'space',
            'note',
          ]),
        )
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const q = data.q.trim()
    if (!q) return []
    const pattern = `%${q}%`
    return db
      .selectDistinctOn([entity.id], {
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(entity)
      .leftJoin(entityAlias, eq(entityAlias.entityId, entity.id))
      .where(
        and(
          isNull(entity.mergedIntoId),
          data.kinds
            ? inArray(entity.kind, data.kinds)
            : ne(entity.kind, 'document'),
          // canRead at the SQL layer: a private note's title must not
          // surface in anyone else's autocomplete.
          sql`not exists (select 1 from note pn where pn.entity_id = ${entity.id} and pn.visibility = 'private' and pn.author_id <> ${u.id})`,
          sql`(${entity.canonicalName} ilike ${pattern} or (${entityAlias.kind} = 'name' and ${entityAlias.valueNorm} ilike ${pattern}))`,
        ),
      )
      .limit(8)
  })

/**
 * Unified search — one box over names, note bodies, and extracted document
 * text, fused in Postgres rather than merged in Node.
 *
 * Everything searchable is an entity, so the three sources rank the *same*
 * id space and reciprocal rank fusion is the honest way to combine them:
 * scores from trigram similarity and ts_rank are not comparable, but ranks
 * are. RRF also generalises — when the pgvector half lands (CONTEXT.md →
 * Search is hybrid), it joins as a fourth CTE and nothing else changes.
 *
 * k = 60 is the standard RRF constant: large enough that a top hit in one
 * source doesn't automatically beat two decent hits across two sources.
 */
export const searchAll = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const q = data.q.trim()
    if (q.length < 2) return []

    const rows = await db.execute<{
      id: string
      kind: string
      name: string
      snippet: string | null
      sources: Array<string>
      score: number
    }>(sql`
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
          and not exists (
            select 1 from note pn
            where pn.entity_id = e.id
              and pn.visibility = 'private'
              and pn.author_id <> ${u.id}
          )
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
                 'MaxWords=18, MinWords=6, ShortWord=3, MaxFragments=1, StartSel=«, StopSel=»'
               ) as snippet
        from note n
        join entity e on e.id = n.entity_id and e.merged_into_id is null
        where n.tsv @@ (select tsq from q)
          and (n.visibility = 'shared' or n.author_id = ${u.id})
        limit 40
      ),

      doc_hits as (
        select d.entity_id as id,
               row_number() over (order by ts_rank(d.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', d.extracted_text, (select tsq from q),
                 'MaxWords=18, MinWords=6, ShortWord=3, MaxFragments=1, StartSel=«, StopSel=»'
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
             (array_remove(array_agg(f.snippet order by f.rnk), null))[1] as snippet,
             array_agg(distinct f.source) as sources,
             sum(1.0 / (60 + f.rnk)) as score
      from fused f
      join entity e on e.id = f.id
      group by f.id, e.kind, e.canonical_name
      order by score desc, e.canonical_name
      limit 20
    `)

    const hits = rows.rows
    if (hits.length === 0) return []

    // Documents have no page of their own — they are filed against a record,
    // so a result has to send you to that record or it is a dead end.
    const documentIds = hits
      .filter((h) => h.kind === 'document')
      .map((h) => h.id)
    const parents =
      documentIds.length > 0
        ? await db
            .select({
              documentId: link.fromEntityId,
              parentId: entity.id,
              parentKind: entity.kind,
              parentName: entity.canonicalName,
            })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .where(
              and(
                inArray(link.fromEntityId, documentIds),
                eq(link.relation, 'tagged_in'),
              ),
            )
        : []

    return hits.map((h) => {
      const parent = parents.find((p) => p.documentId === h.id)
      return {
        id: h.id,
        kind: h.kind,
        name: h.name,
        snippet: h.snippet?.replace(/\s+/g, ' ').trim() ?? null,
        matchedIn: h.sources.includes('name')
          ? 'name'
          : (h.sources[0] ?? 'name'),
        parent: parent
          ? {
              id: parent.parentId,
              kind: parent.parentKind,
              name: parent.parentName,
            }
          : null,
      }
    })
  })
