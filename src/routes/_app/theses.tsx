import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Layers, Minus, Plus, Target } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import { createThesis, listSpaces, listTheses } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * Claims you hold, not rows. Killed theses stay on this page with their
 * reasoning — a dead thesis you can still read is worth more than a deleted
 * one, and hiding them would make the page lie about the track record.
 */
export const Route = createFileRoute('/_app/theses')({
  loader: async () => {
    const [theses, spaces] = await Promise.all([listTheses(), listSpaces()])
    return { theses, spaces }
  },
  component: ThesesPage,
})

type ThesisRowData = Awaited<ReturnType<typeof listTheses>>[number]

const dateFmt = new Intl.DateTimeFormat('en', {
  month: 'short',
  year: 'numeric',
})

/** Live claims first, nurture second, the graveyard last but never hidden. */
const GROUPS = [
  { key: 'live', label: 'Live', statuses: ['forming', 'active'] },
  { key: 'parked', label: 'Parked', statuses: ['parked'] },
  { key: 'killed', label: 'Killed', statuses: ['killed'] },
] as const

const CONVICTION_STYLES: Record<string, string> = {
  high: 'bg-primary/15 text-foreground',
  medium: 'bg-muted text-muted-foreground',
  low: 'bg-muted/60 text-muted-foreground',
}

function ThesesPage() {
  const { theses, spaces } = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Theses</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            What you believe, how strongly, and what argues against it.
          </p>
        </div>
        {theses.length > 0 ? <CreateThesisDialog spaces={spaces} /> : null}
      </header>

      {theses.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No theses yet"
          body="A thesis is a claim with a date on it — “in-space manufacturing is investible once launch drops below $1000/kg”. Companies attach as evidence for it, or against it."
          action={<CreateThesisDialog spaces={spaces} />}
          hint="Theses die often. A dead one keeps its reasoning."
        />
      ) : (
        <div className="mt-8 space-y-8">
          {GROUPS.map((group) => {
            const rows = theses.filter((t) =>
              (group.statuses as ReadonlyArray<string>).includes(t.status),
            )
            if (rows.length === 0) return null
            return (
              <section key={group.key}>
                <h2 className="text-xs font-medium text-muted-foreground">
                  {group.label} · {rows.length}
                </h2>
                <ul className="mt-2 divide-y divide-border border-y border-border">
                  {rows.map((t) => (
                    <ThesisRow key={t.id} row={t} />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ThesisRow({ row }: { row: ThesisRowData }) {
  const killed = row.status === 'killed'
  return (
    <li>
      <Link
        to="/theses/$thesisId"
        params={{ thesisId: row.id }}
        className="block rounded-md px-1 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <div className="flex items-start gap-3">
          <p
            className={cn(
              'min-w-0 flex-1 font-serif text-[15px] leading-relaxed',
              killed && 'text-muted-foreground',
            )}
          >
            {row.claim}
          </p>
          <span
            className={cn(
              'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
              CONVICTION_STYLES[row.conviction],
            )}
          >
            {row.conviction}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
          <span className="tabular">
            opened {dateFmt.format(new Date(row.openedAt))}
            {row.closedAt
              ? ` · killed ${dateFmt.format(new Date(row.closedAt))}`
              : ''}
          </span>
          {/* The for/against split is the headline number, so it is never
              collapsed into one "evidence" count. */}
          <span className="flex items-center gap-1" title="Evidence for · against">
            <Plus className="size-3" strokeWidth={2.5} />
            <span className="tabular">{row.forCount}</span>
            <Minus className="ml-1.5 size-3" strokeWidth={2.5} />
            <span className="tabular">{row.againstCount}</span>
          </span>
          {row.spaces.map((s) => (
            <span key={s.id} className="flex items-center gap-1">
              <Layers className="size-3" strokeWidth={1.75} />
              {s.name}
            </span>
          ))}
        </div>

        {killed && row.closedReason ? (
          <p className="mt-1.5 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
            {row.closedReason}
          </p>
        ) : null}
      </Link>
    </li>
  )
}

export function CreateThesisDialog({
  spaces,
  presetSpaceId,
  triggerLabel = 'New thesis',
}: {
  spaces: Awaited<ReturnType<typeof listSpaces>>
  presetSpaceId?: string
  triggerLabel?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [claim, setClaim] = useState('')
  const [conviction, setConviction] = useState<'low' | 'medium' | 'high'>('low')
  const [spaceIds, setSpaceIds] = useState<Array<string>>(
    presetSpaceId ? [presetSpaceId] : [],
  )
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!claim.trim()) return
    setPending(true)
    try {
      const { id } = await createThesis({
        data: { claim: claim.trim(), conviction, spaceIds },
      })
      setOpen(false)
      setClaim('')
      navigate({ to: '/theses/$thesisId', params: { thesisId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" strokeWidth={2} />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New thesis</DialogTitle>
          <DialogDescription>
            State it as something that could turn out wrong.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="claim">Claim</Label>
            <textarea
              id="claim"
              autoFocus
              rows={3}
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              placeholder="In-space manufacturing is investible once launch drops below $1000/kg."
              className="border-input w-full rounded-md border bg-transparent px-3 py-2 font-serif text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conviction">Conviction</Label>
            <select
              id="conviction"
              value={conviction}
              onChange={(e) =>
                setConviction(e.target.value as 'low' | 'medium' | 'high')
              }
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="low">Low — worth watching</option>
              <option value="medium">Medium — building the case</option>
              <option value="high">High — ready to write cheques</option>
            </select>
          </div>

          {spaces.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="space">Spaces</Label>
              <select
                id="space"
                value=""
                onChange={(e) => {
                  const picked = e.target.value
                  if (!picked) return
                  setSpaceIds((s) => [...new Set([...s, picked])])
                }}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">+ Add a space… (a claim can span several)</option>
                {spaces
                  .filter((s) => !spaceIds.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {' '.repeat(s.depth * 2)}
                      {s.name}
                    </option>
                  ))}
              </select>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {spaceIds.map((id) => {
                  const s = spaces.find((x) => x.id === id)
                  return s ? (
                    <button
                      key={id}
                      type="button"
                      onClick={() =>
                        setSpaceIds((v) => v.filter((x) => x !== id))
                      }
                      className="flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <Layers className="size-3" strokeWidth={1.75} />
                      {s.name} ×
                    </button>
                  ) : null
                })}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending || !claim.trim()}>
              {pending ? 'Creating…' : 'Create thesis'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
