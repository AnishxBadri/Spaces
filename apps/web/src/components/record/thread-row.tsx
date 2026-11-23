import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearch } from '@tanstack/react-router'
import { Attachment, Email, Meeting, Phone } from '#/components/icons'
import { Day } from '#/components/ledger-section'
import { openModalId } from '#/lib/modal-search'
import type { RecordTab } from '#/lib/records/record-tabs'
import { useLoggedInteraction } from '#/lib/timeline/log-state'
import { threadPeople } from '#/lib/timeline/threads'
import type { ThreadPerson } from '#/lib/timeline/threads'
import { cn } from '#/lib/utils'

/**
 * One thread on a record. Line one is the kind glyph, the subject with its
 * message count, the people and the day; line two is the summary, or the
 * file names when there is none, with the clip and its count at its right
 * end under the day. The viewer is never among the people, and a thread
 * the viewer sent reads `To <name>`.
 */

/** What a thread row reads off a timeline interaction. */
export type ThreadItem = {
  id: string
  kind: string
  subject: string
  noteId: string | null
  privateBody: boolean
  at: string
  attendees: ReadonlyArray<ThreadPerson>
  sent: boolean
  attachments: number
  /** The names of the files it carries, for a row with no summary. */
  attachmentNames: ReadonlyArray<string>
  summary: string | null
}

/**
 * Which thread sits on bone: the one whose email, meeting or write-up
 * window is open over the tab, and the one just logged.
 */
export function useThreadHighlight(): (
  row: Pick<ThreadItem, 'id' | 'noteId'>,
) => boolean {
  const search = useSearch({ strict: false })
  const logged = useLoggedInteraction()
  const email = openModalId(search, 'email')
  const meeting = openModalId(search, 'meeting')
  const note = openModalId(search, 'note')
  return (row) =>
    row.id === email ||
    row.id === meeting ||
    (row.noteId !== null && row.noteId === note) ||
    row.id === logged
}

export const KIND_GLYPHS: Record<string, typeof Email> = {
  email: Email,
  meeting: Meeting,
  call: Phone,
}

/**
 * A thread's subject: an email opens its window (`?modal=email&id=`), a
 * written-up row its note's (`?modal=note&id=`), anything else is plain
 * text.
 */
export function ThreadSubject({
  item,
  tab,
  className,
}: {
  item: Pick<ThreadItem, 'id' | 'kind' | 'subject' | 'noteId'>
  /** The tab the window opens over; the link's own when absent. */
  tab?: RecordTab | undefined
  className?: string | undefined
}) {
  const link = cn(
    'focus-ring min-w-0 shrink truncate text-ui text-foreground hover:underline',
    className,
  )
  if (item.kind === 'email')
    return (
      <Link
        to="."
        search={(prev) => ({
          ...prev,
          ...(tab === undefined ? {} : { tab }),
          modal: 'email',
          id: item.id,
        })}
        resetScroll={false}
        className={link}
      >
        {item.subject || 'Untitled'}
      </Link>
    )
  const noteId = item.noteId
  if (noteId)
    return (
      <Link
        to="."
        search={(prev) => ({
          ...prev,
          ...(tab === undefined ? {} : { tab }),
          modal: 'note',
          id: noteId,
        })}
        resetScroll={false}
        className={link}
      >
        {item.subject || 'Untitled'}
      </Link>
    )
  return item.subject ? (
    <span
      className={cn(
        'min-w-0 shrink truncate text-ui text-foreground',
        className,
      )}
    >
      {item.subject}
    </span>
  ) : (
    <span className="shrink-0 text-ui text-graphite">Untitled</span>
  )
}

/**
 * The narrow row a list pane draws (the Email page's Threads, 480px): three
 * lines rather than two. The people move under the subject with the records
 * the thread is filed on in ink, and the summary takes a line of its own.
 * The whole row selects; the selected one is bone with a 2px ink bar.
 */
export type ThreadPaneRow = {
  /** The records it is filed on, other than its people. */
  records: ReadonlyArray<string>
  /** The reader holds a draft on it: `Draft` in ink before the day. */
  draft: boolean
  /** The day lane, as the pane prints it (`10:42`, `Tue`, `9 Oct`). */
  day: string
  selected: boolean
  onSelect: () => void
}

/** The clip and how many files, at a line's right end. */
function Clip({ count, className }: { count: number; className?: string }) {
  return (
    <span
      data-clip
      className={cn(
        'flex shrink-0 items-center justify-end gap-1 mono text-micro text-graphite',
        className,
      )}
    >
      <Attachment aria-label="attachments" className="size-4" />
      {count}
    </span>
  )
}

/** The kind glyph in its 16px lane. */
function KindMark({ kind }: { kind: string }) {
  const Glyph = KIND_GLYPHS[kind] ?? Email
  return (
    <span className="flex w-4 shrink-0 justify-center">
      <Glyph role="img" aria-label={kind} className="size-4 text-graphite" />
    </span>
  )
}

