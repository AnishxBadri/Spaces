import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'
import { duplicateWords, parkedWords } from '#/lib/records/notices'
import type { ParkedEnrich, RecordDuplicate } from '#/lib/records/notices'
import { useRecordArchive } from './record-archive'
import type { RecordArchive } from './record-archive'

function NoticeRow({
  kind,
  children,
  fix,
  tone = 'warn',
}: {
  kind: string
  children: ReactNode
  fix: ReactNode
  /** Amber for something to settle; graphite for a state, like archived. */
  tone?: 'warn' | 'state' | undefined
}) {
  return (
    <li
      data-notice={kind}
      className="flex h-8.5 items-center gap-2.5 border-b border-rule px-6 last:border-b-0"
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0',
          tone === 'warn' ? 'bg-warning' : 'bg-graphite',
        )}
      />
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
 * Under a record head's double rule, only while something needs saying: the
 * record archived, a record the sweep paired with this one, and an
 * enrichment parked at a source's daily cap. Bone on a rule, 34px rows, each
 * a 6px square, the sentence and the link that settles it. Nothing at all
 * otherwise.
 */
export function RecordNotices({
  recordId,
  archive = null,
  duplicates = [],
  parked = null,
}: {
  recordId: string
  archive?: RecordArchive | null | undefined
  duplicates?: ReadonlyArray<RecordDuplicate> | undefined
  parked?: ParkedEnrich | null | undefined
}) {
  if (archive === null && duplicates.length === 0 && parked === null)
    return null
  return (
    <ul
      aria-label="Notices"
      data-record-notices
      className="shrink-0 border-b border-rule bg-bone"
    >
      {archive === null ? null : (
        <ArchivedNotice recordId={recordId} archive={archive} />
      )}
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

/** `Archived 12 Oct by Anish` and the one way back. */
function ArchivedNotice({
  recordId,
  archive,
}: {
  recordId: string
  archive: RecordArchive
}) {
  const { today } = useClock()
  const { restore } = useRecordArchive(recordId)
  return (
    <NoticeRow
      kind="archived"
      tone="state"
      fix={
        <button
          type="button"
          onClick={() => void restore()}
          className={fixClass}
        >
          Restore ›
        </button>
      }
    >
      Archived {formatDay(archive.on, today)}
      {archive.by === null ? null : ` by ${archive.by}`}
    </NoticeRow>
  )
}
