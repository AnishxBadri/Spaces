import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  LedgerFigure,
  LedgerRow,
  ReferenceBar,
  SectionHead,
} from '#/components/ledger-section'
import { WriteUpButton } from '#/components/meetings/write-up-button'
import { KeyHint } from '#/components/page-header'
import { TaskComposer } from '#/components/task-composer'
import { Badge } from '#/components/ui/badge'
import type { BadgeOption } from '#/components/ui/badge'
import { Checkbox } from '#/components/ui/checkbox'
import type { ReviewGroup } from '#/lib/server-fns'
import {
  daysBetween,
  FILTER_ORDER,
  folded,
  foldSummary,
  inTab,
  NEEDS_YOU_FOLD,
} from '#/lib/today/needs-you'
import type { NeedsYouKind } from '#/lib/today/needs-you'
import { formatAge, formatDay } from '@spaces/core/format'
import { cn } from '#/lib/utils'

export type StageBadge = {
  option: BadgeOption
  index: number
  archived: boolean
  label: string
}

/** One ledger row; `weight` orders it within its kind (`byUrgency`). */
export type NeedsYouRow =
  | {
      kind: 'task'
      key: string
      weight: number
      id: string
      content: string
      record: string | null
      assignee: string | null
      /** `−2d`, `today`. */
      due: string
      late: boolean
    }
  | {
      kind: 'deal'
      key: string
      weight: number
      id: string
      name: string
      days: number
      median: number | null
      stage: StageBadge
    }
  | {
      kind: 'mark'
      key: string
      weight: number
      holdingId: string
      company: string
      lastMark: string | null
      /** Days since the last mark; null when never marked. */
      age: number | null
    }
  | { kind: 'review'; key: string; weight: number; group: ReviewGroup }
  | {
      kind: 'meeting'
      key: string
      weight: number
      id: string
      title: string
      /** The first linked record, for the mono lane. */
      record: string | null
      /** `today`, `2d`; null until the browser's clock is read. */
      age: string | null
    }

type Tab = NeedsYouKind | 'all'

const TAB_LABEL: Record<NeedsYouKind, string> = {
  task: 'Tasks',
  meeting: 'Meetings',
  deal: 'Deals',
  mark: 'Marks',
  review: 'Review',
}

const EMPTY: Record<Tab, string> = {
  all: 'Nothing needs you.',
  task: 'No tasks due.',
  meeting: 'No meetings to write up.',
  deal: 'No idle deals.',
  mark: 'No stale marks.',
  review: 'Nothing to review.',
}

const rowLink =
  'focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 hover:bg-bone'

/** The 48px mono lane every row starts on. */
function KindLane({ kind }: { kind: NeedsYouKind }) {
  return (
    <span className="w-12 shrink-0 mono text-micro text-graphite">{kind}</span>
  )
}

/** `3 to add · 1 to file · 2 to review`, leaving out the zeros. */
export function reviewCounts(g: ReviewGroup): string {
  return [
    g.toAdd > 0 ? `${g.toAdd} to add` : null,
    g.toFile > 0 ? `${g.toFile} to file` : null,
    g.toReview > 0 ? `${g.toReview} to review` : null,
  ]
    .filter((s) => s !== null)
    .join(' · ')
}

function ReviewLink({
  group,
  children,
}: {
  group: ReviewGroup
  children: ReactNode
}) {
  // The row opens the queue filtered to its source and space.
  return (
    <Link
      to="/review"
      search={{
        ...(group.sourceRef === null ? {} : { source: group.sourceRef }),
        ...(group.spaceId === null ? {} : { space: group.spaceId }),
      }}
      className={rowLink}
    >
      {children}
    </Link>
  )
}

/**
 * A past meeting with no write-up: the title opens the meeting window, and
 * Write writes one now and lands in the editor.
 */
