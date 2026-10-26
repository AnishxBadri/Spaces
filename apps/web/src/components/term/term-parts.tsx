import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Highlighted } from '#/components/command-palette'
import {
  InitialsMark,
  RailItem,
  RailSection,
  RecordSection,
} from '#/components/record/record-parts'
import { recordPath } from '#/lib/record-path'
import { formatWhen } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import type { getTermPage } from '#/lib/server-fns'

/**
 * The term page's parts: a record page, composed from `record-parts` and
 * nothing new.
 * - What is missing is the design: no "file into", "tag", "attach" or "track
 *   companies". A concept never holds things; every list here is what the
 *   graph learned by matching the term.
 * - The empty state's one primary writes a note that mentions it.
 */

type Page = NonNullable<Awaited<ReturnType<typeof getTermPage>>>
export type MentionRow = Page['mentions']['rows'][number]
export type CompanyRow = Page['companies']['rows'][number]
export type CoMentionRow = Page['coMentioned'][number]

export const TERM_EMPTY = 'Nothing mentions this term yet.'

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
function mentionMeta(row: MentionRow, now: string): string {
  if (row.kind === 'document')
    return row.parent ? `${row.subKind} · in ${row.parent.name}` : row.subKind
  return `${row.subKind} · ${formatWhen(row.at, now)}`
}

/**
 * Every readable note and document that mentions the term, newest first,
 * each with the snippet Cmd-K would show — cut by the same `ts_headline`
 * options and drawn by the palette's own `Highlighted`, as text.
 */
export function TermMentions({
  rows,
  total,
  action,
}: {
  rows: Array<MentionRow>
  total: number
  /** The empty state's one primary. */
  action?: ReactNode
}) {
  if (total === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-ui text-graphite">{TERM_EMPTY}</p>
        {action}
      </div>
    )
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
  const { now } = useClock()
  const href = mentionHref(row)
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 truncate font-serif text-title font-medium">
          {row.name || 'Untitled'}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 mono text-micro text-graphite">
          {mentionMeta(row, now)}
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
    <li className="border-b border-rule">
      {href ? (
        <Link
          to={href}
          className="focus-ring-inset flex flex-col gap-0.5 px-3 py-2 hover:bg-bone"
        >
          {body}
        </Link>
      ) : (
        // An unfiled document has no page to land on; it still says it
        // mentions the term.
        <div className="flex flex-col gap-0.5 px-3 py-2">{body}</div>
      )}
    </li>
  )
}

/**
 * Companies reached through the mentions — filed on, or named by, an item
 * that mentions the term. Ranked by how many items reach each one. Absent
 * when none is: nothing adds a company here, so an empty row would offer a
 * way in that does not exist.
 */
export function CompaniesReached({
  rows,
  total,
}: {
  rows: Array<CompanyRow>
  total: number
}) {
  if (rows.length === 0) return null
  return (
    <RailSection
      label="Companies reached"
      meta={rows.length < total ? `${rows.length} of ${total}` : `${total}`}
    >
      {rows.map((c) => (
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
      ))}
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
