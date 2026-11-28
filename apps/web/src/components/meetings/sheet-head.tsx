import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { dayKey } from '@spaces/core/format'
import { icon, Time } from '#/components/icons'
import { ProviderMark } from '#/components/provider-mark'
import { Button } from '#/components/ui/button'
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { Stamp } from '#/components/ui/stamp'
import { OpenAsPage, WindowControls } from '#/components/ui/window-controls'
import { googleDayUrl } from '#/lib/meetings/day'
import { headClock, isOver, joinStands, whenLine } from '#/lib/meetings/sheet'
import type { MeetingDetail } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { DateLeaf } from './date-leaf'

/** What holds a sheet: the meeting window, or the Meetings page's pane. */
export type SheetFrame = 'window' | 'pane'

/** The head's facts beyond the window's read. */
export type HeadMeeting = Pick<
  MeetingDetail,
  'id' | 'title' | 'startsAt' | 'endsAt' | 'cancelled' | 'conferenceUrl'
> & {
  kind: 'meeting' | 'call'
  firstMeeting: boolean
}

/**
 * The head's `···`: `Join call ↗` while there is a call to join, and
 * `Open in Google Calendar ↗` for a meeting the calendar holds.
 */
export function sheetMenuItems(
  m: HeadMeeting,
  now: Date,
): Array<MoreMenuEntry> {
  const items: Array<MoreMenuEntry> = []
  if (m.conferenceUrl !== null && !m.cancelled && !isOver(m, now))
    items.push({
      label: 'Join call ↗',
      icon: <icon.openOutside />,
      href: m.conferenceUrl,
      title: 'Opens the call in a new tab',
    })
  if (m.kind === 'meeting')
    items.push({
      label: 'Open in Google Calendar ↗',
      icon: <ProviderMark brand="googleCalendar" />,
      href: googleDayUrl(m.startsAt),
      title: 'Opens the day in Google Calendar',
    })
  return items
}

function HeadFrame({
  frame,
  children,
}: {
  frame: SheetFrame
  children: ReactNode
}) {
  const className =
    'flex h-23 shrink-0 flex-row flex-nowrap items-center gap-4 border-b border-rule bg-paper px-5 py-0'
  return frame === 'window' ? (
    <DialogHeader className={cn('mx-0 mt-0 mb-0 min-h-0', className)}>
      {children}
    </DialogHeader>
  ) : (
    <div data-pane-head className={className}>
      {children}
    </div>
  )
}

/**
 * A meeting sheet's head: the large date leaf, the title in serif with its
 * stamp and, today, its clock, the when-line, then `···` and `Join ↗`. In
 * the window the window's controls follow: `Open as a page`, which opens
 * the Meetings page on this meeting, a divider and the close.
 */
export function SheetHead({
  m,
  frame,
  now,
  today,
  next,
}: {
  m: HeadMeeting
  frame: SheetFrame
  now: Date
  today: string
  /** Whether it is the next meeting today; null when the sheet cannot tell. */
  next: boolean | null
}) {
  const Title = frame === 'window' ? DialogTitle : 'h2'
  const Description = frame === 'window' ? DialogDescription : 'p'
  const when = whenLine(m, today)
  const clock = m.cancelled ? null : headClock(m, now, next)
  const over = isOver(m, now)
  const title = m.title ?? 'Meeting'
  return (
    <HeadFrame frame={frame}>
      <DateLeaf
        size="large"
        day={dayKey(m.startsAt)}
        today={today}
        cancelled={m.cancelled}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <Title
            className={cn(
              'min-w-0 truncate font-serif text-page font-semibold',
              m.cancelled ? 'text-graphite line-through' : 'text-foreground',
            )}
          >
            {title}
          </Title>
          {m.cancelled ? (
            <Stamp kind="Cancelled" tone="destructive" />
          ) : m.firstMeeting ? (
            <Stamp kind="First meeting" />
          ) : null}
          {clock === null ? null : (
            <span
              data-head-clock={clock.kind}
              className="flex shrink-0 items-baseline gap-1.5 mono text-label text-foreground"
            >
              {clock.kind === 'live' ? (
                <span
                  aria-hidden
                  className="size-2 shrink-0 self-center bg-primary"
                />
              ) : (
                <Time
                  aria-hidden
                  className="size-4 shrink-0 self-center text-primary"
                />
              )}
              {clock.text}
            </span>
          )}
        </div>
        <Description
          data-when-line
          className="truncate mono text-label text-graphite"
        >
          {when.day} · <span className="text-foreground">{when.time}</span>
          {when.length === null ? '' : ` · ${when.length}`}
          {when.distance === null ? '' : ` · ${when.distance}`}
        </Description>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <MoreMenu
          variant="head"
          label={title}
          forceMenu
          items={sheetMenuItems(m, now)}
        />
        {m.conferenceUrl !== null && joinStands(m, now) ? (
          <Button asChild>
            <a
              href={m.conferenceUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens the call in a new tab"
            >
              Join ↗
            </a>
          </Button>
        ) : null}
        {frame === 'window' ? (
          <WindowControls
            page={
              <OpenAsPage asChild>
                <Link
                  to="/meetings"
                  search={{ id: m.id, ...(over ? { tab: 'past' } : {}) }}
                />
              </OpenAsPage>
            }
          />
        ) : null}
      </div>
    </HeadFrame>
  )
}
