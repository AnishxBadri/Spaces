import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Check, Inbox, Search, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#/components/empty-state'
import { SuggestionCard } from '#/components/inbox/suggestion-card'
import { ColumnRunGroup } from '#/components/inbox/column-run-group'
import { PageHeader } from '#/components/page-header'
import { PluginStatusSection } from '#/components/plugin-status-section'
import { Button } from '#/components/ui/button'
import {
  dismissDuplicate,
  listInbox,
  listStoppedPlugins,
  mergeDuplicate,
  runDedupeSweep,
} from '#/lib/server-fns'
import type {
  ColumnRunRow,
  DuplicateCandidateRow,
  InboxKind,
  InboxLane,
  InboxSide,
  SuggestionRow,
} from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

/**
 * The review inbox (SPA-76) — the queue precedent of
 * `docs/design-contract.md` §3, and the one surface every later review lane
 * joins (spec-ai-substrate.md §10). `/dedupe` redirects here.
 */
/**
 * `record` scopes both lanes to one entity (SPA-114 — the record rail's
 * "Waiting" chips link here); it is a loader dep, since it changes what the
 * server sends. `lane` only seeds the tab on arrival and is not a dep: the
 * tabs stay React state, as they were. `.catch` rather than a failure, so a
 * hand-typed bad value lands on the whole queue, not an error boundary.
 */
