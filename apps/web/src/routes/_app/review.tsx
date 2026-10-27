import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeftRight, Check, Inbox, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#/components/empty-state'
import { SuggestionCard } from '#/components/inbox/suggestion-card'
import { ColumnRunGroup } from '#/components/inbox/column-run-group'
import { DiscoveryGroup } from '#/components/inbox/discovery-group'
import { AskThreadGroup } from '#/components/inbox/ask-thread-group'
import { PageHeader } from '#/components/page-header'
import { PluginStatusSection } from '#/components/plugin-status-section'
import { Button } from '#/components/ui/button'
import { Tabs } from '#/components/ui/tabs'
import {
  dismissDuplicate,
  listInbox,
  listStoppedPlugins,
  mergeDuplicate,
  runDedupeSweep,
} from '#/lib/server-fns'
import type {
  AskCardsRow,
  ColumnRunRow,
  DiscoveryRow,
  DuplicateCandidateRow,
  InboxFilterLabels,
  InboxKind,
  InboxLane,
  InboxSide,
  SuggestionRow,
} from '#/lib/server-fns'
import { defaultKeeper } from '#/lib/inbox/keeper'
import { hasOpenItems, withoutHeld } from '#/lib/inbox/held'
import { heldDecisions, useHeldView } from '#/lib/held-decisions'
import { recordPath } from '#/lib/record-path'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * Review — the queue, and the one surface every review lane joins.
 * `/inbox` and `/dedupe` redirect here.
 */
/**
 * `record` scopes both lanes to one entity (the record rail's "Waiting"
 * chips link here); `source` and `space` are a Today Review row's
 * filter. All three are loader deps, since they change what the server
 * sends. `lane` only seeds the tab on arrival and is not a dep: the
 * tabs stay React state. `.catch` rather than a failure, so a
 * hand-typed bad value lands on the whole queue, not an error boundary.
 */
