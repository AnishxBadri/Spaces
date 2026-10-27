import { Link, useRouter } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ReferenceBar, SectionHead } from '#/components/ledger-section'
import { WriteUpButton } from '#/components/meetings/write-up-button'
import { TaskComposer } from '#/components/task-composer'
import type { MenuTask } from '#/components/tasks/task-menu'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { Segmented } from '#/components/ui/segmented'
import type { SegmentedOption } from '#/components/ui/segmented'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  FILTER_ORDER,
  folded,
  foldSummary,
  inFilter,
} from '#/lib/today/needs-you'
import type {
  NeedsFilter,
  NeedsYouKind,
  ReadoutFilter,
} from '#/lib/today/needs-you'
import type {
  Proposal,
  ProposalGroup,
  ProposalLeaf,
} from '#/lib/today/proposals'
import { useHotkeys } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/** What every row carries beside its kind's own fields. */
type RowBase = {
  key: string
  /** Orders the row within its kind (`byUrgency`). */
  weight: number
  /** The name of the record AI never reads on this row; null when none. */
  sensitive: string | null
}

/** One ledger row, by kind. */
export type NeedsYouRow =
  | (RowBase & {
      kind: 'task'
      task: MenuTask
      /** The first linked record's name, for the context line. */
      record: string | null
      /** The assignee; null when it is the reader (H2). */
      who: string | null
      /** `−2d`, `Today`. */
      due: string
      late: boolean
    })
  | (RowBase & {
      kind: 'deal'
      id: string
      name: string
      /** The stage's label: `Diligence`. */
      stage: string
      days: number
      /** The stage's median days; null before the stage has one. */
      median: number | null
      /** The deal's owner. */
      who: string | null
    })
  | (RowBase & {
      kind: 'mark'
      holdingId: string
      company: string
      /** The holding's value, `$3.0M`; null when it cannot be priced. */
      value: string | null
      /** Days since the last mark; null when never marked. */
      age: number | null
    })
  | (RowBase & {
      kind: 'review'
      /** One proposal, or a group of them over its children. */
      proposal: Proposal
      /** Its age, or its time today; null until the clock is read. */
      figure: string | null
    })
  | (RowBase & {
      kind: 'meeting'
      id: string
      title: string
      record: string | null
      /** The first external participant. */
      who: string | null
      /** `2d`, or the time for a meeting today; null until the clock is read. */
      figure: string | null
    })

const SEGMENT_LABEL: Record<NeedsYouKind, string> = {
  task: 'Tasks',
  meeting: 'Meetings',
  deal: 'Deals',
  mark: 'Marks',
  review: 'Review',
}

const EMPTY: Record<NeedsFilter, string> = {
  all: 'Nothing needs you.',
  task: 'No tasks due.',
  meeting: 'No meetings to write up.',
  deal: 'No idle deals.',
  mark: 'No stale marks.',
  review: 'Nothing to review.',
  overdue: 'Nothing overdue.',
  pastMedian: 'No deals past their stage median.',
  oldestMark: 'No stale marks.',
}

/** The lanes every row shares, so a column reads straight down the list. */
const LANE = {
  kind: 'w-16 shrink-0 label-caps text-graphite',
  mark: 'flex w-3.5 shrink-0 items-center justify-center',
  action: 'flex w-30 shrink-0 items-center',
  who: 'w-30 shrink-0 truncate text-label text-graphite',
  figure: 'w-12 shrink-0 text-right mono text-micro',
  more: 'flex w-6 shrink-0 items-center justify-center',
}

/** The primary and its context, the body lane between the mark and action. */
function Body({
  primary,
  context,
  mono = false,
}: {
  primary: ReactNode
  context?: ReactNode
  /** The context is money or a domain. */
  mono?: boolean
}) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 truncate text-body text-foreground">
        {primary}
      </span>
      {context === undefined || context === null ? null : (
        <span
          className={cn(
            'min-w-0 shrink truncate text-graphite',
            mono ? 'mono text-micro' : 'text-label',
          )}
        >
          {context}
        </span>
      )}
    </span>
  )
}

/** A lock in the mark slot: the record on this row is never read by AI. */
function SensitiveMark({ name }: { name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-sensitive
          tabIndex={0}
          aria-label={`Sensitive · AI never reads ${name}`}
          className="focus-ring flex text-graphite"
        >
          <Lock className="size-3" strokeWidth={1.75} aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>Sensitive · AI never reads {name}</TooltipContent>
    </Tooltip>
  )
}

