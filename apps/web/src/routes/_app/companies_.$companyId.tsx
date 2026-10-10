import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { toast } from 'sonner'
import { SpaceRailRow } from '#/components/record/space-rail-row'
import { SaveAsTemplateAction } from '#/components/templates'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { SummarizeRecordButton } from '#/components/summarize'
import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
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
} from '#/components/record/record-parts'
import { RecordPicture } from '#/components/record/record-picture'
import { OptionChip } from '#/components/attributes/value-editor'
import { fmtPct } from '@spaces/core/portfolio/format'
import { DASH, readoutDay, readoutDayAgo } from '#/lib/records/readout-format'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordContext } from '#/components/record-context'
import { RecordLedger } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { SuggestSpacesAction } from '#/components/record/suggest-spaces'
import { PluginActions } from '#/components/record/plugin-actions'
import { CreateDealDialog } from '#/routes/_app/deals'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { jsonStrings } from '@spaces/core/json'
import { fileInSpaceAction } from '#/lib/file-in-space'
import { runBinding, usePageActions } from '#/lib/page-actions'
import {
  countOpenSuggestions,
  createNote,
  getCompany,
  getRecordEnrichment,
  getEntitySensitivity,
  getRecordTimeline,
  listCompanyDeals,
  listRecordActions,
  listRecordDocuments,
  listRecordNotes,
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
      notes,
      waiting,
      sensitivity,
      pluginActions,
      enrichment,
    ] = await Promise.all([
      getCompany({ data: { id: params.companyId } }),
      listSpaces(),
      listRegistry({ data: { kind: 'company' } }),
      listRegistry({ data: { kind: 'deal' } }),
      listCompanyDeals({ data: { companyId: params.companyId } }),
      getRecordTimeline({ data: { entityId: params.companyId } }),
      listRecordDocuments({ data: { entityId: params.companyId } }),
      listRecordNotes({ data: { entityId: params.companyId } }),
      countOpenSuggestions({ data: { entityId: params.companyId } }),
      getEntitySensitivity({ data: { entityId: params.companyId } }),
      listRecordActions({ data: { kind: 'company' } }),
      getRecordEnrichment({
        data: { entityId: params.companyId, kind: 'company' },
      }),
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
      notes,
      waiting,
      sensitivity,
      pluginActions,
      enrichment,
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
    notes,
    waiting,
    sensitivity,
    pluginActions,
    enrichment,
  } = Route.useLoaderData()
  const stageDef = dealRegistry.find((d) => d.slug === 'stage')
  const router = useRouter()
  const navigate = useNavigate()

  // Identity is an attribute (D75): the first domain names the record.
  const firstDomain = jsonStrings(company.values.domains).at(0)
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

  usePageActions([
    { id: 'log', label: 'Log interaction', key: 'L', run: runBinding('L') },
    {
      id: 'note',
      label: 'Note about this',
      run: () => void newNoteAboutThis(),
    },
    fileInSpaceAction({
      id: company.id,
      name: company.name,
      filedIds: company.spaces.map((s) => s.id),
    }),
  ])

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={{ kind: 'Company', fact: company.id.slice(0, 8) }}
        crumb={
          <>
            <Link to="/companies" className="focus-ring hover:text-foreground">
              Companies
            </Link>
            {' / '}
            {company.id.slice(0, 8)}
            {firstDomain ? ` / ${firstDomain}` : ''}
          </>
        }
        actions={
          <>
            <SensitiveToggle entityId={company.id} state={sensitivity} />
            <SummarizeRecordButton recordId={company.id} />
            <PluginActions
              entityId={company.id}
              actions={pluginActions}
              enrich={enrichment}
            />
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
        mark={
          <RecordPicture
            entityId={company.id}
            picture={company.picture}
            fallback={<DitherMark />}
          />
        }
        name={company.name}
        badges={
          nameAliases.length > 0 ? (
            <span className="min-w-0 truncate mono text-micro text-graphite">
              also {nameAliases.map((a) => a.value).join(' · ')}
            </span>
          ) : null
        }
        readouts={[
          {
            label: 'Last contact',
            value: readoutDayAgo(
              company.readouts.lastContact,
              company.readouts.today,
            ),
          },
          {
            label: 'Next meeting',
            value: readoutDay(
              company.readouts.nextMeeting,
              company.readouts.today,
            ),
          },
          {
            label: 'Moving, 30 days',
            value: `${company.readouts.moving30}`,
            tone: company.readouts.moving30 === 0 ? 'muted' : undefined,
          },
          {
            label: 'Ownership',
            value: !company.readouts.ownership
              ? DASH
              : company.readouts.ownership.kind === 'implied'
                ? `~${fmtPct(company.readouts.ownership.pct)}`
                : fmtPct(company.readouts.ownership.pct),
          },
        ]}
      />

      <RecordBody
        rail={
          <>
            <WaitingRail entityId={company.id} counts={waiting} />
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
                <SpaceRailRow
                  key={s.id}
                  space={s}
                  onRemove={async () => {
                    await untagFromSpace({
                      data: { entityId: company.id, spaceId: s.id },
                    })
                    void router.invalidate()
                  }}
                />
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
              <SuggestSpacesAction entityId={company.id} />
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

            <TasksRail
              entityId={company.id}
              entityName={company.name}
              entityKind="company"
            />
          </>
        }
      >
        <AiCellsProvider entityIds={[company.id]} registry={registry}>
          <PropertyGrid>
            {registry.map((def) => (
              <RailField
                key={def.slug}
                entityId={company.id}
                def={def}
                attr={def}
                objectLabel={'company'}
                fillFrom="company"
                whereFrom={enrichment.whereFrom[def.slug]}
                onAttributeSaved={() => router.invalidate()}
                value={company.values[def.slug] ?? null}
                onSave={async (v) => {
                  const result = await updateRecord({
                    data: { id: company.id, patch: { [def.slug]: v } },
                  })
                  // A domain another company holds was refused; say so.
                  const collision = collisionToast(result, 'company')
                  if (collision)
                    toast(collision.title, {
                      description: collision.description,
                    })
                  void router.invalidate()
                }}
              />
            ))}
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
        </AiCellsProvider>

        <RecordNotes
          filed={notes.filed}
          mentions={notes.mentions}
          onNewNote={newNoteAboutThis}
        />

        <RecordLedger
          items={timeline}
          registry={registry}

          composer={
            <LogInteractionDialog
              seed={{ id: company.id, name: company.name, kind: 'company' }}
              trigger={
                <button className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 border-b border-rule px-3 text-left">
                  <span className="mono text-micro text-primary">+</span>
                  <span className="min-w-0 truncate text-ui text-graphite">
                    Log a call, meeting, or note…
                  </span>
                  <span className="flex-1" />
                  <KeyHint>L</KeyHint>
                </button>
              }
            />
          }
        />

        <RecordFiles entityId={company.id} documents={documents} />

        <RecordContext entityId={company.id} />
      </RecordBody>
    </div>
  )
}
