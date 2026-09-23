import { Effect, Schema } from 'effect'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  HEADLINE_OPTIONS,
  canReadNoteSql,
  documentParentsProgram,
} from '#/lib/search/query'
import type { SearchParent, SearchQueryFailed } from '#/lib/search/query'

/**
 * The term page (SPA-75; CONTEXT.md → Glossary, "Concept node"). A term is
 * the third way into the graph, after space and record, and its page is
 * everything the graph learned by matching it — and nothing it holds:
 *
 *   - **Mentions** — the notes and documents with a `link(→ term, mentions)`
 *     of any source, newest first, each with a `ts_headline` snippet cut by
 *     the one `HEADLINE_OPTIONS` Cmd-K uses, so the «» marks read the same.
 *   - **Companies reached** — companies a mentioning item is filed on
 *     (`tagged_in`) or itself mentions, ranked by how many mentioning items
 *     reach them. Computed here, stored nowhere: a term has no company
 *     column and no term→company link, because a concept never holds things.
 *   - **Co-mentioned terms** — other terms the same items mention, ranked by
 *     how many items they share, ten at most.
 *
 * canRead is in the SQL, exactly as `searchAll` applies it: every statement
 * starts from the same mentioning set, filtered by `canReadNoteSql`, so a
 * teammate's private note neither lists, nor reaches a company, nor counts
 * towards a co-mention. The component is handed rows it may show.
 *
 * Every list is bounded server-side (design contract, checklist 17); the
 * totals ride along so the page can say how many there are.
 */

export class TermPageFailed extends Schema.TaggedError<TermPageFailed>()(
  'TermPageFailed',
  { cause: Schema.Defect() },
) {}

/** How many mentions the page draws; the total is always reported. */
export const MENTIONS_CAP = 50
/** How many companies the rail draws. */
export const COMPANIES_CAP = 25
/** How many co-mentioned terms the rail draws. */
export const CO_MENTIONED_CAP = 10

export type TermMention = {
  id: string
  kind: 'note' | 'document'
  /** `note.kind` for a note, `document.kind` for a document. */
  subKind: string
  name: string
  /** ISO instant — a note's last edit, a document's arrival. */
  at: string
  snippet: string | null
  /** Where a document lands; null for a note and for an unfiled document. */
  parent: SearchParent | null
}

export type TermCompany = { id: string; name: string; reach: number }
export type TermCoMention = { id: string; name: string; shared: number }

export type TermPage = {
  term: {
    id: string
    name: string
    aliases: Array<string>
    definitionMd: string
    space: { id: string; name: string } | null
  }
  mentions: { rows: Array<TermMention>; total: number }
  companies: { rows: Array<TermCompany>; total: number }
  coMentioned: Array<TermCoMention>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TermPageFailed({ cause }),
  })

/**
 * The readable, unmerged notes and documents that mention the term — the one
 * set all three lists start from. `e` is the mentioning entity, which is the
 * alias `canReadNoteSql` is a predicate over.
 */
const mentioningIds = (termId: string, userId: string): SQL => sql`
  select distinct e.id
  from link l
  join entity e on e.id = l.from_entity_id
  where l.to_entity_id = ${termId}
    and l.relation = 'mentions'
    and e.kind in ('note', 'document')
    and e.merged_into_id is null
    and ${canReadNoteSql(userId)}
`

/**
 * The term's name and aliases as a `websearch_to_tsquery` input: each one a
 * quoted phrase, OR-ed, so "Power Usage Effectiveness" and "PUE" both mark.
 * Quotes inside a name are dropped rather than escaped — the websearch
 * grammar has no escape, and a stray quote only changes phrase grouping.
 */
export function termWebsearch(
  name: string,
  aliases: ReadonlyArray<string>,
): string {
  return [name, ...aliases]
    .map((s) => s.replaceAll('"', ' ').trim())
    .filter((s) => s.length > 0)
    .map((s) => `"${s}"`)
    .join(' OR ')
}

type HeadRow = {
  id: string
  name: string
  aliases: Array<string>
  definition_md: string
  space_id: string | null
  space_name: string | null
}

type MentionRow = {
  id: string
  kind: 'note' | 'document'
  sub_kind: string
  name: string
  at: string
  snippet: string | null
  total: number
}

