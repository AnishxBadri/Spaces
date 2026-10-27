import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import {
  DitherMark,
  InitialsMark,
  PropertyGrid,
  RecordBody,
  RecordHeadPending,
  RecordHeader,
} from '#/components/record/record-parts'
import { RecordHeadActions } from '#/components/record/record-heads'
import { RecordNotices } from '#/components/record/record-notices'
import { sensitiveStamp } from '#/components/sensitive-toggle'
import { PickPopover } from '#/components/record/details-add'
import {
  RelationSection,
  RelationSections,
  relationRows,
  withDerived,
} from '#/components/record/relation-section'
import { PropertyFold } from '#/components/record/property-fold'
import { RecordSpacesSection } from '#/components/record/spaces-section'
import { RecordTabs, useRecordTab } from '#/components/record/record-tabs'
import { RecordOverview } from '#/components/record/record-overview'
import { RecordPicture } from '#/components/record/record-picture'
import { OptionChip } from '#/components/attributes/value-editor'
import { fmtPct } from '@spaces/core/portfolio/format'
import { readoutDay } from '#/lib/records/readout-format'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { CreateDealDialog } from '#/components/create-deal-dialog'
import { collisionToast } from '#/lib/attributes/collision-toast'
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
  createNote,
  getCompany,
  getRecordEnrichment,
  getEntitySensitivity,
  getRecordTimeline,
  listRecordActions,
  listRecordDocuments,
  listRecordDuplicates,
  listOpenSuggestionTitles,
  listRecordNotes,
  listRegistry,
  listSpaces,
  searchEntities,
  setPersonCompany,
  updateRecord,
} from '#/lib/server-fns'

/**
 * A company's page: the head and readouts, then the details column —
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
      duplicates,
    ] = await Promise.all([
      getCompany({ data: { id: params.companyId } }),
      listSpaces(),
      // Derived halves too: their rows read the resolver's value.
      listRegistry({ data: { kind: 'company', includeDerived: true } }),
      listRegistry({ data: { kind: 'deal' } }),
      getRecordTimeline({ data: { entityId: params.companyId } }),
      listRecordDocuments({ data: { entityId: params.companyId } }),
      listRecordNotes({ data: { entityId: params.companyId } }),
      listOpenSuggestionTitles({ data: { entityId: params.companyId } }),
      getEntitySensitivity({ data: { entityId: params.companyId } }),
      listRecordActions({ data: { kind: 'company' } }),
      getRecordEnrichment({
        data: { entityId: params.companyId, kind: 'company' },
      }),
      listRecordDuplicates({ data: { entityId: params.companyId } }),
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
      duplicates,
    }
  },
  pendingComponent: () => <RecordHeadPending kind="Company" />,
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
    duplicates,
  } = Route.useLoaderData()
  const stageDef = dealRegistry.find((d) => d.slug === 'stage')
  const router = useRouter()
  const navigate = useNavigate()
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    linkedRecordTab(search),
    (next) =>
      void go({ search: { tab: next }, replace: true, resetScroll: false }),
  )

  // Both sides of each relationship come from the one resolver.
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
        stamp={sensitiveStamp('Company', sensitivity)}
        actions={
          <RecordHeadActions
            record={{ id: company.id, name: company.name, kind: 'company' }}
            enrich={enrichment}
            sensitivity={sensitivity}
            template="company"
            pluginActions={pluginActions}
          />
        }
        mark={
          <RecordPicture
            entityId={company.id}
            picture={company.picture}
            fallback={<DitherMark />}
          />
        }
        name={company.name}
      />

      <RecordNotices
        recordId={company.id}
        duplicates={duplicates}
        parked={enrichment.parked}
      />

      <RecordBody
        groups
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
                  create={(opener) => (
                    <AttributeCreateDialog
                      objectKind="company"
                      onCreated={() => router.invalidate()}
                      {...opener}
                    />
                  )}
                />
              </PropertyGrid>
            </AiCellsProvider>

            <RelationSection
              label="Team"
              rows={team}
              mark={(p) => <InitialsMark name={p.name} outline />}
              lane={(p) =>
                p.id in company.teamRoles ? (
                  <span className="truncate label-caps text-graphite">
                    {company.teamRoles[p.id]}
                  </span>
                ) : null
              }
              add={(trigger) => (
                <PickPopover
                  trigger={trigger}
                  placeholder="Add a person…"
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
              )}
            />

            <RelationSection
              label="Associated deals"
              rows={deals}
              lane={(d) => {
                const stage = company.dealStages[d.id]
                return stage && stageDef ? (
                  <OptionChip def={stageDef} id={stage} className="shrink-0" />
                ) : null
              }}
              add={(trigger) => (
                <CreateDealDialog
                  registry={dealRegistry}
                  presetCompany={{ id: company.id, name: company.name }}
                  trigger={trigger}
                />
              )}
            />

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

            <WaitingRail entityId={company.id} waiting={waiting} />
          </>
        }
      >
        <RecordTabs
          label={company.name}
          tab={tab}
          onTabChange={changeTab}
          counts={recordTabCounts({ notes, timeline, documents })}
          panels={{
            overview: (
              <RecordOverview
                record={{ id: company.id, name: company.name, kind: 'company' }}
                readouts={[
                  {
                    label: 'Last contact',
                    value: readoutDay(
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
                    value: company.readouts.moving30,
                  },
                  {
                    label: 'Ownership',
                    value: !company.readouts.ownership
                      ? null
                      : company.readouts.ownership.kind === 'implied'
                        ? `~${fmtPct(company.readouts.ownership.pct)}`
                        : fmtPct(company.readouts.ownership.pct),
                  },
                ]}
                timeline={timeline}
                documents={documents}
                onTab={changeTab}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{
                      id: company.id,
                      name: company.name,
                      kind: 'company',
                    }}
                    trigger={trigger}
                  />
                )}
              />
            ),
            notes: <RecordNotes notes={notes} onNewNote={newNoteAboutThis} />,
            interactions: (
              <RecordInteractions
                items={timeline}
                record={{ id: company.id, name: company.name }}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{
                      id: company.id,
                      name: company.name,
                      kind: 'company',
                    }}
                    trigger={trigger}
                  />
                )}
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
