import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import { OptionChip } from '#/components/attributes/value-editor'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { MoveStageDialog } from '#/components/deal-board'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import {
  DitherMark,
  InitialsMark,
  RailGroup,
  RecordBody,
  RecordHeadPending,
  RecordHeader,
  PropertyGrid,
  StageStepper,
} from '#/components/record/record-parts'
import {
  MoveStageVerb,
  RecordHeadActions,
} from '#/components/record/record-heads'
import { RecordNotices } from '#/components/record/record-notices'
import { recordStamp } from '#/components/record/record-archive'
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
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { Badge } from '#/components/ui/badge'
import { fmtMoney } from '@spaces/core/portfolio/format'
import { readoutDay, readoutRound } from '#/lib/records/readout-format'
import { useHotkey } from '#/lib/use-hotkey'
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
  getDeal,
  getRecordTimeline,
  listRecordActions,
  listRecordDocuments,
  listRecordDuplicates,
  getEntitySensitivity,
  getRecordArchive,
  listOpenSuggestionTitles,
  listRecordNotes,
  listRegistry,
  listSpaces,
  searchEntities,
  updateRecord,
} from '#/lib/server-fns'

/**
 * A deal's page: the head and readouts, then the details column —
 * the property grid, Pipeline, Company, People, Spaces, Tasks — and the
 * tabbed view. `?tab=` deep-links a tab.
 */
export const Route = createFileRoute('/_app/deals_/$dealId')({
  validateSearch: recordSearch,
  loader: async ({ params }) => {
    const [
      deal,
      allSpaces,
      registry,
      timeline,
      documents,
      notes,
      waiting,
      sensitivity,
      archive,
      pluginActions,
      duplicates,
    ] = await Promise.all([
      getDeal({ data: { id: params.dealId } }),
      listSpaces(),
      // Derived halves too: their rows read the resolver's value.
      listRegistry({ data: { kind: 'deal', includeDerived: true } }),
      getRecordTimeline({ data: { entityId: params.dealId } }),
      listRecordDocuments({ data: { entityId: params.dealId } }),
      listRecordNotes({ data: { entityId: params.dealId } }),
      listOpenSuggestionTitles({ data: { entityId: params.dealId } }),
      getEntitySensitivity({ data: { entityId: params.dealId } }),
      getRecordArchive({ data: { id: params.dealId } }),
      listRecordActions({ data: { kind: 'deal' } }),
      listRecordDuplicates({ data: { entityId: params.dealId } }),
    ])
    if (deal.mergedIntoId) {
      throw redirect({
        to: '/deals/$dealId',
        params: { dealId: deal.mergedIntoId },
      })
    }
    return {
      deal,
      allSpaces,
      registry,
      timeline,
      documents,
      notes,
      waiting,
      sensitivity,
      archive,
      pluginActions,
      duplicates,
    }
  },
  pendingComponent: () => <RecordHeadPending kind="Deal" />,
  component: DealRecordPage,
})