const inboxSearch = z.object({
  record: z.string().uuid().optional().catch(undefined),
  lane: z
    .enum(['all', 'suggestions', 'duplicates'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/_app/inbox')({
  validateSearch: inboxSearch,
  loaderDeps: ({ search }) => ({ record: search.record ?? null }),
  loader: async ({ deps }) => {
    const [inbox, stoppedPlugins] = await Promise.all([
      listInbox({ data: { record: deps.record } }),
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
 * here, never a page** — that is the whole contract of this surface, and
 * the reason `/dedupe` stopped being its own route. A kind with no renderer
 * falls back to `PayloadFallback` rather than taking the list down with it,
 * so a row written by a newer build degrades to its payload instead of a
 * blank screen.
 */
const RENDERERS: Record<InboxKind, InboxRenderer> = {
  duplicate_candidate: ({ row, index, total }) =>
    isDuplicateCandidate(row) ? (
      <PairCard pair={row} index={index} total={total} />
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
}

const BY_KIND = new Map<string, InboxRenderer>(Object.entries(RENDERERS))

/** The dispatch itself, exported so `inbox.test.tsx` can exercise the miss. */
export function rendererFor(kind: string): InboxRenderer {
  return BY_KIND.get(kind) ?? PayloadFallback
}

/** What an unknown kind renders as: the row, legible, and nothing thrown. */
export function PayloadFallback({ row }: { row: QueueRow }): React.ReactNode {
  return (
    <li className="flex flex-col border border-hairline bg-paper shadow-[3px_3px_0_0_var(--hairline)]">
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

function reasonLabel(pair: DuplicateCandidateRow): string {
  if (pair.reason.shared) {
    return `Both claim the same ${pair.reason.shared}: ${pair.reason.value}`
  }
  if (pair.reason.name_similarity) {
    return `Names are ${Math.round(pair.score * 100)}% similar`
  }
  return 'Flagged as possibly the same'
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
  const { rows, scope, stoppedPlugins } = Route.useLoaderData()
  const search = Route.useSearch()
  const [lane, setLane] = useState<Lane>(
    search.lane ? LANE_PARAM[search.lane] : 'all',
  )
  const visible =
    lane === 'all' ? rows : rows.filter((row) => laneOf(row.kind) === lane)
  const countOf = (key: Lane) =>
    key === 'all'
      ? rows.length
      : rows.filter((r) => laneOf(r.kind) === key).length
  const suggestionCount = rows.reduce(
    (n, r) =>
      r.kind === 'suggestion'
        ? n + r.suggestions.length
        : r.kind === 'column_run'
          ? n + r.cards.reduce((m, c) => m + c.suggestions.length, 0)
          : n,
    0,
  )

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Review inbox"
        description={
          <>
            {scope ? <ScopeChip name={scope.name} /> : null}
            <span>{rows.length} open</span>
            {suggestionCount > 0 ? (
              <span>
                {suggestionCount} suggestion{suggestionCount === 1 ? '' : 's'}
              </span>
            ) : null}
            <span>you make the call</span>
            <span>rejected and dismissed never come back</span>
          </>
        }
        action={
          <>
            <ScanAction />
            {rows.length > 0 ? (
              <div
                className="-mb-4 ml-2 flex items-center self-end"
                role="group"
              >
                {LANES.map((l) => (
                  <HeaderTab
                    key={l.key}
                    active={lane === l.key}
                    onClick={() => setLane(l.key)}
                  >
                    {l.label}
                    <span className="font-normal tracking-normal normal-case">
                      {countOf(l.key)}
                    </span>
                  </HeaderTab>
                ))}
              </div>
            ) : null}
          </>
        }
      />

      {/* Why a record head is missing a plugin's action (D63). */}
      {stoppedPlugins.length > 0 ? (
        <div className="max-w-220 px-8 pt-6">
          <PluginStatusSection stopped={stoppedPlugins} />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Inbox zero"
          body="Nothing waits on you. Duplicate pairs appear here when two records claim the same domain or their names look alike; suggestions appear when a provider proposes a value."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing in this lane"
          body="The other lane still has open items — switch to All to see them."
        />
      ) : (
        <ul className="flex max-w-220 flex-col gap-6 px-8 pt-6 pb-8">
          {visible.map((row) => {
            const same = visible.filter((r) => r.kind === row.kind)
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
 * "on <record>" — the queue is narrowed to one record (SPA-114). The chip is
 * the record-reference chip, and its × clears the param back to the whole
 * queue; the tab the reader chose stays chosen.
 */
function ScopeChip({ name }: { name: string }) {
  return (
    <span className="mention-chip cursor-default">
      on {name}
      <Link
        to="/inbox"
        search={{}}
        aria-label={`Show the whole queue, not just ${name}`}
        className="focus-ring -mr-0.5 text-graphite hover:text-foreground"
      >
        <X className="size-3" strokeWidth={2} />
      </Link>
    </span>
  )
}

/** The view-tab treatment of `tasks.tsx`, copied rather than reinvented. */
function HeaderTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-1.5 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-graphite hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The nightly sweep's human door (SPA-81). It queues the job, it does not
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
      <Search className="size-3" strokeWidth={2} />
      Scan for duplicates
    </Button>
  )
}

/** The map is the whole dispatch: one lookup, one fallback, no switch. */
export function InboxItem({ row, index, total }: RowProps): React.ReactNode {
  return rendererFor(row.kind)({ row, index, total })
}

function PairCard({
  pair,
  index,
  total,
}: {
  pair: DuplicateCandidateRow
  index: number
  total: number
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  // Which side stays: A by default; the column head toggles it.
  const [keep, setKeep] = useState<'a' | 'b'>('a')
  const winner = keep === 'a' ? pair.a : pair.b
  const loser = keep === 'a' ? pair.b : pair.a

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

  const rows: Array<{
    label: string
    render: (side: InboxSide) => React.ReactNode
    mono?: boolean
  }> = [
    { label: 'Name', render: (side) => sideName(side) },
    {
      label: 'Domain',
      mono: true,
      render: (side) => sideDomain(side),
    },
    {
      label: 'Also seen as',
      render: (side) =>
        side.otherNames.length > 0 ? side.otherNames.join(' · ') : '—',
    },
    {
      label: 'Spaces',
      render: (side) =>
        side.spaces.length > 0 ? side.spaces.join(' · ') : '—',
    },
    {
      label: 'Attached',
      mono: true,
      render: (side) =>
        `${side.mentionCount} mention${side.mentionCount === 1 ? '' : 's'} · added ${side.createdAt.slice(0, 10)} · ${side.label}`,
    },
  ]

  return (
    <li className="flex flex-col border border-hairline bg-paper shadow-[3px_3px_0_0_var(--hairline)]">
      <div className="flex min-h-11 items-baseline gap-3 border-b border-hairline px-5 py-2.5">
        <h2 className="font-serif text-lg leading-5.5 font-semibold">
          {/* The noun is the object registry's `singular`, verbatim and
              cased as the operator wrote it — an object named "LP" must not
              read "Same lp?". Research kinds have no object row. */}
          Same {pair.a.objectSingular ?? 'record'}?
        </h2>
        <span className="mono text-micro text-graphite">
          pair {index + 1} of {total} · {reasonLabel(pair).toLowerCase()}
        </span>
      </div>
      <div className="flex flex-col overflow-x-auto">
        <div className="flex h-10 border-b border-hairline">
          <div className="flex w-35 shrink-0 items-center px-5 field-label text-graphite">
            field
          </div>
          {(['a', 'b'] as const).map((k) => {
            const on = keep === k
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setKeep(k)}
                className={cn(
                  'focus-ring-inset flex min-w-0 flex-1 items-center gap-2 border-l border-rule px-4 text-left transition-colors',
                  on ? 'bg-selected' : 'hover:bg-bone',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center border border-hairline',
                    on ? 'bg-primary text-paper' : 'bg-paper',
                  )}
                >
                  {on ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
                </span>
                <span className="field-label text-foreground">
                  {on ? 'Keep' : 'Merge in'} · {k.toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex min-h-9 border-b border-rule">
            <div className="flex w-35 shrink-0 items-center px-5 field-label text-graphite">
              {row.label}
            </div>
            {([pair.a, pair.b] as const).map((side, si) => {
              const isWinner = side.id === winner.id
              return (
                <div
                  key={side.id}
                  className={cn(
                    'flex min-w-0 flex-1 items-center border-l border-rule px-4 py-2',
                    row.mono ? 'mono text-label' : 'text-ui',
                    isWinner ? 'text-foreground' : 'text-graphite',
                    si === 0 && row.label === 'Name' && 'font-medium',
                  )}
                >
                  <span className="min-w-0 truncate">{row.render(side)}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex min-h-13 flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-bone px-5 py-2.5">
        <span className="mono text-micro text-graphite">
          a snapshot of {keep === 'a' ? 'B' : 'A'} is kept · there is no unmerge
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            act(
              () => dismissDuplicate({ data: { candidateId: pair.id } }),
              'Dismissed — will not be suggested again',
            )
          }
        >
          <X className="size-3" strokeWidth={2} />
          Not the same
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
          Merge {keep === 'a' ? 'B into A' : 'A into B'}
        </Button>
      </div>
    </li>
  )
}

/**
 * Aliases first, then the record's own field (SPA-97).
 *
 * The side that caused an identity pair is the side that *lost* the claim,
 * so it holds no domain alias and this row used to read "—" for the exact
 * record under discussion. `identityDomain` is that side's value for its
 * object's `domain` identity key, normalized the same way the alias lane is,
 * so both columns print the colliding domain and the pair is comparable.
 *
 * Core pairs are unchanged: a company's domain *is* an alias, the system
 * objects declare no identity-key attribute, so `identityDomain` is null
 * and the first branch is the only one that ever runs.
 */
function sideDomain(side: InboxSide): string {
  if (side.domains.length > 0) return side.domains.join(' · ')
  return side.identityDomain ?? '—'
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
