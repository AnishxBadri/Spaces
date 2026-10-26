import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { duplicateWords, parkedWords } from '#/lib/records/notices'
import type { ParkedEnrich, RecordDuplicate } from '#/lib/records/notices'

function NoticeRow({
  kind,
  children,
  fix,
}: {
  kind: string
  children: ReactNode
  fix: ReactNode
}) {
  return (
    <li
      data-notice={kind}
      className="flex h-8.5 items-center gap-2.5 border-b border-rule px-6 last:border-b-0"
    >
      <span aria-hidden className="size-1.5 shrink-0 bg-warning" />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
        {children}
      </span>
      {fix}
    </li>
  )
}

const fixClass =
  'focus-ring shrink-0 mono text-micro text-primary hover:underline'

/**
 * Under a record head's double rule, only while something needs saying: a
 * record the sweep paired with this one, and an enrichment parked at a
 * source's daily cap. Bone on a rule, 34px rows, each a 6px amber square,
 * the sentence and the link that settles it. Nothing at all otherwise.
 */
export function RecordNotices({
  recordId,
  duplicates = [],
  parked = null,
}: {
  recordId: string
  duplicates?: ReadonlyArray<RecordDuplicate> | undefined
  parked?: ParkedEnrich | null | undefined
}) {
  if (duplicates.length === 0 && parked === null) return null
  return (
    <ul
      aria-label="Notices"
      data-record-notices
      className="shrink-0 border-b border-rule bg-bone"
    >
      {duplicates.map((d) => (
        <NoticeRow
          key={d.pairId}
          kind="duplicate"
          fix={
            <Link
              to="/review"
              search={{ record: recordId, lane: 'duplicates' }}
              className={fixClass}
            >
              Compare ›
            </Link>
          }
        >
          {duplicateWords(d)}
        </NoticeRow>
      ))}
      {parked === null ? null : (
        <NoticeRow
          kind="parked"
          fix={
            <Link to="/settings/enrichment" className={fixClass}>
              Enrichment ›
            </Link>
          }
        >
          {parkedWords(parked)}
        </NoticeRow>
      )}
    </ul>
  )
}