/** A tooltip naming what a control does and the key that does it too. */
function KeyTip({
  label,
  shortcut,
  children,
}: {
  label: string
  shortcut: string
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent data-shortcut-tip>
        <span className="flex items-center gap-2.5">
          <span>{label}</span>
          <kbd className="mono opacity-85">{shortcut}</kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

const rowTarget =
  'focus-ring-inset flex min-w-0 flex-1 items-center gap-3 self-stretch text-left'

/** What a Review row's verbs reach. */
export type ProposalActions = {
  decide: (leaf: ProposalLeaf, verb: 'accept' | 'dismiss') => void
  acceptAll: (group: ProposalGroup) => void
  /** The reader may add an option to an attribute, for everyone. */
  canAddOption: boolean
  /** A child's figure: its age, or its time today; null until the clock is read. */
  since: (at: string) => string | null
}

const verbLink =
  'focus-ring shrink-0 text-label whitespace-nowrap text-foreground hover:underline'

/**
 * The who and figure lanes, which the row's verbs replace while it is
 * hovered or holds the reticle; the row goes bone with them.
 */
function VerbLanes({
  who,
  figure,
  verbs,
}: {
  who: string | null
  figure: string | null
  verbs: ReactNode
}) {
  return (
    <span className="relative flex shrink-0 items-center gap-3 self-stretch">
      <span
        className={cn(
          LANE.who,
          'group-focus-within:invisible group-hover:invisible',
        )}
      >
        {who}
      </span>
      <span
        className={cn(
          LANE.figure,
          'text-graphite group-focus-within:invisible group-hover:invisible',
        )}
      >
        {figure}
      </span>
      <span
        data-verbs
        className="absolute inset-y-0 right-0 hidden items-center gap-2 bg-bone pl-3 group-focus-within:flex group-hover:flex"
      >
        {verbs}
      </span>
    </span>
  )
}

/** A proposal's two verbs: Dismiss, then its primary. */
function LeafVerbs({
  leaf,
  actions,
}: {
  leaf: ProposalLeaf
  actions: ProposalActions
}) {
  const t = leaf.target
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        shortcut="D"
        {...(leaf.dismissTitle === null
          ? {}
          : { 'aria-label': leaf.dismissTitle })}
        onClick={() => actions.decide(leaf, 'dismiss')}
      >
        {leaf.dismiss}
      </Button>
      {t.kind === 'duplicate' ? (
        <Button asChild size="xs" shortcut="A">
          <Link to="/review" search={leaf.review}>
            {leaf.primary}
          </Link>
        </Button>
      ) : t.option !== null && !actions.canAddOption ? null : (
        <Button
          size="xs"
          shortcut="A"
          onClick={() => actions.decide(leaf, 'accept')}
        >
          {leaf.primary}
        </Button>
      )}
    </>
  )
}

/** One proposal's lanes; a group's child draws a rule in its mark slot. */
function LeafLanes({
  leaf,
  figure,
  lock,
  actions,
  child = false,
}: {
  leaf: ProposalLeaf
  figure: string | null
  lock: ReactNode
  actions: ProposalActions
  child?: boolean
}) {
  return (
    <>
      {child ? (
        <span aria-hidden className={cn(LANE.mark, 'self-stretch')}>
          <span data-child-rule className="h-full border-l border-rule" />
        </span>
      ) : (
        <span className={LANE.mark}>{lock}</span>
      )}
      <Link to="/review" search={leaf.review} className={rowTarget}>
        <Body primary={leaf.subject} context={leaf.line} />
      </Link>
      <span className={LANE.action} />
      <VerbLanes
        who={leaf.who}
        figure={figure}
        verbs={<LeafVerbs leaf={leaf} actions={actions} />}
      />
      <span className={LANE.more} />
    </>
  )
}

/** A group's way out: Review on its space or run, or the Ask thread. */
function GroupVerbs({
  group,
  actions,
}: {
  group: ProposalGroup
  actions: ProposalActions
}) {
  const of = group.of
  switch (of.kind) {
    case 'discovery':
      return (
        <Link to="/review" search={{ space: of.spaceId }} className={verbLink}>
          Open in Review ›
        </Link>
      )
    case 'column_run':
      return (
        <>
          <Link to="/review" className={verbLink}>
            Open in Review ›
          </Link>
          {of.attributeSlug === null || of.taken === 0 ? null : (
            <Button
              size="xs"
              shortcut="A"
              onClick={() => actions.acceptAll(group)}
            >
              Accept all {of.taken}
            </Button>
          )}
        </>
      )
    case 'ask_cards':
      return (
        <Link to="/ask" search={{ thread: of.threadId }} className={verbLink}>
          Open thread ›
        </Link>
      )
  }
}

/** A group's lanes: ▸/▾ in the mark slot; the body opens its children. */
function GroupLanes({
  group,
  figure,
  open,
  onToggle,
  actions,
}: {
  group: ProposalGroup
  figure: string | null
  open: boolean
  onToggle: () => void
  actions: ProposalActions
}) {
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={rowTarget}
      >
        <span
          aria-hidden
          className={cn(LANE.mark, 'mono text-micro text-graphite')}
        >
          {open ? '▾' : '▸'}
        </span>
        <Body primary={group.subject} context={group.line} />
      </button>
      <span className={LANE.action} />
      <VerbLanes
        who={group.who}
        figure={figure}
        verbs={<GroupVerbs group={group} actions={actions} />}
      />
      <span className={LANE.more} />
    </>
  )
}