function DealRecordPage() {
  const {
    deal,
    allSpaces,
    registry,
    timeline,
    documents,
    notes,
    waiting,
    sensitivity,
    archive,
    pluginActions,
    duplicates,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [moveOpen, setMoveOpen] = useState(false)
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    linkedRecordTab(search),
    (next) =>
      void go({ search: { tab: next }, replace: true, resetScroll: false }),
  )
  useHotkey(
    'm',
    useCallback(() => setMoveOpen(true), []),
  )

  const refNames = {
    ...deal.refNames,
    ...Object.fromEntries(
      Object.entries(deal.userNames).map(([id, name]) => [id, { name }]),
    ),
  }
  const stageDef = registry.find((d) => d.slug === 'stage')
  const stageOptions = stageDef?.options.options ?? []
  const stageOption = stageOptions.find((o) => o.id === deal.values.stage)
  // Move-stage never offers a retired stage; the header chip still shows one.
  const liveStages = stageOptions.filter((o) => !o.archived)

  // The readouts: our check, the company's round, the close, days in stage
  // against the stage's median, and the last contact through the company
  // and people.
  const { readouts } = deal
  const valueCode =
    registry.find((d) => d.slug === 'value')?.options.code ?? 'USD'
  const rawValue = deal.values.value
  const ourCheck =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue !== ''
        ? Number(rawValue)
        : null
  const closeDate =
    typeof deal.values.close_date === 'string' ? deal.values.close_date : null
  const daysInStage = readouts.daysInStage
  // Both sides of each relationship come from the one resolver.
  const people = relationRows(deal.relations, 'people', false)
  const peopleIds = useMemo(() => people.map((p) => p.id), [people])
  const company = relationRows(deal.relations, 'company', false)
  const values = withDerived(deal.values, deal.relations)
  const searchPeople = useCallback(
    async (q: string) => {
      const rows = await searchEntities({ data: { q, kinds: ['person'] } })
      return rows.filter((r) => !peopleIds.includes(r.id))
    },
    [peopleIds],
  )
  const searchCompanies = useCallback(
    (q: string) => searchEntities({ data: { q, kinds: ['company'] } }),
    [],
  )

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

  usePageActions(
    [
      ...(liveStages.length > 0
        ? [
            {
              id: 'move-stage',
              label: 'Move stage',
              key: 'M',
              run: () => setMoveOpen(true),
            },
          ]
        : []),
      { id: 'log', label: 'Log interaction', key: 'L', run: runBinding('L') },
      { id: 'task', label: 'Add task', key: 'T', run: runBinding('T') },
    ],
    deal.name,
  )

  return (
    <div className="flex min-h-full flex-col">
      {moveOpen && liveStages.length > 0 ? (
        // Same post-mortem gate the board's drag path has — Passed/Lost ask
        // for a reason inside the dialog.
        <MoveStageDialog
          dealName={deal.name}
          stages={liveStages}
          currentId={stageOption?.id ?? null}
          daysInStage={daysInStage}
          onCancel={() => setMoveOpen(false)}
          onMove={(stageId, reason) => {
            void save({
              stage: stageId,
              ...(reason ? { close_reason: reason } : {}),
            })
            setMoveOpen(false)
          }}
        />
      ) : null}

      <RecordHeader
        stamp={recordStamp('Deal', sensitivity, archive)}
        archived={archive !== null}
        actions={
          <RecordHeadActions
            record={{ id: deal.id, name: deal.name, kind: 'deal' }}
            archived={archive !== null}
            verbs={
              liveStages.length > 0 ? (
                <MoveStageVerb onMove={() => setMoveOpen(true)} />
              ) : null
            }
            sensitivity={sensitivity}
            template="deal"
            pluginActions={pluginActions}
          />
        }
        mark={<DitherMark />}
        name={deal.name}
        badges={
          <>
            {stageOption && stageDef ? (
              <OptionChip
                def={stageDef}
                id={stageOption.id}
                className="h-5 shrink-0 py-0 leading-5"
              />
            ) : null}
            {deal.outsideMandate ? (
              // A hint, never a block — edge cases are the job. Deliberately
              // quiet: same-hue tint, no red.
              // Amber is named, not resolved: `optionColor` returns a stored
              // colour unchanged, so the one badge the instrument colours for
              // itself goes through the same primitive as the data-coloured
              // ones.
              <Badge
                asChild
                option={{ color: 'amber' }}
                index={0}
                className="shrink-0 gap-1"
              >
                <Link
                  to="/mandate"
                  title="This company's stage is outside the mandate's stages. Click to review the mandate."
                >
                  <Compass className="size-3" strokeWidth={2} />
                  Outside mandate
                </Link>
              </Badge>
            ) : null}
          </>
        }
      />

      <RecordNotices
        recordId={deal.id}
        archive={archive}
        duplicates={duplicates}
      />

      <RecordBody
        groups
        details={
          <>
            <AiCellsProvider entityIds={[deal.id]} registry={registry}>
              <PropertyGrid>
                <PropertyFold
                  defs={registry}
                  valueOf={(def) => values[def.slug]}
                  render={(def) => (
                    <RailField
                      key={def.slug}
                      entityId={deal.id}
                      def={def}
                      attr={def}
                      objectLabel={'deal'}
                      objectPlural="Deals"
                      onAttributeSaved={() => router.invalidate()}
                      value={values[def.slug] ?? null}
                      refNames={refNames}
                      onSave={async (v) => {
                        await updateRecord({
                          data: { id: deal.id, patch: { [def.slug]: v } },
                        })
                        void router.invalidate()
                      }}
                    />
                  )}
                  create={(opener) => (
                    <AttributeCreateDialog
                      objectKind="deal"
                      onCreated={() => router.invalidate()}
                      {...opener}
                    />
                  )}
                />
              </PropertyGrid>
            </AiCellsProvider>

            <RailGroup
              label="Pipeline"
              count={
                stageOption
                  ? `${Math.max(1, liveStages.findIndex((o) => o.id === stageOption.id) + 1)} of ${liveStages.length}`
                  : undefined
              }
            >
              <li className="py-2.5">
                <StageStepper
                  stages={liveStages}
                  currentId={stageOption?.id ?? null}
                  days={daysInStage}
                  median={
                    readouts.medianDaysInStage === null
                      ? null
                      : Math.round(readouts.medianDaysInStage)
                  }
                />
              </li>
            </RailGroup>

            <RelationSection
              label="Company"
              rows={company}
              mark={() => <DitherMark size={14} />}
              add={
                company.length === 0
                  ? (trigger) => (
                      <PickPopover
                        trigger={trigger}
                        placeholder="Add the company…"
                        search={searchCompanies}
                        onPick={(hit) => save({ company: hit.id })}
                      />
                    )
                  : undefined
              }
            />

            <RelationSection
              label="People"
              rows={people}
              mark={(p) => <InitialsMark name={p.name} />}
              add={(trigger) => (
                <PickPopover
                  trigger={trigger}
                  placeholder="Add a person…"
                  search={searchPeople}
                  onPick={(hit) => save({ people: [...peopleIds, hit.id] })}
                />
              )}
            />

            <RelationSections
              defs={registry}
              halves={deal.relations}
              skip={['company', 'people']}
              onAdd={(slug, value) => save({ [slug]: value })}
            />

            <RecordSpacesSection
              entityId={deal.id}
              spaces={deal.spaces}
              allSpaces={allSpaces}
            />

            <WaitingRail entityId={deal.id} waiting={waiting} />
          </>
        }
      >
        <RecordTabs
          label={deal.name}
          tab={tab}
          onTabChange={changeTab}
          counts={recordTabCounts({ notes, timeline, documents })}
          panels={{
            overview: (
              <RecordOverview
                record={{ id: deal.id, name: deal.name, kind: 'deal' }}
                readouts={[
                  {
                    label: 'Our check',
                    value:
                      ourCheck !== null && Number.isFinite(ourCheck)
                        ? fmtMoney(ourCheck, valueCode)
                        : null,
                  },
                  { label: 'Round', value: readoutRound(readouts.round) },
                  {
                    label: 'Close',
                    value: readoutDay(closeDate, readouts.today),
                    tone:
                      closeDate !== null && closeDate < readouts.today
                        ? 'bad'
                        : undefined,
                  },
                  {
                    label: 'Days in stage',
                    value:
                      readouts.medianDaysInStage === null
                        ? daysInStage
                        : `${daysInStage} · med ${Math.round(readouts.medianDaysInStage)}`,
                    tone: readouts.pastTwiceMedian ? 'bad' : undefined,
                  },
                  {
                    label: 'Last contact',
                    value: readoutDay(readouts.lastContact, readouts.today),
                  },
                ]}
                timeline={timeline}
                documents={documents}
                onTab={changeTab}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
                    trigger={trigger}
                  />
                )}
              />
            ),
            notes: <RecordNotes notes={notes} onNewNote={newNoteAboutThis} />,
            interactions: (
              <RecordInteractions
                items={timeline}
                record={{ id: deal.id, name: deal.name }}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
                    trigger={trigger}
                  />
                )}
              />
            ),
            files: (
              <RecordFiles
                entityId={deal.id}
                recordName={deal.name}
                documents={documents}
              />
            ),
            history: (
              <RecordHistory
                items={timeline}
                registry={registry}
                refNames={refNames}
              />
            ),
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
