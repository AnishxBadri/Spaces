import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  LedgerFigure,
  LedgerRow,
  ReferenceBar,
  SectionHead,
} from '#/components/ledger-section'
import { KeyHint } from '#/components/page-header'
import { TaskComposer } from '#/components/task-composer'
import { Badge } from '#/components/ui/badge'
import type { BadgeOption } from '#/components/ui/badge'
import { Checkbox } from '#/components/ui/checkbox'
import { Tabs } from '#/components/ui/tabs'
import type { TabItem } from '#/components/ui/tabs'
import type { ReviewGroup } from '#/lib/server-fns'
import {
  daysBetween,
  folded,
  inTab,
  NEEDS_YOU_KINDS,
} from '#/lib/today/needs-you'
import type { NeedsYouKind } from '#/lib/today/needs-you'

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

type Tab = NeedsYouKind | 'all'

const TAB_LABEL: Record<NeedsYouKind, string> = {
  task: 'Tasks',
  deal: 'Deals',
  mark: 'Marks',
  review: 'Review',
}

const EMPTY: Record<Tab, string> = {
  all: 'Nothing needs you.',
  task: 'No tasks due.',
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
  // Review filters by one anchor: a space's discovery cards come back under
  // `record=<space>`; any other group opens the whole queue.
  return group.spaceId !== null && group.toReview === 0 ? (
    <Link to="/review" search={{ record: group.spaceId }} className={rowLink}>
      {children}
    </Link>
  ) : (
    <Link to="/review" className={rowLink}>
      {children}
    </Link>
  )
}

function RowBody({
  row,
  today,
  dealScale,
  onComplete,
}: {
  row: NeedsYouRow
  today: string
  dealScale: number
  onComplete: (id: string) => void
}) {
  switch (row.kind) {
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
            {row.lastMark ? `last mark ${row.lastMark}` : 'never marked'}
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
            {age === 0 ? 'today' : `${age}d`}
          </LedgerFigure>
        </ReviewLink>
      )
    }
  }
}

/**
 * Needs you: one ledger in urgency order with a kind lane, tabs in the head
 * that filter by kind, a fold at eight, and the task composer as its last
 * row. (D79) The caller orders the rows (`byUrgency`).
 */
export function NeedsYou({
  rows,
  today,
  onComplete,
  onCreated,
  washes,
}: {
  rows: ReadonlyArray<NeedsYouRow>
  today: string
  onComplete: (id: string) => void
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
  const items: Array<TabItem<Tab>> = [
    { id: 'all', label: 'All', count: rows.length },
    ...NEEDS_YOU_KINDS.map((k) => ({
      id: k,
      label: TAB_LABEL[k],
      count: rows.filter((r) => r.kind === k).length,
    })),
  ]
  const late = rows.filter((r) => r.kind === 'task' && r.late).length
  return (
    <section className="flex flex-col">
      <SectionHead
        title="Needs you"
        count={late > 0 ? `${rows.length} · ${late} overdue` : `${rows.length}`}
      />
      <Tabs
        label="Needs you by kind"
        items={items}
        value={tab}
        onValueChange={(t) => {
          setTab(t)
          setOpen(false)
        }}
      >
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
              />
            </LedgerRow>
          ))}
          {hidden > 0 ? (
            <LedgerRow>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="focus-ring-inset flex h-full w-full items-center gap-3 text-left mono text-micro text-graphite hover:text-foreground"
              >
                <span className="w-12 shrink-0">+{hidden}</span>
                show all ›
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
      </Tabs>
    </section>
  )
}
