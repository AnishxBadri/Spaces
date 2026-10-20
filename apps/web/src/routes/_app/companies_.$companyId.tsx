import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { SaveAsTemplateAction } from '#/components/templates'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { SummarizeRecordButton } from '#/components/summarize'
import { Button } from '#/components/ui/button'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { TasksRail } from '#/components/tasks-rail'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import { KeyHint } from '#/components/page-header'
import {
  DetailsAddRow,
  DitherMark,
  InitialsMark,
  PropertyCell,
  PropertyGrid,
  RecordBody,
  RecordHeader,
} from '#/components/record/record-parts'
import { DetailsPickRow } from '#/components/record/details-add'
import {
  RelationSection,
  RelationSections,
  relationRows,
  withDerived,
} from '#/components/record/relation-section'
import { PropertyFold } from '#/components/record/property-fold'
import { RecordSpacesSection } from '#/components/record/spaces-section'
import { RecordTabs, useRecordTab } from '#/components/record/record-tabs'
import { RecordPicture } from '#/components/record/record-picture'
import { OptionChip } from '#/components/attributes/value-editor'
import { fmtPct } from '@spaces/core/portfolio/format'
import { DASH, readoutDay, readoutDayAgo } from '#/lib/records/readout-format'
import {
  LogComposerRow,
  LogInteractionDialog,
} from '#/components/log-interaction-dialog'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import type { InteractionFilter } from '#/lib/timeline/interaction-filter'
import type { NotesFilter } from '#/lib/notes/notes-filter'
import { WaitingRail } from '#/components/record/waiting-rail'
import { PluginActions } from '#/components/record/plugin-actions'
import { CreateDealDialog } from '#/routes/_app/deals'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { jsonStrings } from '@spaces/core/json'
import { fileInSpaceAction } from '#/lib/file-in-space'
import { runBinding, usePageActions } from '#/lib/page-actions'
import {
  linkedRecordTab,
  recordSearch,
  recordTabCounts,
} from '#/lib/records/record-tabs'
import { openModalId } from '#/lib/modal-search'
import { MeetingDialog } from '#/components/meeting-dialog'
import {
  countOpenSuggestions,
  createNote,
  getCompany,
  getRecordEnrichment,
  getEntitySensitivity,
  getRecordTimeline,
  listRecordActions,
  listRecordDocuments,
  listRecordNotes,
  listRegistry,
  listSpaces,
  searchEntities,
  setPersonCompany,
  updateRecord,
  saveRecordAsTemplate,
} from '#/lib/server-fns'
import { RecordMoreMenu } from '#/components/record/record-more-menu'

/**
 * A company's page (D74): the head and readouts, then the details column —
 * the property grid, Waiting, Team, Associated deals, Spaces, Tasks — and
 * the tabbed view. `?tab=` deep-links a tab.
 */
