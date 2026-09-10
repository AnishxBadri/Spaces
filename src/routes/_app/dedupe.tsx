import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Check, Copy, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
import { Button } from '#/components/ui/button'
import {
  dismissDuplicate,
  listDuplicates,
  mergeDuplicate,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/dedupe')({
  loader: () => listDuplicates(),
  component: DedupePage,
})

type Pair = Awaited<ReturnType<typeof listDuplicates>>[number]
type Side = Pair['a']

function reasonLabel(pair: Pair): string {
  if (pair.reason.shared) {
    return `Both claim the same ${pair.reason.shared}: ${pair.reason.value}`
  }
  if (pair.reason.name_similarity) {
    return `Names are ${Math.round(pair.score * 100)}% similar`
  }
  return 'Flagged as possibly the same'
}

function DedupePage() {
  const pairs = Route.useLoaderData()

  return (
    <div className="mx-auto w-full max-w-column px-6 py-8 md:px-10">
      <header>
        <h1 className="title-serif">Possible duplicates</h1>
        <p className="mt-1.5 mono text-label text-graphite">
          {pairs.length} open · you make the call · dismissed pairs never come
          back
        </p>
      </header>

      {pairs.length === 0 ? (
        <EmptyState
          icon={Copy}
          title="Inbox zero"
          body="No open duplicate suggestions. New ones appear here when two records claim the same domain or their names look alike."
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-6">
          {pairs.map((pair, i) => (
            <PairCard
              key={pair.id}
              pair={pair}
              index={i}
              total={pairs.length}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function PairCard({
  pair,
  index,
  total,
}: {
  pair: Pair
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
    render: (side: Side) => React.ReactNode
    mono?: boolean
  }> = [
    { label: 'Name', render: (side) => sideName(side) },
    {
      label: 'Domain',
      mono: true,
      render: (side) =>
        side.domains.length > 0 ? side.domains.join(' · ') : '—',
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
        `${side.mentionCount} mention${side.mentionCount === 1 ? '' : 's'} · added ${side.createdAt.slice(0, 10)} · ${side.source}`,
    },
  ]

  return (
    <li className="flex flex-col border border-hairline bg-paper shadow-[3px_3px_0_0_var(--hairline)]">
      <div className="flex min-h-11 items-baseline gap-3 border-b border-hairline px-5 py-2.5">
        <h2 className="font-serif text-lg leading-[1.375rem] font-semibold">
          Same {pair.a.kind === 'person' ? 'person' : 'company'}?
        </h2>
        <span className="mono text-micro text-graphite">
          pair {index + 1} of {total} · {reasonLabel(pair).toLowerCase()}
        </span>
      </div>
      <div className="flex flex-col overflow-x-auto">
        <div className="flex h-10 border-b border-hairline">
          <div className="flex w-35 shrink-0 items-center px-5 label-caps text-[0.625rem] leading-3 font-normal text-graphite">
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
                <span className="label-caps text-[0.625rem] leading-3 font-normal text-foreground">
                  {on ? 'Keep' : 'Merge in'} · {k.toUpperCase()}
                </span>
              </button>
            )
          })}
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex min-h-9 border-b border-rule">
            <div className="flex w-35 shrink-0 items-center px-5 label-caps text-[0.625rem] leading-3 font-normal text-graphite">
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

function sideName(side: Side): React.ReactNode {
  return side.kind === 'company' ? (
    <Link
      to="/companies/$companyId"
      params={{ companyId: side.id }}
      className="focus-ring hover:underline"
    >
      {side.name}
    </Link>
  ) : (
    side.name
  )
}