type CompanyRow = { id: string; name: string; reach: number; total: number }

export const termPageProgram = Effect.fn('termPageProgram')(function* (
  userId: string,
  termId: string,
): Effect.fn.Return<TermPage | null, TermPageFailed | SearchQueryFailed> {
  const head = (yield* query(() =>
    db.execute<HeadRow>(sql`
      select t.entity_id as id, t.name, t.aliases, t.definition_md,
             t.space_id, se.canonical_name as space_name
      from term t
      join entity te on te.id = t.entity_id and te.merged_into_id is null
      left join entity se on se.id = t.space_id
      where t.entity_id = ${termId}
    `),
  )).rows.at(0)
  if (!head) return null

  const tsq = termWebsearch(head.name, head.aliases)

  const [mentionRows, companyRows, coRows] = yield* Effect.all(
    [
      query(() =>
        // The cap is applied inside `m`, before ts_headline runs: a headline
        // is the expensive part, and it is cut only for rows that draw.
        db.execute<MentionRow>(sql`
          with q as (select websearch_to_tsquery('english', ${tsq}) as tsq),
          m as (
            select e.id,
                   e.kind::text as kind,
                   coalesce(n.kind::text, d.kind::text, e.kind::text) as sub_kind,
                   coalesce(nullif(n.title, ''), e.canonical_name) as name,
                   coalesce(n.updated_at, e.created_at) as at,
                   coalesce(n.body_md, d.extracted_text, '') as body,
                   count(*) over () as total
            from entity e
            left join note n on n.entity_id = e.id
            left join document d on d.entity_id = e.id
            where e.id in (${mentioningIds(termId, userId)})
            order by at desc, e.id
            limit ${MENTIONS_CAP}
          )
          select m.id, m.kind, m.sub_kind, m.name,
                 to_char(m.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
                 ts_headline('english', m.body, (select tsq from q),
                   ${HEADLINE_OPTIONS}
                 ) as snippet,
                 m.total::int as total
          from m
          order by m.at desc, m.id
        `),
      ),
      query(() =>
        db.execute<CompanyRow>(sql`
          select c.id, c.canonical_name as name,
                 count(distinct l.from_entity_id)::int as reach,
                 (count(*) over ())::int as total
          from link l
          join entity c on c.id = l.to_entity_id
          where l.from_entity_id in (${mentioningIds(termId, userId)})
            and l.relation in ('tagged_in', 'mentions')
            and c.kind = 'company'
            and c.merged_into_id is null
          group by c.id, c.canonical_name
          order by reach desc, name, c.id
          limit ${COMPANIES_CAP}
        `),
      ),
      query(() =>
        db.execute<TermCoMention>(sql`
          select t.entity_id as id, t.name,
                 count(distinct l.from_entity_id)::int as shared
          from link l
          join term t on t.entity_id = l.to_entity_id
          join entity te on te.id = t.entity_id and te.merged_into_id is null
          where l.from_entity_id in (${mentioningIds(termId, userId)})
            and l.relation = 'mentions'
            and t.entity_id <> ${termId}
          group by t.entity_id, t.name
          order by shared desc, t.name, t.entity_id
          limit ${CO_MENTIONED_CAP}
        `),
      ),
    ],
    { concurrency: 'unbounded' },
  )

  const parents = yield* documentParentsProgram(
    mentionRows.rows.filter((r) => r.kind === 'document').map((r) => r.id),
  )

  return {
    term: {
      id: head.id,
      name: head.name,
      aliases: head.aliases,
      definitionMd: head.definition_md,
      space:
        head.space_id && head.space_name !== null
          ? { id: head.space_id, name: head.space_name }
          : null,
    },
    mentions: {
      rows: mentionRows.rows.map((r): TermMention => ({
        id: r.id,
        kind: r.kind,
        subKind: r.sub_kind,
        name: r.name,
        at: r.at,
        // The palette's normalisation, so a snippet reads the same here.
        snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
        parent: parents.get(r.id) ?? null,
      })),
      total: mentionRows.rows.at(0)?.total ?? 0,
    },
    companies: {
      rows: companyRows.rows.map(({ id, name, reach }) => ({
        id,
        name,
        reach,
      })),
      total: companyRows.rows.at(0)?.total ?? 0,
    },
    coMentioned: coRows.rows,
  }
})