export const Route = createFileRoute('/_app/companies_/$companyId')({
  validateSearch: recordSearch,
  loader: async ({ params }) => {
    const [
      companyData,
      spaces,
      registry,
      dealRegistry,
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
      // Derived halves too: their rows read the resolver's value. (D69)
      listRegistry({ data: { kind: 'company', includeDerived: true } }),
      listRegistry({ data: { kind: 'deal' } }),
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
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    'company',
    linkedRecordTab(search),
    (next) =>
      void go({ search: { tab: next }, replace: true, resetScroll: false }),
  )
  // The Notes and Interactions filters, held here so the tab head's counts
  // follow them.
  const [notesFilter, setNotesFilter] = useState<NotesFilter>('all')
  const [interactionFilter, setInteractionFilter] =
    useState<InteractionFilter>('all')

  // Identity is an attribute (D75): the first domain names the record.
  const firstDomain = jsonStrings(company.values.domains).at(0)
  const nameAliases = company.aliases.filter(
    (a) => a.kind === 'name' && a.value !== company.name,
  )
  // Both sides of each relationship come from the one resolver. (D69)
  const team = relationRows(company.relations, 'team', true)
  const deals = relationRows(company.relations, 'associated_deals', true)
  const values = withDerived(company.values, company.relations)
  const searchPeople = useCallback(
    async (q: string) => {
      const on = new Set(team.map((p) => p.id))
      const rows = await searchEntities({ data: { q, kinds: ['person'] } })
      return rows.filter((r) => !on.has(r.id))
    },
    [team],
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

  usePageActions(
    [
      { id: 'log', label: 'Log interaction', key: 'L', run: runBinding('L') },
      { id: 'task', label: 'Add task', key: 'T', run: runBinding('T') },
      fileInSpaceAction({
        id: company.id,
        name: company.name,
        filedIds: company.spaces.map((s) => s.id),
      }),
    ],
    company.name,
  )

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={{ kind: 'Company' }}
        crumb={
          <>
            <Link to="/companies" className="focus-ring hover:text-foreground">
              Companies
            </Link>
            {' / '}
            {company.id.slice(0, 8)}
            {' / added '}
            {company.createdAt.slice(0, 10)}
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
            <RecordMoreMenu name={company.name} />
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
          firstDomain || nameAliases.length > 0 ? (
            <span className="min-w-0 truncate mono text-micro text-graphite">
              {[
                firstDomain,
                nameAliases.length > 0
                  ? `also ${nameAliases.map((a) => a.value).join(' · ')}`
                  : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(' · ')}
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
        details={
          <>
            <AiCellsProvider entityIds={[company.id]} registry={registry}>
              <PropertyGrid>
                <PropertyFold
                  defs={registry}
                  valueOf={(def) => values[def.slug]}
                  render={(def) => (
                    <RailField
                      key={def.slug}
                      entityId={company.id}
                      def={def}
                      attr={def}
                      objectLabel={'company'}
                      objectPlural="Companies"
                      fillFrom="company"
                      whereFrom={enrichment.whereFrom[def.slug]}
                      onAttributeSaved={() => router.invalidate()}
                      value={values[def.slug] ?? null}
                      refNames={company.refNames}
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
                  )}
                />
                <PropertyCell label="">
                  <AttributeCreateDialog
                    objectKind="company"
                    onCreated={() => router.invalidate()}
                    trigger={
                      <button className="focus-ring self-start mono text-micro text-graphite hover:text-foreground">
                        + add attribute
                      </button>
                    }
                  />
                </PropertyCell>
              </PropertyGrid>
            </AiCellsProvider>

            <WaitingRail entityId={company.id} counts={waiting} />

            <RelationSection
              label="Team"
              rows={team}
              empty="No one yet."
              mark={(p) => <InitialsMark name={p.name} outline />}
            >
              <DetailsPickRow
                label="Add a person…"
                placeholder="Person name…"
                search={searchPeople}
                onPick={async (hit) => {
                  await setPersonCompany({
                    data: {
                      personId: hit.id,
                      companyId: company.id,
                      action: 'link',
                    },
                  })
                  void router.invalidate()
                }}
              />
            </RelationSection>

            <RelationSection
              label="Associated deals"
              rows={deals}
              empty="Watching only."
              lane={(d) => {
                const stage = company.dealStages[d.id]
                return stage && stageDef ? (
                  <OptionChip def={stageDef} id={stage} className="shrink-0" />
                ) : null
              }}
            >
              <CreateDealDialog
                registry={dealRegistry}
                presetCompany={{ id: company.id, name: company.name }}
                trigger={<DetailsAddRow>New deal…</DetailsAddRow>}
              />
            </RelationSection>

            <RelationSections
              defs={registry}
              halves={company.relations}
              skip={['team', 'associated_deals']}
              onAdd={async (slug, value) => {
                await updateRecord({
                  data: { id: company.id, patch: { [slug]: value } },
                })
                void router.invalidate()
              }}
            />

            <RecordSpacesSection
              entityId={company.id}
              spaces={company.spaces}
              allSpaces={allSpaces}
            />

            <TasksRail
              entityId={company.id}
              entityName={company.name}
              entityKind="company"
              composer="row"
            />
          </>
        }
      >
        <RecordTabs
          label={company.name}
          tab={tab}
          onTabChange={changeTab}
          counts={recordTabCounts({
            notes,
            timeline,
            documents,
            notesFilter,
            interactionFilter,
          })}
          panels={{
            notes: (
              <RecordNotes
                notes={notes}
                filter={notesFilter}
                onFilterChange={setNotesFilter}
                onNewNote={newNoteAboutThis}
              />
            ),
            interactions: (
              <RecordInteractions
                filter={interactionFilter}
                onFilterChange={setInteractionFilter}
                items={timeline}
                registry={registry}
                recordId={company.id}
                composer={
                  <LogInteractionDialog
                    seed={{
                      id: company.id,
                      name: company.name,
                      kind: 'company',
                    }}
                    trigger={<LogComposerRow />}
                  />
                }
              />
            ),
            files: (
              <RecordFiles
                entityId={company.id}
                recordName={company.name}
                documents={documents}
              />
            ),
            history: <RecordHistory items={timeline} registry={registry} />,
          }}
        />
      </RecordBody>
      <MeetingDialog
        id={openModalId(search, 'meeting')}
        onOpenChange={(open) => {
          if (!open)
            void go({
              search: { tab: tab },
              replace: true,
              resetScroll: false,
            })
        }}
        onChanged={() => void router.invalidate()}
      />
    </div>
  )
}
