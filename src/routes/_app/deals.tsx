import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Kanban, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ValueEditor, optionLabel } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
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
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  createDeal,
  listDealsTable,
  listRegistry,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/deals')({
  loader: async () => {
    const [deals, registry] = await Promise.all([
      listDealsTable(),
      listRegistry({ data: { kind: 'deal' } }),
    ])
    return { deals, registry }
  },
  component: DealsPage,
})

const GROUP_LABELS: Record<string, string> = {
  active: 'Active',
  parked: 'Parked',
  closed: 'Closed',
}

function DealsPage() {
  const { deals, registry } = Route.useLoaderData()
  const router = useRouter()
  const [query, setQuery] = useState('')
  // Stage filter: group chips (Active/Parked/Closed) + per-stage narrowing.
  const [groupFilter, setGroupFilter] = useState<string | null>('active')
  const [stageFilter, setStageFilter] = useState<string | null>(null)

  const stageDef = registry.find((d) => d.slug === 'stage') as
    | RegistryEntry
    | undefined
  const stageOptions = stageDef?.options?.options ?? []

  const refNames = useMemo(
    () => ({
      ...deals.refNames,
      ...Object.fromEntries(
        Object.entries(deals.userNames).map(([id, name]) => [id, { name }]),
      ),
    }),
    [deals],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return deals.rows.filter((d) => {
      const stage = String(d.values.stage ?? '')
      const opt = stageOptions.find((o) => o.id === stage)
      if (stageFilter && stage !== stageFilter) return false
      if (!stageFilter && groupFilter && (opt?.group ?? 'active') !== groupFilter)
        return false
      if (!q) return true
      const companyId = d.values.company as string | undefined
      const companyName = companyId
        ? (deals.refNames[companyId]?.name ?? '')
        : ''
      return (
        d.name.toLowerCase().includes(q) ||
        companyName.toLowerCase().includes(q)
      )
    })
  }, [deals, query, groupFilter, stageFilter, stageOptions])

  // Counts per group for the filter chips.
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0, parked: 0, closed: 0 }
    for (const d of deals.rows) {
      const opt = stageOptions.find((o) => o.id === String(d.values.stage ?? ''))
      counts[opt?.group ?? 'active'] += 1
    }
    return counts
  }, [deals, stageOptions])

  useEffect(() => {
    // Narrowed stage must belong to the selected group.
    if (!stageFilter) return
    const opt = stageOptions.find((o) => o.id === stageFilter)
    if (groupFilter && opt && (opt.group ?? 'active') !== groupFilter)
      setStageFilter(null)
  }, [groupFilter, stageFilter, stageOptions])

  async function saveCell(id: string, slug: string, value: unknown) {
    try {
      await updateRecord({ data: { id, patch: { [slug]: value } } })
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      router.invalidate()
    }
  }

  return (
    <div className="flex h-full flex-col px-6 py-6 md:px-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Deals</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            One record per opportunity — born at Pre-lead, closed as Invested,
            Passed, or Lost. History is the point.
          </p>
        </div>
        <CreateDealDialog registry={registry as Array<RegistryEntry>} />
      </header>

      {deals.rows.length === 0 ? (
        <EmptyState
          icon={Kanban}
          title="No deals yet"
          body="A deal starts when something arrives — a deck, an intro, a founder email. Create one against a company and triage it from Pre-lead."
          action={<CreateDealDialog registry={registry as Array<RegistryEntry>} />}
        />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by deal or company…"
              aria-label="Filter deals"
              className="h-8 max-w-56 text-[13px]"
            />
            <div className="flex items-center gap-1" role="group" aria-label="Stage group">
              {(['active', 'parked', 'closed'] as const).map((g) => (
                <button
                  key={g}
                  aria-pressed={groupFilter === g}
                  onClick={() => setGroupFilter(groupFilter === g ? null : g)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                    groupFilter === g
                      ? 'border-primary/40 bg-selected text-foreground'
                      : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                  )}
                >
                  {GROUP_LABELS[g]}
                  <span className="tabular text-muted-foreground">
                    {groupCounts[g]}
                  </span>
                </button>
              ))}
            </div>
            {groupFilter ? (
              <div className="flex items-center gap-1">
                {stageOptions
                  .filter((o) => (o.group ?? 'active') === groupFilter)
                  .map((o) => (
                    <button
                      key={o.id}
                      aria-pressed={stageFilter === o.id}
                      onClick={() =>
                        setStageFilter(stageFilter === o.id ? null : o.id)
                      }
                      className={cn(
                        'h-7 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        stageFilter === o.id
                          ? 'border-primary/40 bg-selected font-medium text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
              </div>
            ) : null}
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {filtered.length} of {deals.rows.length}
            </span>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  <th className="h-9 w-64 border-r border-border/60 px-2 text-left font-medium text-muted-foreground">
                    Deal
                  </th>
                  {registry.map((def) => (
                    <th
                      key={def.slug}
                      className="h-9 min-w-32 border-r border-border/60 px-2 text-left font-medium text-muted-foreground"
                    >
                      {def.name}
                    </th>
                  ))}
                  <th className="w-10 px-1">
                    <AttributeCreateDialog
                      objectKind="deal"
                      onCreated={() => router.invalidate()}
                      trigger={
                        <button
                          aria-label="Add column"
                          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <Plus className="size-3.5" strokeWidth={2} />
                        </button>
                      }
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr
                    key={d.id}
                    className="h-9 border-b border-border/60 last:border-b-0 hover:bg-accent/50"
                  >
                    <td className="border-r border-border/40 px-1">
                      <Link
                        to="/deals/$dealId"
                        params={{ dealId: d.id }}
                        className="block truncate px-1 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
                      >
                        {d.name}
                      </Link>
                    </td>
                    {registry.map((def) => (
                      <td
                        key={def.slug}
                        className="border-r border-border/40 px-1"
                      >
                        <ValueEditor
                          def={def as RegistryEntry}
                          value={d.values[def.slug] ?? null}
                          variant="cell"
                          refNames={refNames}
                          onSave={(v) => saveCell(d.id, def.slug, v)}
                        />
                      </td>
                    ))}
                    <td className="w-10" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export function CreateDealDialog({
  registry,
  presetCompany,
  triggerLabel = 'New deal',
}: {
  registry: Array<RegistryEntry>
  presetCompany?: { id: string; name: string }
  triggerLabel?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [companyId, setCompanyId] = useState<string | null>(
    presetCompany?.id ?? null,
  )
  const [companyName, setCompanyName] = useState(presetCompany?.name ?? '')
  const [stage, setStage] = useState<string>('pre_lead')

  const companyDef = registry.find((d) => d.slug === 'company')
  const stageDef = registry.find((d) => d.slug === 'stage')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!companyId) return setError('Pick the company — a deal needs one.')
    const dealName = name.trim() || `${companyName || 'New'} deal`
    setPending(true)
    try {
      await createDeal({ data: { companyId, name: dealName, stage } })
      setOpen(false)
      setName('')
      if (!presetCompany) {
        setCompanyId(null)
        setCompanyName('')
      }
      toast(`${dealName} created`)
      router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the deal')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" strokeWidth={2} />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>
            One opportunity in one company. It starts at Pre-lead.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {companyDef && !presetCompany ? (
            <div className="space-y-1.5">
              <Label>Company</Label>
              <ValueEditor
                def={companyDef}
                value={companyId}
                variant="field"
                refNames={companyId ? { [companyId]: { name: companyName } } : {}}
                onSave={(v) => setCompanyId(v as string | null)}
              />
              <CompanyNameCapture
                companyId={companyId}
                onName={(n) => {
                  setCompanyName(n)
                  setName((cur) => (cur.trim() ? cur : `${n} deal`))
                }}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="deal-name">Name</Label>
            <Input
              id="deal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                companyName ? `${companyName} deal` : 'Pixxel — Series B'
              }
            />
          </div>
          {stageDef ? (
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <ValueEditor
                def={stageDef}
                value={stage}
                variant="field"
                onSave={(v) => setStage(String(v ?? 'pre_lead'))}
              />
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create deal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Resolves a picked company id to its name for auto-naming the deal. */
function CompanyNameCapture({
  companyId,
  onName,
}: {
  companyId: string | null
  onName: (name: string) => void
}) {
  useEffect(() => {
    if (!companyId) return
    let alive = true
    import('#/lib/server-fns').then(async ({ getCompany }) => {
      try {
        const c = await getCompany({ data: { id: companyId } })
        if (alive) onName(c.name)
      } catch {
        /* name stays blank; user types one */
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])
  return null
}

// optionLabel imported for potential external use with deal stages
export { optionLabel }
