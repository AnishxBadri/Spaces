import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  Compass,
  FileText,
  Kanban,
  MessageSquare,
  Plus,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { RailField } from '#/components/attributes/rail-field'
import { OptionChip } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { CloseReasonDialog } from '#/components/deal-board'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { optionColor } from '#/lib/attributes/colors'
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
  // Same post-mortem gate the board's drag path has — Passed/Lost pause here.
  const [closing, setClosing] = useState<{
    stageId: string
    stageLabel: string
  } | null>(null)

  const refNames = {
    ...deal.refNames,
    ...Object.fromEntries(
      Object.entries(deal.userNames).map(([id, name]) => [id, { name }]),
    ),
  }
  const companyId = deal.values.company as string | undefined
  // refNames' Record index type hides misses — annotate the lookup honestly.
  const companyRef: { name: string } | undefined = companyId
    ? deal.refNames[companyId]
    : undefined
  const noteMentions = deal.mentionedIn.filter((m) => m.kind === 'note')

  const stageDef = registry.find((d) => d.slug === 'stage') as
    RegistryEntry | undefined
  const stageOptions = stageDef?.options?.options ?? []
  const stageOption = stageOptions.find((o) => o.id === deal.values.stage)
  // Move-stage never offers a retired stage; the header chip still shows one.
  const liveStages = stageOptions.filter((o) => !o.archived)

  async function save(patch: Record<string, unknown>) {
    try {
      await updateRecord({ data: { id: deal.id, patch } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      void router.invalidate()
    }
  }

  async function newNoteAboutThis() {
    try {
      const { id } = await createNote({
        data: { about: { entityId: deal.id, label: deal.name, kind: 'deal' } },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  return (
    <div className="px-6 py-8 md:px-10">
      {closing ? (
        <CloseReasonDialog
          dealName={deal.name}
          stageLabel={closing.stageLabel}
          onCancel={() => setClosing(null)}
          onSave={(reason) => {
            void save({
              stage: closing.stageId,
              ...(reason ? { close_reason: reason } : {}),
            })
            setClosing(null)
          }}
        />
      ) : null}
      <Link
        to="/deals"
        className="flex w-fit items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Deals
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted">
          <Kanban
            className="size-4.5 text-muted-foreground"
            strokeWidth={1.75}
          />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-page font-semibold tracking-tight">
            {deal.name}
          </h1>
          <span className="flex items-center gap-2">
            {companyId ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId }}
                className="flex w-fit items-center gap-1 text-ui text-muted-foreground hover:text-foreground"
              >
                <Building2 className="size-3" strokeWidth={1.75} />
                {companyRef?.name ?? 'Company'}
              </Link>
            ) : null}
            {stageOption && stageDef ? (
              <OptionChip
                def={stageDef}
                id={stageOption.id}
                className="text-xs"
              />
            ) : null}
            {deal.outsideMandate ? (
              // A hint, never a block — edge cases are the job. Deliberately
              // quiet: same-hue tint, no red.
              <Link
                to="/mandate"
                className="flex items-center gap-1 rounded-full bg-[var(--badge-amber)] px-2 py-0.5 text-xs font-medium text-[var(--badge-amber-ink)] hover:opacity-80"
                title="This company's stage is outside the mandate's stages. Click to review the mandate."
              >
                <Compass className="size-3" strokeWidth={2} />
                Outside mandate
              </Link>
            ) : null}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LogInteractionDialog
            seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
            trigger={
              <Button size="sm" variant="outline">
                <MessageSquare className="size-3.5" strokeWidth={1.75} />
                Log interaction
              </Button>
            }
          />
          {liveStages.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  Move stage
                  <ChevronDown className="size-3.5" strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {liveStages.map((o) => (
                  <DropdownMenuItem
                    key={o.id}
                    disabled={o.id === deal.values.stage}
                    onSelect={() => {
                      if (o.id === 'passed' || o.id === 'lost') {
                        setClosing({ stageId: o.id, stageLabel: o.label })
                        return
                      }
                      void save({ stage: o.id })
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{
                        backgroundColor: `var(--badge-${optionColor(o, stageOptions.indexOf(o))}-ink)`,
                      }}
                    />
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* Left: registry rail */}
        <aside className="space-y-4">
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def as RegistryEntry}
              attr={def}
              objectLabel={'deal'}
              onAttributeSaved={() => router.invalidate()}
              value={deal.values[def.slug] ?? null}
              refNames={refNames}
              onSave={async (v) => {
                await updateRecord({
                  data: { id: deal.id, patch: { [def.slug]: v } },
                })
                void router.invalidate()
              }}
            />
          ))}
          <AttributeCreateDialog
            objectKind="deal"
            onCreated={() => router.invalidate()}
            trigger={
              <button className="flex items-center gap-1 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground">
                <Plus className="size-3" strokeWidth={2} />
                Add attribute
              </button>
            }
          />
          <TasksRail
            entityId={deal.id}
            entityName={deal.name}
            entityKind="deal"
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
                    'relative rounded-t-md px-3 pb-2.5 text-ui font-medium text-muted-foreground capitalize focus-ring transition-colors hover:text-foreground',
                    tab === t &&
                      'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="outline" onClick={newNoteAboutThis}>
                <Plus className="size-3" strokeWidth={2} />
                Note about this
              </Button>
            </div>
          </div>

          {tab === 'activity' ? (
            <>
              <LogInteractionDialog
                seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
                trigger={
                  <button className="mt-4 flex h-9 w-full items-center gap-2 rounded-md border border-input px-3 text-left text-ui text-muted-foreground focus-ring transition-colors duration-150 ease-out-quart hover:border-border hover:bg-accent">
                    <MessageSquare
                      className="size-3.5 shrink-0"
                      strokeWidth={1.75}
                    />
                    Log a call, meeting, or note…
                  </button>
                }
              />
              <RecordTimeline
                items={timeline}
                registry={registry as Array<RegistryEntry>}
                refNames={refNames}
              />
            </>
          ) : tab === 'files' ? (
            <RecordFiles entityId={deal.id} documents={documents} />
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-ui text-muted-foreground">
                  No notes mention this deal yet — diligence notes land here.
                </p>
              ) : (
                noteMentions.map((m) => (
                  <li key={m.fromId}>
                    <Link
                      to="/notes/$noteId"
                      params={{ noteId: m.fromId }}
                      className="flex h-9 items-center gap-2.5 rounded-md px-2 text-ui focus-ring hover:bg-accent"
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
