import { Link } from '@tanstack/react-router'
import { EmptyState } from '#/components/empty-state'
import { Highlighted } from '#/components/command-palette'
import {
  InitialsMark,
  RailEmpty,
  RailItem,
  RailSection,
  RecordSection,
} from '#/components/record/record-parts'
import { recordPath } from '#/lib/record-path'
import type { getTermPage } from '#/lib/server-fns'

/**
 * The term page's parts (SPA-75). The page is a record (design contract §3,
 * "a record — the term page"), composed from `record-parts` and nothing new.
 *
 * What is missing is the design: no "file into", no "tag", no "attach", no
 * "track companies". A concept never holds things (CONTEXT.md → Glossary);
 * every list here is something the graph learned by matching the term, and
 * the empty state says so in the litmus' own words.
 */

type Page = NonNullable<Awaited<ReturnType<typeof getTermPage>>>
export type MentionRow = Page['mentions']['rows'][number]
export type CompanyRow = Page['companies']['rows'][number]
export type CoMentionRow = Page['coMentioned'][number]

export const TERM_EMPTY_TITLE = 'Nothing mentions this term yet.'
export const TERM_EMPTY_BODY =
  'A term gathers what mentions it and holds nothing itself — file notes and decks into a space.'

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** Where a mention row lands: a note's page, or the record a document is filed on. */
export function mentionHref(row: MentionRow): string | null {
  if (row.kind === 'note') return recordPath({ kind: 'note', id: row.id })
  return row.parent
    ? recordPath({
        kind: row.parent.kind,
        id: row.parent.id,
        objectSlug: row.parent.objectSlug,
      })
    : null
}

/** The mono lane a mention row ends on: what it is, and where or when. */
function mentionMeta(row: MentionRow): string {
  if (row.kind === 'document')
    return row.parent ? `${row.subKind} · in ${row.parent.name}` : row.subKind
  return `${row.subKind} · ${row.at.slice(5, 10)}`
}

/**
 * Every readable note and document that mentions the term, newest first,
 * each with the snippet Cmd-K would show — cut by the same `ts_headline`
 * options and drawn by the palette's own `Highlighted`, as text.
 */
export function TermMentions({
  rows,
  total,
}: {
  rows: Array<MentionRow>
  total: number
}) {
  if (total === 0) {
    return <EmptyState title={TERM_EMPTY_TITLE} body={TERM_EMPTY_BODY} />
  }
  return (
    <RecordSection
      label="Mentions"
      meta={
        rows.length < total
          ? `newest ${rows.length} of ${total}`
          : plural(total, 'mention', 'mentions')
      }
    >
      <ol>
        {rows.map((row) => (
          <MentionItem key={row.id} row={row} />
        ))}
      </ol>
    </RecordSection>
  )
}

function MentionItem({ row }: { row: MentionRow }) {
  const href = mentionHref(row)
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 truncate font-serif text-title font-medium">
          {row.name || 'Untitled'}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 mono text-micro text-graphite">
          {mentionMeta(row)}
        </span>
      </span>
      {row.snippet ? (
        <span className="block truncate text-label text-graphite">
          <Highlighted text={row.snippet} />
        </span>
      ) : null}
    </>
  )
  return (
    <li className="border-t border-rule">
      {href ? (
        <Link
          to={href}
          className="focus-ring-inset flex flex-col gap-0.5 py-2 hover:bg-bone"
        >
          {body}
        </Link>
      ) : (
        // An unfiled document has no page to land on; it still says it
        // mentions the term.
        <div className="flex flex-col gap-0.5 py-2">{body}</div>
      )}
    </li>
  )
}

/**
 * Companies reached through the mentions — filed on, or named by, an item
 * that mentions the term. Ranked by how many items reach each one.
 */
export function CompaniesReached({
  rows,
  total,
}: {
  rows: Array<CompanyRow>
  total: number
}) {
  return (
    <RailSection
      label="Companies reached"
      meta={rows.length < total ? `${rows.length} of ${total}` : `${total}`}
    >
      {rows.length === 0 ? (
        <RailEmpty>
          No company yet — none of the mentions is filed on or names one.
        </RailEmpty>
      ) : (
        rows.map((c) => (
          <RailItem key={c.id}>
            <InitialsMark name={c.name} />
            <Link
              to="/companies/$companyId"
              params={{ companyId: c.id }}
              className="focus-ring min-w-0 truncate hover:underline"
            >
              {c.name}
            </Link>
            <span className="flex-1" />
            <span
              className="tabular shrink-0 mono text-micro text-graphite"
              title={`${plural(c.reach, 'mention reaches', 'mentions reach')} it`}
            >
              {c.reach}
            </span>
          </RailItem>
        ))
      )}
    </RailSection>
  )
}

/**
 * Terms the same notes and documents mention. Absent, not an empty list,
 * when there are none: a rail saying "nothing" about a word is noise.
 */
export function CoMentioned({ rows }: { rows: Array<CoMentionRow> }) {
  if (rows.length === 0) return null
  return (
    <RailSection label="Co-mentioned" meta={`${rows.length}`}>
      {rows.map((t) => (
        <RailItem key={t.id}>
          <Link
            to="/terms/$termId"
            params={{ termId: t.id }}
            className="focus-ring min-w-0 truncate hover:underline"
          >
            {t.name}
          </Link>
          <span className="flex-1" />
          <span
            className="tabular shrink-0 mono text-micro text-graphite"
            title={`${plural(t.shared, 'item mentions', 'items mention')} both`}
          >
            {t.shared}
          </span>
        </RailItem>
      ))}
    </RailSection>
  )
}
