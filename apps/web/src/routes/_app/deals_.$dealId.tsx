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
import { TasksRail } from '#/components/tasks-rail'
import { MoveStageDialog } from '#/components/deal-board'
import {
  LogComposerRow,
  LogInteractionDialog,
} from '#/components/log-interaction-dialog'
import { KeyHint } from '#/components/page-header'
import {
  DitherMark,
  InitialsMark,
  PropertyCell,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  PropertyGrid,
  StageStepper,
} from '#/components/record/record-parts'
import { DetailsPickRow } from '#/components/record/details-add'
import { PropertyFold } from '#/components/record/property-fold'
import { RecordSpacesSection } from '#/components/record/spaces-section'
import { RecordTabs, useRecordTab } from '#/components/record/record-tabs'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { SummarizeRecordButton } from '#/components/summarize'
import { PluginActions } from '#/components/record/plugin-actions'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { fmtMoney } from '@spaces/core/portfolio/format'
import {
  readoutDay,
  readoutDayUntil,
  readoutRound,
} from '#/lib/records/readout-format'
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
  countOpenSuggestions,
  createNote,
  getDeal,
  getRecordTimeline,
  listRecordActions,
  listRecordDocuments,
  getEntitySensitivity,
  listRecordNotes,
  listRegistry,
  listSpaces,
  searchEntities,
  updateRecord,
} from '#/lib/server-fns'
import { RecordMoreMenu } from '#/components/record/record-more-menu'