function MeetingRow({
  row,
  onOpenMeeting,
}: {
  row: Extract<NeedsYouRow, { kind: 'meeting' }>
  onOpenMeeting: (id: string) => void
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenMeeting(row.id)}
        className={cn(rowLink, 'text-left')}
      >
        <KindLane kind="meeting" />
        <span className="min-w-0 truncate text-body font-medium">
          {row.title}
        </span>
        {row.record ? (
          <span className="shrink-0 truncate mono text-micro text-graphite">
            {row.record}
          </span>
        ) : null}
      </button>
      <WriteUpButton interactionId={row.id} />
      <LedgerFigure tone="muted">{row.age}</LedgerFigure>
    </>
  )
}

function RowBody({
  row,
  today,
  dealScale,
  onComplete,
  onOpenMeeting,
}: {
  row: NeedsYouRow
  today: string
  dealScale: number
  onComplete: (id: string) => void
  onOpenMeeting: (id: string) => void
}) {
  switch (row.kind) {
    case 'meeting':
      return <MeetingRow row={row} onOpenMeeting={onOpenMeeting} />
    case 'task':
      return (
        <>
          <KindLane kind="task" />
          <Checkbox
            checked={false}
            onCheckedChange={() => onComplete(row.id)}
            aria-label="Complete task"
          />
          <span className="min-w-0 truncate text-body">{row.content}</span>
          {row.record ? (
            <span className="shrink-0 truncate mono text-micro text-graphite">
              {row.record}
            </span>
          ) : null}
          <span className="flex-1" />
          {row.assignee ? (
            <span className="shrink-0 mono text-micro text-graphite">
              {row.assignee}
            </span>
          ) : null}
          <LedgerFigure tone={row.late ? 'bad' : undefined}>
            {row.due}
          </LedgerFigure>
        </>
      )
    case 'deal':
      return (
        <Link
          to="/deals/$dealId"
          params={{ dealId: row.id }}
          className={rowLink}
        >
          <KindLane kind="deal" />
          <span className="w-65 shrink-0 truncate text-body font-medium">
            {row.name}
          </span>
          <span className="flex w-[6.875rem] shrink-0">
            <Badge
              option={row.stage.option}
              index={row.stage.index}
              archived={row.stage.archived}
              className="h-[1.125rem]"
            >
              {row.stage.label}
            </Badge>
          </span>
          <span
            className="flex shrink-0"
            title={
              row.median === null
                ? 'No median for this stage yet'
                : `Median ${Math.round(row.median)}d in ${row.stage.label}`
            }
          >
            <ReferenceBar
              value={row.days}
              median={row.median}
              scale={dealScale}
            />
          </span>
          <span className="flex-1" />
          <LedgerFigure tone="bad">{row.days}d</LedgerFigure>
        </Link>
      )
    case 'mark':
      return (
        <Link
          to="/portfolio/$holdingId"
          params={{ holdingId: row.holdingId }}
          className={rowLink}
        >
          <KindLane kind="mark" />
          <span className="w-65 shrink-0 truncate text-body font-medium">
            {row.company}
          </span>
          <span className="min-w-0 truncate mono text-micro text-graphite">
            {row.lastMark
              ? `last mark ${formatDay(row.lastMark, today)}`
              : 'never marked'}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 mono text-micro text-primary">
            record mark ›
          </span>
          <LedgerFigure tone="bad">
            {row.age === null ? '—' : `${row.age}d`}
          </LedgerFigure>
        </Link>
      )
    case 'review': {
      const g = row.group
      const age = Math.max(0, daysBetween(g.oldestAt, today))
      return (
        <ReviewLink group={g}>
          <KindLane kind="review" />
          <span className="min-w-0 truncate text-body font-medium">
            {g.spaceLabel ?? 'Not filed'}
          </span>
          <span className="min-w-0 truncate mono text-micro text-graphite">
            via {g.source} · {reviewCounts(g)}
          </span>
          <span className="flex-1" />
          <LedgerFigure tone="muted">
            {age === 0 ? 'today' : formatAge(g.oldestAt, today)}
          </LedgerFigure>
        </ReviewLink>
      )
    }
  }
}

