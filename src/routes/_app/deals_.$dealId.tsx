import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, Building2, FileText, Kanban, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { Button } from '#/components/ui/button'
import {
  createNote,
  getDeal,
  getRecordTimeline,
  listRecordDocuments,
  listRegistry,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/deals_/$dealId')({
  loader: async ({ params }) => {
    const [deal, registry, timeline, documents] = await Promise.all([
      getDeal({ data: { id: params.dealId } }),
      listRegistry({ data: { kind: 'deal' } }),
      getRecordTimeline({ data: { entityId: params.dealId } }),
      listRecordDocuments({ data: { entityId: params.dealId } }),
    ])
    if (deal.mergedIntoId) {
      throw redirect({
        to: '/deals/$dealId',
        params: { dealId: deal.mergedIntoId },
      })
    }
    return { deal, registry, timeline, documents }
  },
  component: DealRecordPage,
})

function DealRecordPage() {
  const { deal, registry, timeline, documents } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'activity' | 'notes' | 'files'>('activity')

  const refNames = {
    ...deal.refNames,
    ...Object.fromEntries(
      Object.entries(deal.userNames).map(([id, name]) => [id, { name }]),
    ),
  }
  const companyId = deal.values.company as string | undefined
  const noteMentions = deal.mentionedIn.filter((m) => m.kind === 'note')

  async function save(patch: Record<string, unknown>) {
    try {
      await updateRecord({ data: { id: deal.id, patch } })
      router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      router.invalidate()
    }
  }

  async function newNoteAboutThis() {
    const { id } = await createNote({
      data: { about: { entityId: deal.id, label: deal.name, kind: 'deal' } },
    })
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 md:px-10">
      <Link
        to="/deals"
        className="flex w-fit items-center gap-1.5 rounded-md text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Deals
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted">
          <Kanban className="size-4.5 text-muted-foreground" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-tight">
            {deal.name}
          </h1>
          {companyId ? (
            <Link
              to="/companies/$companyId"
              params={{ companyId }}
              className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Building2 className="size-3" strokeWidth={1.75} />
              {deal.refNames[companyId]?.name ?? 'Company'}
            </Link>
          ) : null}
        </div>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* Left: registry rail */}
        <aside className="space-y-4">
          {registry.map((def) => (
            <div key={def.slug} className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {def.name}
              </span>
              <ValueEditor
                def={def as RegistryEntry}
                value={deal.values[def.slug] ?? null}
                variant="field"
                refNames={refNames}
                onSave={(v) => save({ [def.slug]: v })}
              />
            </div>
          ))}
          <AttributeCreateDialog
            objectKind="deal"
            onCreated={() => router.invalidate()}
            trigger={
              <button className="flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                <Plus className="size-3" strokeWidth={2} />
                Add attribute
              </button>
            }
          />
        </aside>

        {/* Center: tabs */}
        <section className="min-w-0">
          <div className="flex items-center justify-between border-b border-border">
            <div role="tablist" className="flex gap-1">
              {(['activity', 'notes', 'files'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'relative px-3 pb-2.5 text-[13px] font-medium capitalize text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-t-md',
                    tab === t &&
                      'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <LogInteractionDialog
                seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
              />
              <Button size="xs" variant="outline" onClick={newNoteAboutThis}>
                <Plus className="size-3" strokeWidth={2} />
                Note about this
              </Button>
            </div>
          </div>

          {tab === 'activity' ? (
            <RecordTimeline
              items={timeline}
              registry={registry as Array<RegistryEntry>}
              refNames={refNames}
            />
          ) : tab === 'files' ? (
            <RecordFiles entityId={deal.id} documents={documents} />
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No notes mention this deal yet — diligence notes land here.
                </p>
              ) : (
                noteMentions.map((m) => (
                  <li key={m.fromId}>
                    <Link
                      to="/notes/$noteId"
                      params={{ noteId: m.fromId }}
                      className="flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <FileText
                        className="size-4 text-muted-foreground"
                        strokeWidth={1.75}
                      />
                      <span className="font-medium">{m.name}</span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