export function ThreadRow({
  item,
  messages = 1,
  last = false,
  tab,
  highlighted = false,
  menu = null,
  summaryLines = 1,
  pane,
}: {
  item: ThreadItem
  /** The tab an email's window opens over. */
  tab?: RecordTab | undefined
  /** How many messages the thread holds; a count prints above 1. */
  messages?: number
  last?: boolean
  /** The thread whose window is open over the list, or just logged: on bone. */
  highlighted?: boolean | undefined
  /** The row's `···`, after the day; shown on hover. */
  menu?: ReactNode
  /** How many lines line two runs to: two in the Interactions tab, one elsewhere. */
  summaryLines?: 1 | 2
  /** Drawn narrow, in a list pane, selecting rather than opening a window. */
  pane?: ThreadPaneRow | undefined
}) {
  const people = threadPeople(item)
  // Body-derived, so private with the body.
  const summary = item.privateBody ? null : item.summary
  // Opened from a link, the row may sit below the folder's fold.
  const row = useRef<HTMLLIElement>(null)
  const shown = pane?.selected ?? highlighted
  useEffect(() => {
    if (shown) row.current?.scrollIntoView({ block: 'nearest' })
  }, [shown])
  if (pane !== undefined) {
    const lineThree = summary ?? item.attachmentNames.join(', ')
    return (
      <li
        ref={row}
        data-thread={item.id}
        {...(pane.selected ? { 'data-selected': '' } : {})}
        className={cn(!last && 'border-b border-rule')}
      >
        <button
          type="button"
          aria-current={pane.selected ? 'true' : undefined}
          onClick={pane.onSelect}
          className={cn(
            'focus-ring-inset relative flex w-full flex-col gap-0.5 px-(--inset) py-2.25 text-left transition-colors duration-150 ease-out-quart hover:bg-row-hover',
            pane.selected &&
              'bg-bone before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-hairline',
          )}
        >
          <span className="flex h-5 min-w-0 items-center gap-3">
            <KindMark kind={item.kind} />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span
                className={cn(
                  'min-w-0 truncate text-ui',
                  item.subject === '' ? 'text-graphite' : 'text-foreground',
                )}
              >
                {item.subject || 'Untitled'}
              </span>
              {messages > 1 ? (
                <span
                  data-messages
                  className="shrink-0 mono text-micro text-graphite"
                >
                  {messages}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-baseline gap-2 mono text-micro whitespace-nowrap text-graphite">
              {pane.draft ? (
                <span data-draft-mark className="text-foreground">
                  Draft
                </span>
              ) : null}
              <time dateTime={item.at}>{pane.day}</time>
            </span>
          </span>
          {people === '' &&
          pane.records.length === 0 &&
          item.attachments === 0 ? null : (
            <span className="flex h-4 min-w-0 items-center gap-3 pl-7">
              <span
                data-people
                className="min-w-0 flex-1 truncate text-label text-graphite"
              >
                {people}
                {pane.records.length === 0 ? null : (
                  <span data-records className="text-foreground">
                    {people === '' ? '' : ' · '}
                    {pane.records.join(', ')}
                  </span>
                )}
              </span>
              {item.attachments > 0 ? <Clip count={item.attachments} /> : null}
            </span>
          )}
          {lineThree === '' ? null : (
            <span
              {...(summary === null
                ? { 'data-files': '' }
                : { 'data-summary': '' })}
              className="min-w-0 truncate pl-7 text-label text-graphite"
            >
              {lineThree}
            </span>
          )}
        </button>
      </li>
    )
  }
  return (
    <li
      ref={row}
      data-thread={item.id}
      data-row
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'flex flex-col px-(--inset) py-2.25',
        !last && 'border-b border-rule',
        highlighted && 'bg-bone',
      )}
    >
      <div className="flex h-5 min-w-0 items-center gap-3">
        <KindMark kind={item.kind} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <ThreadSubject item={item} tab={tab} />
          {messages > 1 ? (
            <span
              data-messages
              className="shrink-0 mono text-micro text-graphite"
            >
              {messages}
            </span>
          ) : null}
        </span>
        <span
          data-people
          className="w-60 shrink-0 truncate text-label text-graphite"
        >
          {people}
        </span>
        <Day at={item.at} />
        {menu === null ? null : (
          <span className="flex w-6 shrink-0 justify-end">{menu}</span>
        )}
      </div>
      {summary === null && item.attachments === 0 ? null : (
        <div
          data-line-two
          className={cn(
            'flex min-w-0 items-start gap-6 pl-7',
            // Clear of the `···` lane, so the clip sits under the day.
            menu !== null && 'pr-9',
          )}
        >
          <p
            {...(summary === null
              ? { 'data-files': '' }
              : { 'data-summary': '' })}
            className={cn(
              'min-w-0 flex-1 text-label text-graphite',
              summaryLines === 2 ? 'line-clamp-2' : 'truncate',
            )}
          >
            {summary ?? item.attachmentNames.join(', ')}
          </p>
          {item.attachments > 0 ? (
            <Clip count={item.attachments} className="w-22" />
          ) : null}
        </div>
      )}
    </li>
  )
}