const inboxSearch = z.object({
  record: z.string().uuid().optional().catch(undefined),
  source: z.string().min(1).max(100).optional().catch(undefined),
  space: z.string().uuid().optional().catch(undefined),
  lane: z
    .enum(['all', 'suggestions', 'duplicates'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/_app/review')({
  validateSearch: inboxSearch,
  loaderDeps: ({ search }) => ({
    record: search.record ?? null,
    source: search.source ?? null,
    space: search.space ?? null,
  }),
  loader: async ({ deps }) => {
    const [inbox, stoppedPlugins] = await Promise.all([
      listInbox({ data: deps }),
      listStoppedPlugins(),
    ])
    return { ...inbox, stoppedPlugins }
  },
  component: InboxPage,
})

/**
 * What the queue knows about a row before its kind is read. The dispatch
 * deliberately works at this width: a row whose kind this build has no
 * member for is the case the fallback exists for, and it cannot be typed
 * as an `InboxRow`.
 */
export type QueueRow = { kind: string }

type RowProps = { row: QueueRow; index: number; total: number }
type InboxRenderer = (props: RowProps) => React.ReactNode

function isDuplicateCandidate(row: QueueRow): row is DuplicateCandidateRow {
  return row.kind === 'duplicate_candidate' && 'a' in row && 'b' in row
}

function isColumnRunRow(row: QueueRow): row is ColumnRunRow {
  return (
    row.kind === 'column_run' &&
    'run' in row &&
    'cards' in row &&
    Array.isArray(row.cards)
  )
}

function isDiscoveryRow(row: QueueRow): row is DiscoveryRow {
  return (
    row.kind === 'discovery' &&
    'space' in row &&
    'via' in row &&
    'suggestions' in row &&
    Array.isArray(row.suggestions)
  )
}

function isAskCardsRow(row: QueueRow): row is AskCardsRow {
  return (
    row.kind === 'ask_cards' &&
    'title' in row &&
    'cards' in row &&
    Array.isArray(row.cards)
  )
}

function isSuggestionRow(row: QueueRow): row is SuggestionRow {
  return (
    row.kind === 'suggestion' &&
    'record' in row &&
    'suggestions' in row &&
    Array.isArray(row.suggestions)
  )
}

/**
 * One renderer per row kind. **Add a member to `InboxRow` and a renderer
 * here, never a page** — that is the whole contract of this surface. A kind
 * with no renderer
 * falls back to `PayloadFallback` rather than taking the list down with it,
 * so a row written by a newer build degrades to its payload instead of a
 * blank screen.
 */
const RENDERERS: Record<InboxKind, InboxRenderer> = {
  duplicate_candidate: ({ row }) =>
    isDuplicateCandidate(row) ? (
      <PairCard pair={row} />
    ) : (
      <PayloadFallback row={row} />
    ),
  suggestion: ({ row }) =>
    isSuggestionRow(row) ? (
      <SuggestionCard card={row} />
    ) : (
      <PayloadFallback row={row} />
    ),
  column_run: ({ row }) =>
    isColumnRunRow(row) ? (
      <ColumnRunGroup group={row} />
    ) : (
      <PayloadFallback row={row} />
    ),
  discovery: ({ row }) =>
    isDiscoveryRow(row) ? (
      <DiscoveryGroup group={row} />
    ) : (
      <PayloadFallback row={row} />
    ),
  ask_cards: ({ row }) =>
    isAskCardsRow(row) ? (
      <AskThreadGroup group={row} />
    ) : (
      <PayloadFallback row={row} />
    ),
}

const BY_KIND = new Map<string, InboxRenderer>(Object.entries(RENDERERS))

/** The dispatch itself, exported so `review.test.tsx` can exercise the miss. */
export function rendererFor(kind: string): InboxRenderer {
  return BY_KIND.get(kind) ?? PayloadFallback
}

/** What an unknown kind renders as: the row, legible, and nothing thrown. */
export function PayloadFallback({ row }: { row: QueueRow }): React.ReactNode {
  return (
    <li className="flex flex-col border border-hairline bg-paper">
      <div className="flex min-h-11 items-baseline gap-3 border-b border-hairline px-5 py-2.5">
        <h2 className="font-serif text-lg leading-5.5 font-semibold">
          Unrecognized item
        </h2>
        <span className="mono text-micro text-graphite">{row.kind}</span>
      </div>
      <pre className="overflow-x-auto px-5 py-3 mono text-micro text-graphite">
        {JSON.stringify(row, null, 2)}
      </pre>
    </li>
  )
}

/** Why the sweep paired them, in the card's mono line: `Same domain`. */
function reasonLabel(pair: DuplicateCandidateRow): string {
  if (pair.reason.shared) return `Same ${pair.reason.shared}`
  if (pair.reason.name_similarity)
    return `Names ${Math.round(pair.score * 100)}% alike`
  return 'Possibly the same'
}

/**
 * The filter over the one queue: All, or one lane. React state only — it
 * does not survive navigation, and it never changes what the server sends.
 */
type Lane = 'all' | InboxLane

/** A column run's group is suggestions, gathered — it sits in that tab. */
const laneOf = (kind: string): InboxLane =>
  kind === 'duplicate_candidate' ? 'duplicate_candidate' : 'suggestion'

const LANES: Array<{ key: Lane; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'suggestion', label: 'Suggestions' },
  { key: 'duplicate_candidate', label: 'Duplicates' },
]

/** The URL's lane words, onto the tab state they seed. */
const LANE_PARAM: Record<'all' | 'suggestions' | 'duplicates', Lane> = {
  all: 'all',
  suggestions: 'suggestion',
  duplicates: 'duplicate_candidate',
}

function InboxPage() {
  const loaded = Route.useLoaderData()
  const { scope, filter, stoppedPlugins } = loaded
  const search = Route.useSearch()
  const [lane, setLane] = useState<Lane>(
    search.lane ? LANE_PARAM[search.lane] : 'all',
  )
  // Held decisions leave the queue for their undo window. `kept` still
  // mounts an emptied discovery group; `rows` is what counts.
  const kept = withoutHeld(loaded.rows, useHeldView())
  const rows = kept.filter(hasOpenItems)
  const inLane = (row: QueueRow) => lane === 'all' || laneOf(row.kind) === lane
  const visible = rows.filter(inLane)
  const mounted = kept.filter(inLane)
  const countOf = (key: Lane) =>
    key === 'all'
      ? rows.length
      : rows.filter((r) => laneOf(r.kind) === key).length
  // A narrowed queue says so as a chip on the bar, the axis beside the
  // lanes; its × clears it.
  const chips =
    scope || filter ? (
      <span className="ml-auto flex items-center gap-2">
        {scope ? <ScopeChip name={scope.name} /> : null}
        {filter ? <FilterChip filter={filter} /> : null}
      </span>
    ) : undefined

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Review"
        action={<ScanAction />}
        tabs={
          rows.length > 0 || chips !== undefined ? (
            <Tabs
              label="Lanes"
              value={lane}
              onValueChange={setLane}
              items={LANES.map((l) => ({
                id: l.key,
                label: l.label,
                count: countOf(l.key),
              }))}
              {...(chips === undefined ? {} : { trail: chips })}
            />
          ) : undefined
        }
      />

      {/* Why a record head is missing a plugin's action. */}
      {stoppedPlugins.length > 0 ? (
        <div className="max-w-220 px-8 pt-6">
          <PluginStatusSection stopped={stoppedPlugins} />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing to review"
          body="Nothing waits on you. Duplicate pairs appear here when two records claim the same domain or their names look alike; suggestions appear when a provider proposes a value."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing in this lane"
          body="The other lane still has open items — switch to All to see them."
        />
      ) : null}
      {mounted.length === 0 ? null : (
        <ul className="flex max-w-220 flex-col gap-6 px-8 pt-6 pb-8 empty:hidden">
          {mounted.map((row) => {
            const same = mounted.filter((r) => r.kind === row.kind)
            return (
              <InboxItem
                key={`${row.kind}:${row.id}`}
                row={row}
                index={same.indexOf(row)}
                total={same.length}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * "on <record>" — the queue is narrowed to one record. The chip is
 * the record-reference chip, and its × clears the param back to the whole
 * queue; the tab the reader chose stays chosen.
 */
function ScopeChip({ name }: { name: string }) {
  return (
    <span className="mention-chip cursor-default">
      On {name}
      <Link
        to="/review"
        search={{}}
        aria-label={`Show the whole queue, not just ${name}`}
        className="focus-ring -mr-0.5 text-graphite hover:text-foreground"
      >
        <X className="size-3" strokeWidth={2} />
      </Link>
    </span>
  )
}

/**
 * `via Exa · in Fintech / Payments` — the queue is narrowed to a Today Review
 * row's source and space. Its × clears both back to the whole queue.
 */
function FilterChip({ filter }: { filter: InboxFilterLabels }) {
  const words = [
    filter.source === null ? null : `Via ${filter.source}`,
    filter.space === null ? null : `In ${filter.space}`,
  ]
    .filter((w) => w !== null)
    .join(' · ')
  const name = words === '' ? 'Filtered' : words
  return (
    <span className="mention-chip cursor-default">
      {name}
      <Link
        to="/review"
        search={{}}
        aria-label={`Show the whole queue, not just ${name}`}
        className="focus-ring -mr-0.5 text-graphite hover:text-foreground"
      >
        <X className="size-3" strokeWidth={2} />
      </Link>
    </span>
  )
}

/**
 * The nightly sweep's human door. It queues the job, it does not
 * run it — the rows appear when the worker gets to it, which is why the
 * toast says "queued" and the list is not invalidated here. Admin-only on
 * the server; a teammate who presses it is told so by `requireAdmin`.
 */
function ScanAction() {
  const [pending, setPending] = useState(false)

  async function scan() {
    setPending(true)
    try {
      await runDedupeSweep()
      toast('Scan queued')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not queue the scan',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="outline" pending={pending} onClick={() => void scan()}>
      Scan for duplicates
    </Button>
  )
}

/** The map is the whole dispatch: one lookup, one fallback, no switch. */
export function InboxItem({ row, index, total }: RowProps): React.ReactNode {
  return rendererFor(row.kind)({ row, index, total })
}

/** A row of the pair card: its label, and how each side reads there. */
type PairField = {
  label: string
  value: (side: InboxSide) => React.ReactNode
  /** Whether a side holds anything here; a row empty on both sides hides. */
  has: (side: InboxSide) => boolean
  mono?: boolean
}

const pairFields = (today: string): ReadonlyArray<PairField> => [
  { label: 'Name', value: (side) => sideName(side), has: () => true },
  {
    label: 'Domain',
    mono: true,
    value: (side) => sideDomain(side),
    has: (side) => sideDomain(side) !== null,
  },
  {
    label: 'Also seen as',
    value: (side) => side.otherNames.join(' · '),
    has: (side) => side.otherNames.length > 0,
  },
  {
    label: 'Spaces',
    value: (side) => side.spaces.join(' · '),
    has: (side) => side.spaces.length > 0,
  },
  {
    label: 'Mentions',
    mono: true,
    value: (side) => side.mentionCount,
    has: (side) => side.mentionCount > 0,
  },
  {
    label: 'Added',
    mono: true,
    value: (side) => `${formatDay(side.createdAt, today)} · ${side.label}`,
    has: () => true,
  },
]

/** A side's head cell: `☑ Keep · A` or `☐ Merge in · B`. */
function SideHead({
  letter,
  keep,
  onKeep,
}: {
  letter: 'A' | 'B'
  keep: boolean
  onKeep: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={keep}
      onClick={onKeep}
      className={cn(
        'focus-ring-inset flex min-w-0 flex-1 items-center gap-2 px-4 text-left transition-colors duration-150 ease-out-quart',
        keep ? 'bg-selected' : 'hover:bg-bone',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center border border-hairline',
          keep ? 'bg-primary text-paper' : 'bg-paper',
        )}
      >
        {keep ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
      </span>
      <span className="text-label text-foreground">
        {keep ? 'Keep' : 'Merge in'} · {letter}
      </span>
    </button>
  )
}

/**
 * Two records that may be one: `A ⇄ B` and why, a field grid with the
 * keeper ticked (the swap between the heads exchanges it), and a bone foot
 * whose note says what cannot be undone.
 */
function PairCard({ pair }: { pair: DuplicateCandidateRow }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  // The richer record is A: the left column, pre-ticked, because a merge has
  // no unmerge. A tie leaves the pair as it came. (defaultKeeper)
  const [left, right] =
    defaultKeeper(pair.a, pair.b) === 'a' ? [pair.a, pair.b] : [pair.b, pair.a]
  // Which side stays: A by default; the swap exchanges it.
  const [keep, setKeep] = useState<'a' | 'b'>('a')
  const winner = keep === 'a' ? left : right
  const loser = keep === 'a' ? right : left
  const [kept, merged] = keep === 'a' ? ['A', 'B'] : ['B', 'A']

  async function act(fn: () => Promise<unknown>, message: string) {
    setPending(true)
    try {
      await fn()
      toast(message)
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  const { today } = useClock()
  const fields = pairFields(today).filter((f) => f.has(left) || f.has(right))

  return (
    <li
      data-pair-card
      className="flex flex-col border border-hairline bg-paper"
    >
      <div className="flex min-h-11 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline px-5 py-2.5">
        <h2 className="min-w-0 truncate font-serif text-lg leading-5.5 font-semibold">
          {left.name} ⇄ {right.name}
        </h2>
        <span data-pair-meta className="mono text-micro text-graphite">
          {reasonLabel(pair)} · {formatDay(pair.latestAt, today)}
        </span>
      </div>
      <div className="flex flex-col overflow-x-auto">
        <div className="flex h-10 border-b border-hairline">
          <div className="flex w-35 shrink-0 items-center px-5 text-label text-graphite">
            Field
          </div>
          <SideHead
            letter="A"
            keep={keep === 'a'}
            onKeep={() => setKeep('a')}
          />
          <button
            type="button"
            aria-label="Swap which record stays"
            title="Swap which record stays"
            onClick={() => setKeep((k) => (k === 'a' ? 'b' : 'a'))}
            className="focus-ring-inset flex w-10 shrink-0 items-center justify-center border-x border-rule text-graphite transition-colors duration-150 ease-out-quart hover:bg-bone hover:text-foreground"
          >
            <ArrowLeftRight className="size-3.5" strokeWidth={1.75} />
          </button>
          <SideHead
            letter="B"
            keep={keep === 'b'}
            onKeep={() => setKeep('b')}
          />
        </div>
        {fields.map((row) => (
          <div
            key={row.label}
            data-pair-field
            className="flex min-h-9 border-b border-rule"
          >
            <div className="flex w-35 shrink-0 items-center px-5 text-label text-graphite">
              {row.label}
            </div>
            {[left, right].map((side, si) => (
              <div
                key={side.id}
                className={cn(
                  'flex min-w-0 flex-1 items-center px-4 py-2',
                  si === 1 && 'border-l border-rule pl-14',
                  row.mono ? 'mono text-label' : 'text-ui',
                  side.id === winner.id ? 'text-foreground' : 'text-graphite',
                  row.label === 'Name' && 'font-medium',
                )}
              >
                <span className="min-w-0 truncate">
                  {row.has(side) ? row.value(side) : '—'}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-bone px-5 py-2.5">
        <span data-pair-note className="mono text-micro text-graphite">
          No unmerge · a snapshot of {merged} is kept
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          disabled={pending}
          // Held: the pair leaves, the toast holds Undo. A merge is not held;
          // its note above is the confirmation.
          onClick={() =>
            heldDecisions.hold(pair.id, {
              decision: { verb: 'dismiss-duplicate', candidateId: pair.id },
              label: `${left.name} ⇄ ${right.name} dismissed`,
              commit: () =>
                dismissDuplicate({ data: { candidateId: pair.id } }),
            })
          }
        >
          Dismiss
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            act(
              () =>
                mergeDuplicate({
                  data: { candidateId: pair.id, winnerId: winner.id },
                }),
              `Merged ${loser.name} into ${winner.name}`,
            )
          }
        >
          Merge {merged} into {kept}
        </Button>
      </div>
    </li>
  )
}

/**
 * Aliases first, then the record's own field.
 * - The side that caused an identity pair *lost* the claim, so it holds no
 *   domain alias; `identityDomain` is its `domain` identity value, normalized
 *   like the alias lane, so both columns print the colliding domain.
 * - Core pairs only take the first branch: a company's domain *is* an alias.
 */
function sideDomain(side: InboxSide): string | null {
  if (side.domains.length > 0) return side.domains.join(' · ')
  return side.identityDomain
}

/**
 * One route table for the whole app (`recordPath`), so a custom record links
 * into `/o/<slug>/<id>` and a kind with no page is plain text rather than a
 * broken link.
 */
function sideName(side: InboxSide): React.ReactNode {
  const href = recordPath(side)
  return href ? (
    <Link to={href} className="focus-ring hover:underline">
      {side.name}
    </Link>
  ) : (
    side.name
  )
}
