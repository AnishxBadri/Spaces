import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarDays, Mail, Paperclip, Phone } from 'lucide-react'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import type { RecordTab } from '#/lib/records/record-tabs'
import { threadPeople } from '#/lib/timeline/threads'
import type { ThreadPerson } from '#/lib/timeline/threads'
import { cn } from '#/lib/utils'

/**
 * One thread on a record: the kind glyph, the subject with its message
 * count, the people, the attachment clip and the day, then the summary on a
 * second line when there is one. The viewer is never among the people, and
 * a thread the viewer sent reads `To <name>`.
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
  summary: string | null
}

export const KIND_GLYPHS: Record<string, typeof Mail> = {
  email: Mail,
  meeting: CalendarDays,
  call: Phone,
}

/**
 * A thread's subject: an email opens its window (`?modal=email&id=`), a
 * written-up row opens its note, anything else is plain text.
 */
export function ThreadSubject({
  item,
  tab,
  className,
}: {
  item: Pick<ThreadItem, 'id' | 'kind' | 'subject' | 'noteId'>
  /** The tab the email's window opens over; the link's own when absent. */
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
  if (item.noteId)
    return (
      <Link
        to="/notes/$noteId"
        params={{ noteId: item.noteId }}
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

export function ThreadRow({
  item,
  messages = 1,
  last = false,
  tab,
  highlighted = false,
  menu = null,
}: {
  item: ThreadItem
  /** The tab an email's window opens over. */
  tab?: RecordTab | undefined
  /** How many messages the thread holds; a count prints above 1. */
  messages?: number
  last?: boolean
  /** The thread whose window is open over the list: on bone behind it. */
  highlighted?: boolean | undefined
  /** The row's `···`, after the day; shown on hover. */
  menu?: ReactNode
}) {
  const { today } = useClock()
  const Glyph = KIND_GLYPHS[item.kind] ?? Mail
  const people = threadPeople(item)
  return (
    <li
      data-thread={item.id}
      data-row
      data-highlighted={highlighted ? '' : undefined}
      className={cn(
        'flex flex-col px-3 py-2.25',
        !last && 'border-b border-rule',
        highlighted && 'bg-bone',
      )}
    >
      <div className="flex h-5 min-w-0 items-center gap-3">
        <span className="flex w-4 shrink-0 justify-center">
          <Glyph
            role="img"
            aria-label={item.kind}
            className="size-3.5 text-graphite"
            strokeWidth={1.75}
          />
        </span>
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
          className="w-50 shrink-0 truncate text-label text-graphite"
        >
          {people}
        </span>
        <span
          data-clip
          className="flex w-10 shrink-0 items-center gap-1 mono text-micro text-graphite"
        >
          {item.attachments > 0 ? (
            <>
              <Paperclip
                aria-label="attachments"
                className="size-3"
                strokeWidth={1.75}
              />
              {item.attachments}
            </>
          ) : null}
        </span>
        <time
          dateTime={item.at}
          className="w-18 shrink-0 text-right mono text-micro text-graphite"
        >
          {formatDay(item.at, today)}
        </time>
        {menu === null ? null : (
          <span className="flex w-6 shrink-0 justify-end">{menu}</span>
        )}
      </div>
      {item.summary === null || item.privateBody ? null : (
        <p
          data-summary
          className="truncate pr-81 pl-7 text-label text-graphite"
        >
          {item.summary}
        </p>
      )}
    </li>
  )
}
