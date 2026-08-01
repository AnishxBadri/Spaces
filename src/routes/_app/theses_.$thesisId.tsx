import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  Building2,
  FileText,
  Layers,
  Minus,
  Plus,
  Target,
  User,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  getThesis,
  listSpaces,
  removeThesisEvidence,
  searchEntities,
  setThesisEvidence,
  setThesisSpace,
  updateThesis,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * The thesis page. Prose register, because a thesis is something you argue
 * with, not a row you scan.
 *
 * The two evidence columns are the whole point: no generic CRM records
 * disconfirmation, so "against" gets equal width and equal weight, never a
 * collapsed section or a filter on one list.
 */
export const Route = createFileRoute('/_app/theses_/$thesisId')({
  loader: async ({ params }) => {
    const [thesis, spaces] = await Promise.all([
      getThesis({ data: { id: params.thesisId } }),
      listSpaces(),
    ])
    return { thesis, allSpaces: spaces }
  },
  component: ThesisPage,
})

type Loaded = Awaited<ReturnType<typeof getThesis>>
type Evidence = Loaded['evidenceFor'][number]

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const KIND_ICONS: Record<string, typeof Building2> = {
  company: Building2,
  person: User,
  organization: Building2,
  note: FileText,
  document: FileText,
  deal: Target,
  space: Layers,
  thesis: Target,
}

const STATUSES = [
  { value: 'forming', label: 'Forming' },
  { value: 'active', label: 'Active' },
  { value: 'parked', label: 'Parked' },
  { value: 'killed', label: 'Killed' },
] as const

