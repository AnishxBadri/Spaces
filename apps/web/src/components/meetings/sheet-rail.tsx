import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Video } from '#/components/icons'
import { KindIcon } from '#/components/kind-icon'
import { LabelHead } from '#/components/ledger-section'
import { DetailsPickRow } from '#/components/record/details-add'
import type { PickHit } from '#/components/record/details-add'
import { callPlace } from '#/lib/meetings/sheet'
import { recordPath } from '#/lib/record-path'
import type { MeetingRecord, SheetPerson } from '#/lib/server-fns'
import { NameMark } from './name-mark'
import { ReplyMark } from './reply-mark'

/** A rail group head's way out: sans, ink, on the head's right. */
const HEAD_LINK =
  'focus-ring shrink-0 text-label text-foreground hover:underline'

/**
 * A group on the meeting's bone rail: its label in mono caps graphite, the
 * count in ink, on a hairline; the rows under it on rules.
 */
function RailGroup({
  label,
  count,
  action,
  children,
}: {
  label: string
  count?: number | undefined
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={label} className="flex shrink-0 flex-col">
      <LabelHead
        label={
          <>
            <span className="text-graphite">{label}</span>
            {count === undefined ? null : (
              <span className="ml-1.5 mono text-micro tracking-normal">
                {count}
              </span>
            )}
          </>
        }
        className="bg-transparent px-0"
      >
        {action}
      </LabelHead>
      <ol>{children}</ol>
    </section>
  )
}

const COPIED_MS = 1200

/** `Copy link`, then `Copied` for a moment. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      className={HEAD_LINK}
      onClick={() =>
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), COPIED_MS)
        })
      }
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

/**
 * `Where`: the call, by its service and its room's code, with `Copy link`
 * while the meeting is ahead; a past meeting names the service alone. No
 * group when nothing is stored.
 */
export function WhereGroup({
  conferenceUrl,
  over,
}: {
  conferenceUrl: string | null
  /** The meeting has ended. */
  over: boolean
}) {
  if (conferenceUrl === null) return null
  const place = callPlace(conferenceUrl)
  return (
    <RailGroup
      label="Where"
      action={over ? undefined : <CopyLink url={conferenceUrl} />}
    >
      <li
        data-where
        className="flex h-9 items-center gap-3 border-b border-rule"
      >
        <Video aria-hidden className="size-4 shrink-0 text-graphite" />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">
          {place.name}
        </span>
        {over || place.code === null ? null : (
          <span className="shrink-0 mono text-micro text-graphite">
            {place.code}
          </span>
        )}
      </li>
    </RailGroup>
  )
}

/**
 * `People n`: each person by name with `HOST` and `NEW` after it, their
 * company and title (or `You`) under it, and, while the meeting is ahead,
 * how they answered. Answers change in Google Calendar, never here.
 */
export function PeopleGroup({
  people,
  over,
  calendarUrl,
}: {
  people: ReadonlyArray<SheetPerson>
  over: boolean
  /** Google Calendar on the meeting's day; null for a call. */
  calendarUrl: string | null
}) {
  if (people.length === 0) return null
  return (
    <RailGroup
      label="People"
      count={people.length}
      action={
        over || calendarUrl === null ? undefined : (
          <a
            href={calendarUrl}
            target="_blank"
            rel="noreferrer"
            title="Answers change in Google Calendar"
            className={HEAD_LINK}
          >
            Google Calendar ↗
          </a>
        )
      }
    >
      {people.map((p) => (
        <li
          key={p.email}
          data-participant={p.email}
          title={p.email}
          className="flex items-center gap-3 border-b border-rule py-2"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-ui text-foreground">
                {p.name}
              </span>
              {p.host ? <NameMark word="Host" /> : null}
              {p.new ? <NameMark word="New" /> : null}
            </span>
            {p.you ? (
              <span className="text-label text-graphite">You</span>
            ) : p.line === null ? null : (
              <span className="truncate text-label text-graphite">
                {p.line}
              </span>
            )}
          </span>
          {over ? null : <ReplyMark rsvp={p.rsvp} />}
        </li>
      ))}
    </RailGroup>
  )
}

/** A record's name on the rail, the row its link. */
const ROW_LINK =
  'focus-ring-inset flex h-full min-w-0 flex-1 items-center text-left hover:underline'

/**
 * `Records`: the company and the deal, each by its kind icon, then
 * `Pin a record…`, the one manual edge.
 */
export function RecordsGroup({
  records,
  search,
  onPin,
}: {
  records: ReadonlyArray<MeetingRecord>
  search: (q: string) => Promise<ReadonlyArray<PickHit>>
  onPin: (hit: PickHit) => Promise<void>
}) {
  return (
    <RailGroup label="Records">
      {records.map((r) => {
        const to = recordPath(r)
        return (
          <li
            key={r.id}
            className="flex h-9 items-center gap-3 border-b border-rule"
          >
            <KindIcon of={{ kind: r.kind }} />
            {to === null ? (
              <span className="min-w-0 flex-1 truncate text-ui">{r.name}</span>
            ) : (
              <Link to={to} className={ROW_LINK}>
                <span className="min-w-0 truncate text-ui">{r.name}</span>
              </Link>
            )}
          </li>
        )
      })}
      <li>
        <DetailsPickRow
          label="Pin a record…"
          placeholder="Company, person or deal…"
          search={search}
          onPick={onPin}
        />
      </li>
    </RailGroup>
  )
}
