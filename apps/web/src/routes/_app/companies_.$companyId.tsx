import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Globe, Layers, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { SaveAsTemplateAction } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { RailField } from '#/components/attributes/rail-field'
import { KeyHint } from '#/components/page-header'
import {
  DitherMark,
  InitialsMark,
  PropertyCell,
  PropertyGrid,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  RecordSection,
} from '#/components/record/record-parts'
import { OptionChip, optionLabel } from '#/components/attributes/value-editor'
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

  const noteMentions = company.mentionedIn.filter((m) => m.kind === 'note')
  const domains = company.aliases.filter((a) => a.kind === 'domain')
  const nameAliases = company.aliases.filter(
    (a) => a.kind === 'name' && a.value !== company.name,
  )
  const untaggedSpaces = allSpaces.filter(
    (s) => !company.spaces.some((cs) => cs.id === s.id),
  )

  async function newNoteAboutThis() {
    try {
      const { id } = await createNote({
        data: {
          about: { entityId: company.id, label: company.name, kind: 'company' },
        },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  const fundingDef = registry.find((d) => d.slug === 'funding_stage')
  const fundingStage =
    fundingDef && company.values.funding_stage
      ? optionLabel(fundingDef, company.values.funding_stage)
      : null
  const location =
    typeof company.values.location === 'string' ? company.values.location : null
  const foundedRaw: unknown = company.values.founded_year
  const founded =
    foundedRaw === null || foundedRaw === undefined ? null : String(foundedRaw)

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        crumb={
          <>
            <Link to="/companies" className="focus-ring hover:text-foreground">
              Companies
            </Link>
            {' / '}
            {company.id.slice(0, 8)}
            {domains[0] ? ` / ${domains[0].valueNorm}` : ''}
          </>
        }
        actions={
          <>
            <LogInteractionDialog
              seed={{ id: company.id, name: company.name, kind: 'company' }}
              hotkey="l"
              trigger={
                <Button variant="outline">
                  Log interaction
                  <KeyHint>L</KeyHint>
                </Button>
              }
            />
            <Button variant="outline" onClick={newNoteAboutThis}>
              Note about this
            </Button>
            <SaveAsTemplateAction
              entityLabel="company"
              onSave={async (name) => {
                await saveRecordAsTemplate({
                  data: { recordId: company.id, name },
                })
              }}
            />
          </>
        }
        mark={<DitherMark />}
        name={company.name}
        badges={
          nameAliases.length > 0 ? (
            <span className="min-w-0 truncate mono text-micro text-graphite">
              also {nameAliases.map((a) => a.value).join(' · ')}
            </span>
          ) : null
        }
        readouts={[
          { label: 'Deals', value: `${deals.length}` },
          {
            label: 'Stage',
            value: fundingStage ?? '—',
            kind: 'text',
            tone: fundingStage ? undefined : 'muted',
          },
          {
            label: 'Location',
            value: location ?? '—',
            kind: 'text',
            tone: location ? undefined : 'muted',
          },
          {
            label: 'Founded',
            value: founded ?? '—',
            tone: founded ? undefined : 'muted',
          },
          { label: 'Spaces', value: `${company.spaces.length}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <RailSection
              label="Deals"
              meta={
                <>
                  <span>{deals.length}</span>
                  <CreateDealDialog
                    registry={dealRegistry}
                    presetCompany={{ id: company.id, name: company.name }}
                    triggerLabel="New"
                  />
                </>
              }
            >
              {deals.length === 0 ? (
                <RailEmpty>No deals yet — watching only.</RailEmpty>
              ) : (
                deals.map((d) => (
                  <RailItem key={d.id}>
                    <Link
                      to="/deals/$dealId"
                      params={{ dealId: d.id }}
                      className="focus-ring min-w-0 flex-1 truncate hover:underline"
                    >
                      {d.name}
                    </Link>
                    {d.stage && stageDef ? (
                      <OptionChip
                        def={stageDef}
                        id={d.stage}
                        className="shrink-0"
                      />
                    ) : null}
                  </RailItem>
                ))
              )}
            </RailSection>

            <RailSection label="Spaces" meta={`${company.spaces.length}`}>
              {company.spaces.map((s) => (
                <RailItem key={s.id} className="group">
                  <Layers
                    className="size-3.5 shrink-0 text-graphite"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <button
                    aria-label={`Remove from ${s.name}`}
                    onClick={async () => {
                      await untagFromSpace({
                        data: { entityId: company.id, spaceId: s.id },
                      })
                      void router.invalidate()
                    }}
                    className="focus-ring hidden size-5 items-center justify-center text-graphite group-hover:flex hover:text-foreground focus-visible:flex"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </RailItem>
              ))}
              {untaggedSpaces.length > 0 ? (
                <Select
                  aria-label="Tag into space"
                  value=""
                  onChange={async (spaceId) => {
                    await tagIntoSpace({
                      data: { entityId: company.id, spaceId },
                    })
                    void router.invalidate()
                  }}
                  items={untaggedSpaces.map((s) => ({
                    value: s.id,
                    label: s.name,
                    depth: s.depth,
                  }))}
                  width="content"
                  placeholder="+ Tag into space…"
                  searchPlaceholder="Search spaces…"
                  emptyLabel="No space matches."
                  className="mt-1 h-7 rounded-none bg-paper px-2 text-label text-graphite"
                />
              ) : null}
            </RailSection>

            <RailSection label="People" meta={`${company.people.length}`}>
              {company.people.length === 0 ? (
                <RailEmpty>
                  No contacts yet — link people from their records.
                </RailEmpty>
              ) : (
                company.people.map((p) => (
                  <RailItem key={p.id}>
                    <InitialsMark name={p.name} outline />
                    <Link
                      to="/people/$personId"
                      params={{ personId: p.id }}
                      className="focus-ring min-w-0 flex-1 truncate hover:underline"
                    >
                      {p.name}
                    </Link>
                  </RailItem>
                ))
              )}
            </RailSection>

            <RailSection
              label="Mentioned in"
              meta={`${company.mentionedIn.length}`}
            >
              {company.mentionedIn.length === 0 ? (
                <RailEmpty>Nowhere yet.</RailEmpty>
              ) : (
                company.mentionedIn.map((m) => (
                  <RailItem key={m.fromId}>
                    {m.kind === 'note' ? (
                      <Link
                        to="/notes/$noteId"
                        params={{ noteId: m.fromId }}
                        className="focus-ring min-w-0 truncate hover:underline"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate text-graphite">
                        {m.name}
                      </span>
                    )}
                  </RailItem>
                ))
              )}
            </RailSection>

            <TasksRail
              entityId={company.id}
              entityName={company.name}
              entityKind="company"
            />
          </>
        }
      >
        <PropertyGrid>
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def}
              attr={def}
              objectLabel={'company'}
              onAttributeSaved={() => router.invalidate()}
              value={company.values[def.slug] ?? null}
              onSave={async (v) => {
                await updateRecord({
                  data: { id: company.id, patch: { [def.slug]: v } },
                })
                void router.invalidate()
              }}
            />
          ))}
          <DomainsField companyId={company.id} domains={domains} />
          <PropertyCell label="">
            <AttributeCreateDialog
              objectKind="company"
              onCreated={() => router.invalidate()}
              trigger={
                <button className="focus-ring mono text-micro text-graphite hover:text-foreground">
                  + add attribute
                </button>
              }
            />
          </PropertyCell>
        </PropertyGrid>

        <RecordSection
          label="Notes"
          meta={`${noteMentions.length} note${noteMentions.length === 1 ? '' : 's'}`}
          action={
            <button
              type="button"
              onClick={newNoteAboutThis}
              className="focus-ring text-primary hover:underline"
            >
              note about this ›
            </button>
          }
        >
          {noteMentions.length === 0 ? (
            <p className="border-t border-rule py-2 text-label text-graphite">
              No notes mention {company.name} yet. Write one — it links itself
              here.
            </p>
          ) : (
            <ol>
              {noteMentions.map((m) => (
                <li key={m.fromId} className="border-t border-rule">
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: m.fromId }}
                    className="focus-ring-inset flex h-row items-center gap-3 text-ui hover:bg-bone"
                  >
                    <span className="font-serif text-title font-medium">
                      {m.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </RecordSection>

        <RecordSection
          rule
          label="Ledger"
          meta={`${timeline.length} entr${timeline.length === 1 ? 'y' : 'ies'}`}
        >
          <LogInteractionDialog
            seed={{ id: company.id, name: company.name, kind: 'company' }}
            trigger={
              <button className="focus-ring-inset flex h-row w-full items-center gap-3 border-t border-b border-rule text-left">
                <span className="mono text-micro text-primary">+</span>
                <span className="min-w-0 truncate text-ui text-graphite">
                  Log a call, meeting, or note…
                </span>
                <span className="flex-1" />
                <KeyHint>L</KeyHint>
              </button>
            }
          />
          <RecordTimeline items={timeline} registry={registry} />
        </RecordSection>

        <RecordSection
          rule
          label="Files"
          meta={`${documents.length} file${documents.length === 1 ? '' : 's'}`}
        >
          <RecordFiles entityId={company.id} documents={documents} />
        </RecordSection>
      </RecordBody>
    </div>
  )
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
      void router.invalidate()
    } catch {
      toast.error('Not a valid domain')
    }
  }

  return (
    <PropertyCell label="Domains">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {domains.map((d) => (
          <span key={d.id} className="flex items-center gap-1 mono text-label">
            <Globe className="size-3 text-graphite" strokeWidth={1.75} />
            {d.valueNorm}
          </span>
        ))}
        {adding ? (
          <Input
            autoFocus
            value={draft}
            placeholder="acme.com"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="h-6 w-40 mono text-label"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            + domain
          </button>
        )}
      </div>
    </PropertyCell>
  )
}
