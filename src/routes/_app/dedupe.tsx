import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Building2, Check, Copy, Globe, User, X } from 'lucide-react'
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
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header>
        <h1 className="text-page font-semibold tracking-tight">
          Possible duplicates
        </h1>
        <p className="mt-1 text-ui text-muted-foreground">
          The system never merges on a guess — you make the call. Dismissed
          pairs never come back.
        </p>
      </header>

      {pairs.length === 0 ? (
        <EmptyState
          icon={Copy}
          title="Inbox zero"
          body="No open duplicate suggestions. New ones appear here when two records claim the same domain or their names look alike."
        />
      ) : (
        <ul className="mt-6 space-y-4">
          {pairs.map((pair) => (
            <PairCard key={pair.id} pair={pair} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PairCard({ pair }: { pair: Pair }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function act(fn: () => Promise<unknown>, message: string) {
    setPending(true)
    try {
      await fn()
      toast(message)
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="rounded-lg border border-border">
      <p className="border-b border-border px-4 py-2.5 text-ui font-medium">
        {reasonLabel(pair)}
      </p>
      <div className="grid gap-px bg-border sm:grid-cols-2">
        {([pair.a, pair.b] as const).map((side) => (
          <div key={side.id} className="bg-background p-4">
            <SidePanel side={side} />
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              className="mt-3"
              onClick={() =>
                act(
                  () =>
                    mergeDuplicate({
                      data: { candidateId: pair.id, winnerId: side.id },
                    }),
                  `Merged into ${side.name}`,
                )
              }
            >
              <Check className="size-3" strokeWidth={2} />
              Keep this one
            </Button>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-4 py-2">
        <button
          disabled={pending}
          onClick={() =>
            act(
              () => dismissDuplicate({ data: { candidateId: pair.id } }),
              'Dismissed — will not be suggested again',
            )
          }
          className="flex items-center gap-1.5 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          <X className="size-3" strokeWidth={2} />
          Not duplicates
        </button>
      </div>
    </li>
  )
}

function SidePanel({ side }: { side: Side }) {
  const Icon = side.kind === 'person' ? User : Building2
  return (
    <div className="text-ui">
      <div className="flex items-center gap-2">
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
        {side.kind === 'company' ? (
          <Link
            to="/companies/$companyId"
            params={{ companyId: side.id }}
            className="truncate font-semibold hover:underline"
          >
            {side.name}
          </Link>
        ) : (
          <span className="truncate font-semibold">{side.name}</span>
        )}
      </div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        {side.domains.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <Globe className="size-3" strokeWidth={1.75} />
            <span className="truncate">{side.domains.join(', ')}</span>
          </div>
        ) : null}
        {side.otherNames.length > 0 ? (
          <div className={cn('truncate')}>
            also seen as {side.otherNames.join(', ')}
          </div>
        ) : null}
        {side.spaces.length > 0 ? (
          <div className="truncate">in {side.spaces.join(', ')}</div>
        ) : null}
        <div>
          {side.mentionCount} mention{side.mentionCount === 1 ? '' : 's'} ·
          added{' '}
          {new Date(side.createdAt).toLocaleDateString('en', {
            day: '2-digit',
            month: 'short',
          })}{' '}
          via {side.source}
        </div>
      </dl>
    </div>
  )
}