/**
 * Needs you: one ledger in urgency order with a kind lane, sentence-case
 * filters in the head by kind, a fold at eight, and the task composer as its last
 * row. The caller orders the rows (`byUrgency`).
 */
export function NeedsYou({
  rows,
  today,
  onComplete,
  onOpenMeeting,
  onCreated,
  washes,
}: {
  rows: ReadonlyArray<NeedsYouRow>
  today: string
  onComplete: (id: string) => void
  /** Opens the meeting window over Today. */
  onOpenMeeting: (id: string) => void
  onCreated: (id: string) => void
  washes: (id: string) => boolean
}) {
  const [tab, setTab] = useState<Tab>('all')
  const [open, setOpen] = useState(false)
  const inView = inTab(rows, tab)
  const shown = folded(inView, open)
  const hidden = inView.length - shown.length
  const dealScale = Math.max(
    1,
    ...rows.map((r) => (r.kind === 'deal' ? r.days : 0)),
  )
  // A kind with nothing in it has no filter, unless it is the one chosen.
  const filters = FILTER_ORDER.flatMap((k) => {
    const count = rows.filter((r) => r.kind === k).length
    return count > 0 || tab === k ? [{ id: k, count }] : []
  })
  const choose = (t: Tab) => {
    setTab(t)
    setOpen(false)
  }
  const late = rows.filter((r) => r.kind === 'task' && r.late).length
  return (
    <section className="flex flex-col">
      <SectionHead
        title="Needs you"
        count={late > 0 ? `${rows.length} · ${late} overdue` : `${rows.length}`}
        action={
          <div
            role="group"
            aria-label="Needs you by kind"
            className="flex items-baseline gap-3.5"
          >
            <FilterButton active={tab === 'all'} onClick={() => choose('all')}>
              All
            </FilterButton>
            {filters.map((f) => (
              <FilterButton
                key={f.id}
                active={tab === f.id}
                onClick={() => choose(f.id)}
              >
                {`${TAB_LABEL[f.id]} ${f.count}`}
              </FilterButton>
            ))}
          </div>
        }
      />
      <ol>
        {inView.length === 0 ? (
          <LedgerRow>
            <span className="text-ui text-graphite">{EMPTY[tab]}</span>
          </LedgerRow>
        ) : null}
        {shown.map((r) => (
          <LedgerRow
            key={r.key}
            wash={r.kind === 'task' ? washes(r.id) : undefined}
          >
            <RowBody
              row={r}
              today={today}
              dealScale={dealScale}
              onComplete={onComplete}
              onOpenMeeting={onOpenMeeting}
            />
          </LedgerRow>
        ))}
        {hidden > 0 ? (
          <LedgerRow>
            <button
              type="button"
              data-fold
              onClick={() => setOpen(true)}
              className="group focus-ring-inset flex h-full w-full items-center justify-between gap-3 text-left mono text-micro text-graphite"
            >
              <span className="min-w-0 truncate">
                {foldSummary(inView.slice(NEEDS_YOU_FOLD))}
              </span>
              <span className="shrink-0 text-primary group-hover:underline">
                show all ›
              </span>
            </button>
          </LedgerRow>
        ) : null}
        <LedgerRow last>
          <TaskComposer
            hotkey="t"
            onCreated={onCreated}
            trigger={
              <button
                type="button"
                className="focus-ring-inset flex h-full w-full items-center gap-3 text-left"
              >
                <span className="w-12 shrink-0 mono text-micro text-primary">
                  +
                </span>
                <span className="min-w-0 truncate text-body text-graphite">
                  Add a task…
                </span>
                <span className="flex-1" />
                <KeyHint>T</KeyHint>
              </button>
            }
          />
        </LedgerRow>
      </ol>
    </section>
  )
}

/** One kind filter in the ledger head: sentence case, ink when chosen. */
function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring font-sans text-ui transition-colors duration-150 ease-out-quart',
        active
          ? 'font-medium text-foreground'
          : 'text-graphite hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