/** The lanes of one row after the kind lane. */
function RowLanes({
  row,
  onComplete,
  onOpen,
  menu,
  dealScale,
  actions,
  expanded,
  onToggle,
}: {
  row: NeedsYouRow
  /** The longest deal's days: the length that fills a reference bar. */
  dealScale: number
  onComplete: (id: string) => void
  onOpen: (row: NeedsYouRow) => void
  menu: (task: MenuTask) => Array<MoreMenuEntry>
  actions: ProposalActions
  /** A group row's children are showing. */
  expanded: boolean
  onToggle: () => void
}) {
  const lock =
    row.sensitive === null ? null : <SensitiveMark name={row.sensitive} />
  switch (row.kind) {
    case 'task':
      return (
        <>
          <span className={LANE.mark}>
            <KeyTip label="Done" shortcut="X">
              <Checkbox
                checked={false}
                onCheckedChange={() => onComplete(row.task.id)}
                aria-label="Complete task"
              />
            </KeyTip>
          </span>
          <KeyTip label="Open" shortcut="↵">
            <Link
              to="/tasks"
              search={{ task: row.task.id }}
              className={rowTarget}
            >
              <Body primary={row.task.content} context={row.record} />
            </Link>
          </KeyTip>
          {/* A task's mark slot holds its checkbox, so its lock trails. */}
          {lock}
          <span className={LANE.action} />
          <span className={LANE.who}>{row.who}</span>
          <span
            className={cn(
              LANE.figure,
              row.late ? 'text-destructive' : 'text-foreground',
            )}
          >
            {row.due}
          </span>
          <span className={LANE.more}>
            <MoreMenu
              variant="row"
              label={row.task.content}
              items={menu(row.task)}
            />
          </span>
        </>
      )
    case 'deal':
      return (
        <>
          <span className={LANE.mark}>{lock}</span>
          <Link
            to="/deals/$dealId"
            params={{ dealId: row.id }}
            className={rowTarget}
          >
            <Body primary={row.name} context={row.stage} />
            {/* A number is never alone beside a median: the bar is the
                days against the stage's median tick. */}
            <span
              className={LANE.action}
              title={
                row.median === null
                  ? 'No median for this stage yet'
                  : `Median ${Math.round(row.median)}d in ${row.stage}`
              }
            >
              <ReferenceBar
                value={row.days}
                median={row.median}
                scale={dealScale}
              />
            </span>
            <span className={LANE.who}>{row.who}</span>
            <span className={cn(LANE.figure, 'text-destructive')}>
              {row.days}d
            </span>
          </Link>
          <span className={LANE.more} />
        </>
      )
    case 'mark':
      return (
        <>
          <span className={LANE.mark}>{lock}</span>
          <button
            type="button"
            onClick={() => onOpen(row)}
            className={rowTarget}
          >
            <Body primary={row.company} context={row.value} mono />
            <span className={LANE.action} />
            <span className={LANE.who} />
            <span className={cn(LANE.figure, 'text-destructive')}>
              {row.age === null ? '—' : `${row.age}d`}
            </span>
          </button>
          <span className={LANE.more} />
        </>
      )
    case 'review':
      return row.proposal.kind === 'group' ? (
        <GroupLanes
          group={row.proposal}
          figure={row.figure}
          open={expanded}
          onToggle={onToggle}
          actions={actions}
        />
      ) : (
        <LeafLanes
          leaf={row.proposal}
          figure={row.figure}
          lock={lock}
          actions={actions}
        />
      )
    case 'meeting':
      return (
        <>
          <span className={LANE.mark}>{lock}</span>
          <button
            type="button"
            onClick={() => onOpen(row)}
            className={rowTarget}
          >
            <Body primary={row.title} context={row.record} />
          </button>
          <span className={LANE.action}>
            <WriteUpButton interactionId={row.id} />
          </span>
          <span className={LANE.who}>{row.who}</span>
          <span className={cn(LANE.figure, 'text-graphite')}>{row.figure}</span>
          <span className={LANE.more} />
        </>
      )
  }
}

