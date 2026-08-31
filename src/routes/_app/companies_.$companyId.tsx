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
  FileText,
  Globe,
  Layers,
  Plus,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { SaveAsTemplateAction } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { ValueEditor, optionLabel } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { CreateDealDialog } from '#/routes/_app/deals'
import {
  addCompanyDomain,
  createNote,
  getCompany,
  getRecordTimeline,
  listCompanyDeals,
  listRecordDocuments,
  listRegistry,
  listSpaces,
  tagIntoSpace,
  untagFromSpace,
  updateRecord,
  saveRecordAsTemplate,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/companies_/$companyId')({
  loader: async ({ params }) => {
    const [
      companyData,
      spaces,
      registry,
      dealRegistry,
      deals,
      timeline,
      documents,
    ] = await Promise.all([
      getCompany({ data: { id: params.companyId } }),
      listSpaces(),
      listRegistry({ data: { kind: 'company' } }),
      listRegistry({ data: { kind: 'deal' } }),
      listCompanyDeals({ data: { companyId: params.companyId } }),
      getRecordTimeline({ data: { entityId: params.companyId } }),
      listRecordDocuments({ data: { entityId: params.companyId } }),
    ])
    // Merged-away records redirect to their survivor — stale URLs keep working.
    if (companyData.mergedIntoId) {
      throw redirect({
        to: '/companies/$companyId',
        params: { companyId: companyData.mergedIntoId },
      })
    }
    return {
      company: companyData,
      allSpaces: spaces,
      registry,
      dealRegistry,
      deals,
      timeline,
      documents,
    }
  },
  component: CompanyRecordPage,
})