/**
 * A deal's page (D74): the head and readouts, then the details column —
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
      pluginActions,
    ] = await Promise.all([
      getDeal({ data: { id: params.dealId } }),
      listSpaces(),
      listRegistry({ data: { kind: 'deal' } }),
      getRecordTimeline({ data: { entityId: params.dealId } }),
      listRecordDocuments({ data: { entityId: params.dealId } }),
      listRecordNotes({ data: { entityId: params.dealId } }),
      countOpenSuggestions({ data: { entityId: params.dealId } }),
      getEntitySensitivity({ data: { entityId: params.dealId } }),
      listRecordActions({ data: { kind: 'deal' } }),
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
      pluginActions,
    }
  },
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
    pluginActions,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [moveOpen, setMoveOpen] = useState(false)
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    'deal',
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
  // and people (D49).
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
  const peopleIds = useMemo(
    () =>
      Array.isArray(deal.values.people) ? deal.values.people.map(String) : [],
    [deal.values.people],
  )
  // refNames' Record index type hides misses; hasOwn is the honest test.
  const people = peopleIds.flatMap((id) =>
    Object.hasOwn(deal.refNames, id)
      ? [{ id, name: deal.refNames[id].name }]
      : [],
  )
  const companyId =
    typeof deal.values.company === 'string' ? deal.values.company : null
  const company =
    companyId !== null && Object.hasOwn(deal.refNames, companyId)
      ? { id: companyId, name: deal.refNames[companyId].name }
      : null
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
        stamp={{ kind: 'Deal' }}
        crumb={
          <>
            <Link to="/deals" className="focus-ring hover:text-foreground">
              Deals
            </Link>
            {' / '}
            {deal.id.slice(0, 8)}
            {' / added '}
            {deal.createdAt.slice(0, 10)}
          </>
        }
        actions={
          <>
            <SensitiveToggle entityId={deal.id} state={sensitivity} />
            <SummarizeRecordButton recordId={deal.id} />
            <PluginActions entityId={deal.id} actions={pluginActions} />
            <LogInteractionDialog
              seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
              hotkey="l"
              trigger={
                <Button variant="outline">
                  Log interaction
                  <KeyHint>L</KeyHint>
                </Button>
              }
            />
            {/* Opens the Tasks section's composer, which `T` binds. */}
            <Button variant="outline" onClick={runBinding('T')}>
              Task
              <KeyHint>T</KeyHint>
            </Button>
            {liveStages.length > 0 ? (
              <Button variant="outline" onClick={() => setMoveOpen(true)}>
                Move stage
                <KeyHint>M</KeyHint>
              </Button>
            ) : null}
            <RecordMoreMenu name={deal.name} />
          </>
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
        readouts={[
          {
            label: 'Our check',
            value:
              ourCheck !== null && Number.isFinite(ourCheck)
                ? fmtMoney(ourCheck, valueCode)
                : '—',
            tone: ourCheck === null ? 'muted' : undefined,
          },
          {
            label: 'Round',
            value: readoutRound(readouts.round),
          },
          {
            label: 'Close',
            value: readoutDayUntil(closeDate, readouts.today),
            tone:
              closeDate !== null && closeDate < readouts.today
                ? 'bad'
                : undefined,
          },
          {
            label: 'Days in stage',
            value:
              readouts.medianDaysInStage === null
                ? `${daysInStage}`
                : `${daysInStage} · med ${Math.round(readouts.medianDaysInStage)}`,
            tone: readouts.pastTwiceMedian ? 'bad' : undefined,
          },
          {
            label: 'Last contact',
            value: readoutDay(readouts.lastContact, readouts.today),
          },
        ]}
      />

      <RecordBody
        details={
          <>
            <AiCellsProvider entityIds={[deal.id]} registry={registry}>
              <PropertyGrid>
                <PropertyFold
                  defs={registry}
                  valueOf={(def) => deal.values[def.slug]}
                  render={(def) => (
                    <RailField
                      key={def.slug}
                      entityId={deal.id}
                      def={def}
                      attr={def}
                      objectLabel={'deal'}
                      objectPlural="Deals"
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
                  )}
                />
                <PropertyCell label="">
                  <AttributeCreateDialog
                    objectKind="deal"
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

            <RailSection
              label="Pipeline"
              meta={
                stageOption
                  ? `${Math.max(1, liveStages.findIndex((o) => o.id === stageOption.id) + 1)} of ${liveStages.length}`
                  : undefined
              }
            >
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
            </RailSection>

            <WaitingRail entityId={deal.id} counts={waiting} />

            <RailSection label="Company" meta={company ? '1' : '0'}>
              {company ? (
                <RailItem>
                  <DitherMark size={14} />
                  <Link
                    to="/companies/$companyId"
                    params={{ companyId: company.id }}
                    className="focus-ring min-w-0 flex-1 truncate hover:underline"
                  >
                    {company.name}
                  </Link>
                </RailItem>
              ) : (
                <DetailsPickRow
                  label="Add the company…"
                  placeholder="Company name…"
                  search={searchCompanies}
                  onPick={(hit) => save({ company: hit.id })}
                />
              )}
            </RailSection>

            <RailSection label="People" meta={`${people.length}`}>
              {people.length === 0 ? <RailEmpty>No one yet.</RailEmpty> : null}
              {people.map((p) => (
                <RailItem key={p.id}>
                  <InitialsMark name={p.name} />
                  <Link
                    to="/people/$personId"
                    params={{ personId: p.id }}
                    className="focus-ring min-w-0 truncate hover:underline"
                  >
                    {p.name}
                  </Link>
                </RailItem>
              ))}
              <DetailsPickRow
                label="Add a person…"
                placeholder="Person name…"
                search={searchPeople}
                onPick={(hit) => save({ people: [...peopleIds, hit.id] })}
              />
            </RailSection>

            <RecordSpacesSection
              entityId={deal.id}
              spaces={deal.spaces}
              allSpaces={allSpaces}
            />

            <TasksRail
              entityId={deal.id}
              entityName={deal.name}
              entityKind="deal"
              composer="row"
            />
          </>
        }
      >
        <RecordTabs
          label={deal.name}
          tab={tab}
          onTabChange={changeTab}
          counts={recordTabCounts({ notes, timeline, documents })}
          panels={{
            notes: (
              <RecordNotes
                filed={notes.filed}
                mentions={notes.mentions}
                onNewNote={newNoteAboutThis}
              />
            ),
            interactions: (
              <RecordInteractions
                items={timeline}
                registry={registry}
                refNames={refNames}
                composer={
                  <LogInteractionDialog
                    seed={{ id: deal.id, name: deal.name, kind: 'deal' }}
                    trigger={<LogComposerRow />}
                  />
                }
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
                filters
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