function ThesisPage() {
  const { thesis, allSpaces } = Route.useLoaderData()
  const router = useRouter()
  const [claim, setClaim] = useState(thesis.claim)
  const [killing, setKilling] = useState(false)
  const killed = thesis.status === 'killed'

  async function save(patch: Parameters<typeof updateThesis>[0]['data']) {
    try {
      await updateThesis({ data: patch })
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    }
  }

  const unattached = allSpaces.filter(
    (s) => !thesis.spaces.some((x) => x.id === s.id),
  )

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
      <Link
        to="/theses"
        className="flex w-fit items-center gap-1.5 rounded-md text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Theses
      </Link>

      {/* The claim, editable in place. Serif — this is prose. */}
      <textarea
        value={claim}
        onChange={(e) => setClaim(e.target.value)}
        onBlur={() => {
          const next = claim.trim()
          if (!next || next === thesis.claim) {
            setClaim(thesis.claim)
            return
          }
          save({ id: thesis.id, claim: next })
        }}
        rows={2}
        aria-label="Claim"
        className={cn(
          'mt-5 w-full resize-none bg-transparent font-serif text-[22px] leading-snug tracking-tight outline-none',
          killed && 'text-muted-foreground',
        )}
      />

      {/* Stance */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="conviction">
          Conviction
        </label>
        <select
          id="conviction"
          value={thesis.conviction}
          onChange={(e) =>
            save({
              id: thesis.id,
              conviction: e.target.value as 'low' | 'medium' | 'high',
            })
          }
          className="border-input h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <option value="low">Low conviction</option>
          <option value="medium">Medium conviction</option>
          <option value="high">High conviction</option>
        </select>

        <label className="sr-only" htmlFor="status">
          Status
        </label>
        <select
          id="status"
          value={thesis.status}
          onChange={(e) => {
            const next = e.target.value as (typeof STATUSES)[number]['value']
            // Killing needs a reason — the server refuses without one, so ask
            // here rather than let the change fail.
            if (next === 'killed') {
              setKilling(true)
              return
            }
            save({ id: thesis.id, status: next })
          }}
          className="border-input h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <span className="tabular text-xs text-muted-foreground/80">
          opened {dateFmt.format(new Date(thesis.openedAt))}
          {thesis.ownerName ? ` · ${thesis.ownerName}` : ''}
        </span>
      </div>

      {killing ? (
        <KillDialog
          onCancel={() => setKilling(false)}
          onConfirm={async (reason) => {
            await save({
              id: thesis.id,
              status: 'killed',
              closedReason: reason,
            })
            setKilling(false)
          }}
        />
      ) : null}

      {/* Death is information — the reasoning gets the loudest block on the
          page, not a tombstone in the corner. */}
      {killed ? (
        <div className="mt-5 rounded-lg border border-border bg-muted/40 p-4">
          <h2 className="text-xs font-medium text-muted-foreground">
            Killed{' '}
            {thesis.closedAt ? dateFmt.format(new Date(thesis.closedAt)) : ''}
          </h2>
          <p className="mt-1.5 font-serif text-[15px] leading-relaxed">
            {thesis.closedReason}
          </p>
        </div>
      ) : null}

      {/* Spaces — a claim spans several (defence × autonomy). */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {thesis.spaces.map((s) => (
          <span
            key={s.id}
            className="flex h-6 items-center gap-1 rounded-full border border-border pl-2 pr-1 text-xs font-medium text-muted-foreground"
          >
            <Layers className="size-3 shrink-0" strokeWidth={1.75} />
            <Link
              to="/spaces/$spaceId"
              params={{ spaceId: s.id }}
              className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {s.name}
            </Link>
            <button
              aria-label={`Remove from ${s.name}`}
              onClick={async () => {
                await setThesisSpace({
                  data: {
                    thesisId: thesis.id,
                    spaceId: s.id,
                    attached: false,
                  },
                })
                router.invalidate()
              }}
              className="flex size-4 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-2.5" strokeWidth={2.5} />
            </button>
          </span>
        ))}
        {unattached.length > 0 ? (
          <select
            aria-label="Add a space"
            value=""
            onChange={async (e) => {
              if (!e.target.value) return
              await setThesisSpace({
                data: {
                  thesisId: thesis.id,
                  spaceId: e.target.value,
                  attached: true,
                },
              })
              router.invalidate()
            }}
            className="h-6 rounded-full border border-dashed border-border bg-transparent px-2 text-xs text-muted-foreground outline-none hover:border-input hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="">+ Space…</option>
            {unattached.map((s) => (
              <option key={s.id} value={s.id}>
                {' '.repeat(s.depth * 2)}
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/* Evidence, both sides, equal weight. */}
      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <EvidenceColumn
          thesisId={thesis.id}
          side="evidence_for"
          title="Evidence for"
          icon={Plus}
          items={thesis.evidenceFor}
          empty="Nothing yet. Companies that prove the claim, notes that back it."
        />
        <EvidenceColumn
          thesisId={thesis.id}
          side="evidence_against"
          title="Evidence against"
          icon={Minus}
          items={thesis.evidenceAgainst}
          empty="Nothing yet — and that is usually a warning, not a win. A claim with no disconfirmation has not been tested."
        />
      </div>
    </div>
  )
}

function EvidenceColumn({
  thesisId,
  side,
  title,
  icon: Icon,
  items,
  empty,
}: {
  thesisId: string
  side: 'evidence_for' | 'evidence_against'
  title: string
  icon: typeof Plus
  items: Array<Evidence>
  empty: string
}) {
  const router = useRouter()

  return (
    <section>
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3" strokeWidth={2.5} />
        {title} · {items.length}
      </h2>

      {items.length === 0 ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground/80">
          {empty}
        </p>
      ) : (
        <ul className="mt-2 -mx-1">
          {items.map((e) => {
            const KindIcon = KIND_ICONS[e.kind] ?? Building2
            const to =
              e.kind === 'company'
                ? '/companies/$companyId'
                : e.kind === 'person'
                  ? '/people/$personId'
                  : e.kind === 'note'
                    ? '/notes/$noteId'
                    : e.kind === 'deal'
                      ? '/deals/$dealId'
                      : null
            const body = (
              <>
                <KindIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
              </>
            )
            return (
              <li
                key={e.linkId}
                className="group flex h-8 items-center gap-2 rounded-md px-1 text-[13px] hover:bg-accent"
              >
                {to ? (
                  <Link
                    to={to}
                    params={
                      {
                        companyId: e.id,
                        personId: e.id,
                        noteId: e.id,
                        dealId: e.id,
                      } as never
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {body}
                  </Link>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {body}
                  </span>
                )}
                <button
                  aria-label={`Remove ${e.name}`}
                  onClick={async () => {
                    await removeThesisEvidence({ data: { linkId: e.linkId } })
                    router.invalidate()
                  }}
                  className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover:flex focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <EvidencePicker thesisId={thesisId} side={side} />
    </section>
  )
}

/**
 * Evidence is open to any kind, not just companies — disconfirmation is
 * usually an article or a teardown note, and restricting this to companies
 * would quietly gut the against column.
 */
function EvidencePicker({
  thesisId,
  side,
}: {
  thesisId: string
  side: 'evidence_for' | 'evidence_against'
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<
    Array<{ id: string; name: string; kind: string }>
  >([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (timer.current) clearTimeout(timer.current)
    if (!q.trim()) {
      setResults([])
      return
    }
    timer.current = setTimeout(async () => {
      const rows = await searchEntities({
        data: {
          q,
          kinds: ['company', 'person', 'organization', 'deal', 'note'],
        },
      })
      setResults(rows)
    }, 200)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [q, open])

  async function attach(entityId: string) {
    try {
      await setThesisEvidence({ data: { thesisId, entityId, side } })
      setQ('')
      setResults([])
      setOpen(false)
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not attach')
    }
  }

  if (!open) {
    return (
      <Button
        size="xs"
        variant="outline"
        className="mt-2"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3" strokeWidth={2} />
        Attach evidence
      </Button>
    )
  }

  return (
    <div className="mt-2">
      <Input
        autoFocus
        value={q}
        placeholder="Search companies, people, notes…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            setQ('')
          }
        }}
        className="h-7 text-xs"
      />
      {results.length > 0 ? (
        <ul className="mt-1 rounded-md border border-border">
          {results.map((r) => {
            const KindIcon = KIND_ICONS[r.kind] ?? Building2
            return (
              <li key={r.id}>
                <button
                  onClick={() => attach(r.id)}
                  className="flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <KindIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground/70">
                    {r.kind}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/** Killing needs the reasoning, so the reason field is the dialog. */
function KillDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)

  return (
    <div className="mt-4 rounded-lg border border-border p-4">
      <h2 className="text-[13px] font-medium">Why is this wrong?</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The claim stays on the record. What it taught you is the part worth
        keeping.
      </p>
      <textarea
        autoFocus
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Launch costs fell, but the manufacturing yield problem turned out to be the binding constraint."
        className="border-input mt-2 w-full rounded-md border bg-transparent px-3 py-2 font-serif text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={pending || !reason.trim()}
          onClick={async () => {
            setPending(true)
            await onConfirm(reason.trim())
            setPending(false)
          }}
        >
          {pending ? 'Killing…' : 'Kill thesis'}
        </Button>
      </div>
    </div>
  )
}