function CompanyRecordPage() {
  const {
    company,
    allSpaces,
    registry,
    dealRegistry,
    deals,
    timeline,
    documents,
  } = Route.useLoaderData()
  const stageDef = dealRegistry.find((d) => d.slug === 'stage')
  const router = useRouter()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'activity' | 'notes' | 'files'>('activity')

  const noteMentions = company.mentionedIn.filter((m) => m.kind === 'note')
  const domains = company.aliases.filter((a) => a.kind === 'domain')
  const nameAliases = company.aliases.filter(
    (a) => a.kind === 'name' && a.value !== company.name,
  )
  const untaggedSpaces = allSpaces.filter(
    (s) => !company.spaces.some((cs) => cs.id === s.id),
  )

  async function newNoteAboutThis() {
    const { id } = await createNote({
      data: {
        about: { entityId: company.id, label: company.name, kind: 'company' },
      },
    })
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 md:px-10">
      <Link
        to="/companies"
        className="flex w-fit items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Companies
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted">
          <Building2
            className="size-4.5 text-muted-foreground"
            strokeWidth={1.75}
          />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-page font-semibold tracking-tight">
            {company.name}
          </h1>
          {nameAliases.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              also seen as {nameAliases.map((a) => a.value).join(', ')}
            </p>
          ) : null}
        </div>
        <span className="ml-auto">
          <SaveAsTemplateAction
            entityLabel="company"
            onSave={async (name) => {
              await saveRecordAsTemplate({
                data: { recordId: company.id, name },
              })
            }}
          />
        </span>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        {/* Left: registry-generated attribute rail */}
        <aside className="space-y-4">
          {registry.map((def) => (
            <div key={def.slug} className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {def.name}
              </span>
              <ValueEditor
                def={def as RegistryEntry}
                value={company.values[def.slug] ?? null}
                variant="field"
                onSave={(v) =>
                  save({ id: company.id, patch: { [def.slug]: v } }, router)
                }
              />
            </div>
          ))}

          <DomainsField companyId={company.id} domains={domains} />

          <AttributeCreateDialog
            objectKind="company"
            onCreated={() => router.invalidate()}
            trigger={
              <button className="flex items-center gap-1 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground">
                <Plus className="size-3" strokeWidth={2} />
                Add attribute
              </button>
            }
          />
          <TasksRail
            entityId={company.id}
            entityName={company.name}
            entityKind="company"
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
              <LogInteractionDialog
                seed={{ id: company.id, name: company.name, kind: 'company' }}
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
            />
          ) : tab === 'files' ? (
            <RecordFiles entityId={company.id} documents={documents} />
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-ui text-muted-foreground">
                  No notes mention {company.name} yet. Write one — it links
                  itself here.
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

        {/* Right: related */}
        <aside className="space-y-6">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium text-muted-foreground">
                Deals
              </h2>
              <CreateDealDialog
                registry={dealRegistry as Array<RegistryEntry>}
                presetCompany={{ id: company.id, name: company.name }}
                triggerLabel="New"
              />
            </div>
            {deals.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No deals yet — watching only.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {deals.map((d) => (
                  <li key={d.id}>
                    <Link
                      to="/deals/$dealId"
                      params={{ dealId: d.id }}
                      className="flex h-7 items-center gap-2 rounded-md px-1.5 text-ui focus-ring hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      {d.stage && stageDef ? (
                        <span className="rounded-full bg-selected px-2 py-0.5 text-xs font-medium">
                          {optionLabel(stageDef as RegistryEntry, d.stage)}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Spaces
            </h2>
            <ul className="mt-2 space-y-1">
              {company.spaces.map((s) => (
                <li
                  key={s.id}
                  className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-ui hover:bg-accent"
                >
                  <Layers
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <button
                    aria-label={`Remove from ${s.name}`}
                    onClick={async () => {
                      await untagFromSpace({
                        data: { entityId: company.id, spaceId: s.id },
                      })
                      router.invalidate()
                    }}
                    className="hidden size-5 items-center justify-center rounded text-muted-foreground focus-ring group-hover:flex hover:text-foreground focus-visible:flex"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
            {untaggedSpaces.length > 0 ? (
              <select
                aria-label="Tag into space"
                value=""
                onChange={async (e) => {
                  if (!e.target.value) return
                  await tagIntoSpace({
                    data: { entityId: company.id, spaceId: e.target.value },
                  })
                  router.invalidate()
                }}
                className="mt-2 h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground focus-ring"
              >
                <option value="">+ Tag into space…</option>
                {untaggedSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {' '.repeat(s.depth * 2)}
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              People
            </h2>
            {company.people.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No contacts yet — link people from their records.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {company.people.map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/people/$personId"
                      params={{ personId: p.id }}
                      className="flex h-7 items-center gap-2 rounded-md px-1.5 text-ui focus-ring hover:bg-accent"
                    >
                      <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted text-micro font-semibold text-muted-foreground">
                        {p.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Mentioned in
            </h2>
            {company.mentionedIn.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Nowhere yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {company.mentionedIn.map((m) => (
                  <li key={m.fromId} className="truncate text-ui">
                    {m.kind === 'note' ? (
                      <Link
                        to="/notes/$noteId"
                        params={{ noteId: m.fromId }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{m.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

async function save(
  data: Parameters<typeof updateRecord>[0] extends { data: infer D }
    ? D
    : never,
  router: ReturnType<typeof useRouter>,
) {
  try {
    await updateRecord({ data })
    router.invalidate()
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not save')
  }
}

function DomainsField({
  companyId,
  domains,
}: {
  companyId: string
  domains: Array<{ id: string; valueNorm: string }>
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  async function add() {
    const domain = draft.trim()
    if (!domain) return setAdding(false)
    try {
      const result = await addCompanyDomain({
        data: { id: companyId, domain },
      })
      if (result.outcome === 'suggested_duplicate') {
        toast(`Another company already owns ${domain}`, {
          description:
            'Flagged as a possible duplicate — review it in the dedupe inbox.',
        })
      } else if (result.outcome === 'already_own') {
        toast(`${domain} is already on this company`)
      }
      setDraft('')
      setAdding(false)
      router.invalidate()
    } catch {
      toast.error('Not a valid domain')
    }
  }

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">Domains</span>
      <ul className="space-y-1">
        {domains.map((d) => (
          <li key={d.id} className="flex h-7 items-center gap-2 text-ui">
            <Globe
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.75}
            />
            {d.valueNorm}
          </li>
        ))}
      </ul>
      {adding ? (
        <Input
          autoFocus
          value={draft}
          placeholder="acme.com"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="h-7 text-xs"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          <Plus className="size-3" strokeWidth={2} />
          Add domain
        </button>
      )}
    </div>
  )
}