/** The rows' kind segments: one per kind with rows, its count beside it. */
function kindSegments(
  rows: ReadonlyArray<NeedsYouRow>,
): Array<SegmentedOption<NeedsFilter>> {
  return FILTER_ORDER.flatMap((k) => {
    const count = rows.filter((r) => r.kind === k).length
    return count > 0 ? [{ id: k, label: SEGMENT_LABEL[k], count }] : []
  })
}

const rowClass =
  'group focus-ring-inset flex h-ledger-row items-center gap-3 border-b border-rule px-3 transition-colors duration-150 ease-out-quart hover:bg-bone'

/**
 * Needs you: one ledger in urgency order. The head is the title and a
 * Segmented by kind (a readout's filter rides after `All` while it is on);
 * the rows share fixed lanes — kind, mark, body, action, who, figure, `···`;
 * the list folds at eight and ends in the task composer.
 * - The caller orders the rows (`byUrgency`) and owns the filter, so a
 *   readout on the page can set it.
 * - A Review row is one proposal, decided in place by its hover verbs, or a
 *   group whose ▸ opens its children under it.
 * - `J`/`K` move the reticle; on a focused row `↵` opens it, `X` completes
 *   a task, and on a proposal `A` is its primary and `D` dismisses it.
 */
export function NeedsYou({
  rows,
  filter,
  onFilter,
  readout,
  loading,
  onComplete,
  onOpen,
  taskMenu,
  onCreated,
  washes,
  actions,
}: {
  rows: ReadonlyArray<NeedsYouRow>
  filter: NeedsFilter
  onFilter: (filter: NeedsFilter) => void
  /** The readout whose filter is on, drawn as a segment after `All`. */
  readout: { id: ReadoutFilter; label: string } | null
  /** The attention read is still coming: its rows are not in yet. */
  loading: boolean
  onComplete: (taskId: string) => void
  /** Opens a meeting or a mark row in place; links open the rest. */
  onOpen: (row: NeedsYouRow) => void
  taskMenu: (task: MenuTask) => Array<MoreMenuEntry>
  onCreated: (id: string) => void
  washes: (id: string) => boolean
  actions: ProposalActions
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // Groups showing their children, by row key.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const list = useRef<HTMLOListElement>(null)
  const inView = inFilter(rows, filter)
  const shown = folded(inView, open)
  const hidden = inView.slice(shown.length)
  const dealScale = Math.max(
    1,
    ...rows.map((r) => (r.kind === 'deal' ? r.days : 0)),
  )

  const segments: Array<SegmentedOption<NeedsFilter>> = [
    { id: 'all', label: 'All' },
    ...(readout === null
      ? []
      : [
          {
            id: readout.id,
            label: readout.label,
            count: inFilter(rows, readout.id).length,
          },
        ]),
    ...kindSegments(rows),
  ]

  const toggle = (key: string) =>
    setExpanded((was) => {
      const next = new Set(was)
      if (!next.delete(key)) next.add(key)
      return next
    })

  /** What a key does on a proposal: ↵ opens it in Review, A and D decide it. */
  function leafKeys(leaf: ProposalLeaf): Map<string, () => void> {
    const review = () =>
      void router.navigate({ to: '/review', search: leaf.review })
    const t = leaf.target
    const primary =
      t.kind === 'duplicate'
        ? review
        : t.option !== null && !actions.canAddOption
          ? null
          : () => actions.decide(leaf, 'accept')
    return new Map([
      ['Enter', review],
      ['d', () => actions.decide(leaf, 'dismiss')],
      ...(primary === null ? [] : [['a', primary] as const]),
    ])
  }

  /** What a key does on a row: ↵ opens it the way a click on its body would. */
  function rowKeys(row: NeedsYouRow): Map<string, () => void> {
    switch (row.kind) {
      case 'task':
        return new Map([
          [
            'Enter',
            () =>
              void router.navigate({
                to: '/tasks',
                search: { task: row.task.id },
              }),
          ],
          ['x', () => onComplete(row.task.id)],
        ])
      case 'deal':
        return new Map([
          [
            'Enter',
            () =>
              void router.navigate({
                to: '/deals/$dealId',
                params: { dealId: row.id },
              }),
          ],
        ])
      case 'review': {
        const p = row.proposal
        if (p.kind === 'leaf') return leafKeys(p)
        const of = p.of
        return new Map([
          ['Enter', () => toggle(row.key)],
          ...(of.kind === 'column_run' &&
          of.attributeSlug !== null &&
          of.taken > 0
            ? [['a', () => actions.acceptAll(p)] as const]
            : []),
        ])
      }
      case 'mark':
      case 'meeting':
        return new Map([['Enter', () => onOpen(row)]])
    }
  }

  /** The reticle: J and K focus the next or previous row, children too. */
  function move(step: 1 | -1) {
    const items =
      list.current === null
        ? []
        : [...list.current.querySelectorAll<HTMLLIElement>('li[data-row]')]
    const at = items.findIndex((el) => el === document.activeElement)
    const next =
      at === -1
        ? step === 1
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, at + step))
    items.at(next)?.focus()
  }
  useHotkeys([
    ['j', () => move(1)],
    ['k', () => move(-1)],
  ])

  function onRowKey(
    e: KeyboardEvent<HTMLLIElement>,
    keys: Map<string, () => void>,
  ) {
    // Only the row itself: a key on a control inside it is the control's.
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey)
      return
    const run = keys.get(e.key === 'Enter' ? e.key : e.key.toLowerCase())
    if (run === undefined) return
    e.preventDefault()
    run()
  }

  return (
    <section aria-label="Needs you" className="flex flex-col">
      <SectionHead
        title="Needs you"
        switch={
          <Segmented
            label="Needs you by kind"
            value={filter}
            onChange={(id) => {
              setOpen(false)
              onFilter(id)
            }}
            options={segments}
          />
        }
      />
      <ol ref={list}>
        {shown.map((r) => {
          const children =
            r.kind === 'review' &&
            r.proposal.kind === 'group' &&
            expanded.has(r.key)
              ? r.proposal.children
              : []
          return (
            <Fragment key={r.key}>
              <li
                data-row
                data-needs-row={r.kind}
                tabIndex={-1}
                onKeyDown={(e) => onRowKey(e, rowKeys(r))}
                className={cn(
                  rowClass,
                  r.kind === 'review' && 'focus-within:bg-bone',
                  r.kind === 'task' && washes(r.task.id) && 'row-wash',
                )}
              >
                <span className={LANE.kind}>{r.kind}</span>
                <RowLanes
                  row={r}
                  dealScale={dealScale}
                  onComplete={onComplete}
                  onOpen={onOpen}
                  menu={taskMenu}
                  actions={actions}
                  expanded={expanded.has(r.key)}
                  onToggle={() => toggle(r.key)}
                />
              </li>
              {children.map((c) => (
                <li
                  key={c.key}
                  data-row
                  data-needs-child
                  tabIndex={-1}
                  onKeyDown={(e) => onRowKey(e, leafKeys(c))}
                  className={cn(rowClass, 'focus-within:bg-bone')}
                >
                  <span className={LANE.kind} />
                  <LeafLanes
                    leaf={c}
                    figure={actions.since(c.at)}
                    lock={null}
                    actions={actions}
                    child
                  />
                </li>
              ))}
            </Fragment>
          )
        })}
        {loading && (filter === 'all' || filter === 'review') ? (
          <li
            data-needs-loading
            className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
          >
            <span className={LANE.kind} />
            <span className={LANE.mark}>
              <Twinkle />
            </span>
            <span className="text-label text-graphite">
              Loading what needs you
            </span>
          </li>
        ) : inView.length === 0 ? (
          <li className="flex h-ledger-row items-center border-b border-rule px-3 text-ui text-graphite">
            {EMPTY[filter]}
          </li>
        ) : null}
        {hidden.length > 0 ? (
          <li className="border-b border-rule">
            <button
              type="button"
              data-fold
              onClick={() => setOpen(true)}
              className="group/fold focus-ring-inset flex h-ledger-row w-full items-center justify-between gap-3 px-3 text-left"
            >
              <span className="min-w-0 truncate text-label text-graphite">
                {foldSummary(hidden)}
              </span>
              <span className="shrink-0 text-label text-foreground group-hover/fold:underline">
                Show all ›
              </span>
            </button>
          </li>
        ) : null}
        <li>
          <TaskComposer
            hotkey="t"
            onCreated={onCreated}
            trigger={
              <button
                type="button"
                data-composer-row
                className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 px-3 text-left transition-colors duration-150 ease-out-quart hover:bg-bone"
              >
                <span
                  aria-hidden
                  className="w-16 shrink-0 mono text-ui text-graphite"
                >
                  +
                </span>
                <span className={LANE.mark} />
                <span className="min-w-0 flex-1 truncate text-body text-graphite">
                  Add a task…
                </span>
                <kbd className="shrink-0 mono text-micro text-graphite">T</kbd>
              </button>
            }
          />
        </li>
      </ol>
    </section>
  )
}
