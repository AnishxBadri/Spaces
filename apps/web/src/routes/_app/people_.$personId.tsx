import { readoutDay } from '#/lib/records/readout-format'
import {
  createFileRoute,
  Link,
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
  RailGroup,
  RailGroupRow,
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
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { recordPath } from '#/lib/record-path'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { jsonString } from '@spaces/core/json'
import { isNamePart } from '@spaces/core/attributes/person-name'
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
  getEntitySensitivity,
  getPerson,
  getRecordEnrichment,
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
 * A person's page: the head and readouts, then the details column —
 * the property grid, Companies with the role, Deals, Waiting, Spaces, Tasks
 * — and the tabbed view. `?tab=` deep-links a tab.
 */
export const Route = createFileRoute('/_app/people_/$personId')({
  validateSearch: recordSearch,
  loader: async ({ params }) => {
    const [
      personData,
      spaces,
      registry,
      timeline,
      documents,
      notes,
      waiting,
      sensitivity,
      pluginActions,
      enrichment,
      duplicates,
    ] = await Promise.all([
      getPerson({ data: { id: params.personId } }),
      listSpaces(),
      // Derived halves too: their rows read the resolver's value.
      listRegistry({ data: { kind: 'person', includeDerived: true } }),
      getRecordTimeline({ data: { entityId: params.personId } }),
      listRecordDocuments({ data: { entityId: params.personId } }),
      listRecordNotes({ data: { entityId: params.personId } }),
      listOpenSuggestionTitles({ data: { entityId: params.personId } }),
      getEntitySensitivity({ data: { entityId: params.personId } }),
      listRecordActions({ data: { kind: 'person' } }),
      getRecordEnrichment({
        data: { entityId: params.personId, kind: 'person' },
      }),
      listRecordDuplicates({ data: { entityId: params.personId } }),
    ])
    if (personData.mergedIntoId) {
      throw redirect({
        to: '/people/$personId',
        params: { personId: personData.mergedIntoId },
      })
    }
    return {
      person: personData,
      allSpaces: spaces,
      registry,
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
  pendingComponent: () => <RecordHeadPending kind="Person" />,
  component: PersonRecordPage,
})

function PersonRecordPage() {
  const {
    person,
    allSpaces,
    registry,
    timeline,
    documents,
    notes,
    waiting,
    sensitivity,
    pluginActions,
    enrichment,
    duplicates,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    linkedRecordTab(search),
    (next) =>
      void go({ search: { tab: next }, replace: true, resetScroll: false }),
  )

  const role = jsonString(person.values.job_title)
  // Both sides of each relationship come from the one resolver.
  const companies = relationRows(person.relations, 'companies', false)
  const deals = relationRows(person.relations, 'deals', true)
  const values = withDerived(person.values, person.relations)
  // Beside the name: `role · company`.
  const nameMeta = [role, companies.at(0)?.name]
    .filter((part) => part !== null && part !== undefined && part !== '')
    .join(' · ')
  // The name's parts lead the grid; the head is their join.
  const fields = [
    ...registry.filter((def) => isNamePart(def.slug)),
    ...registry.filter((def) => !isNamePart(def.slug)),
  ]
  const searchCompanies = useCallback(
    async (q: string) => {
      const on = new Set(companies.map((c) => c.id))
      const rows = await searchEntities({ data: { q, kinds: ['company'] } })
      return rows.filter((r) => !on.has(r.id))
    },
    [companies],
  )
  const searchDeals = useCallback(
    async (q: string) => {
      const on = new Set(deals.map((d) => d.id))
      const rows = await searchEntities({ data: { q, kinds: ['deal'] } })
      return rows.filter((r) => !on.has(r.id))
    },
    [deals],
  )

  /** Write one of this person's own relationship halves; `setValues` puts a
   *  derived half's write on its owner. */
  async function saveRelation(slug: string, value: string | Array<string>) {
    await updateRecord({ data: { id: person.id, patch: { [slug]: value } } })
    void router.invalidate()
  }

  async function newNoteAboutThis() {
    try {
      const { id } = await createNote({
        data: {
          about: { entityId: person.id, label: person.name, kind: 'person' },
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
        id: person.id,
        name: person.name,
        filedIds: person.spaces.map((s) => s.id),
      }),
    ],
    person.name,
  )

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={sensitiveStamp('Person', sensitivity)}
        actions={
          <RecordHeadActions
            record={{ id: person.id, name: person.name, kind: 'person' }}
            enrich={enrichment}
            sensitivity={sensitivity}
            template="person"
            pluginActions={pluginActions}
          />
        }
        mark={
          <RecordPicture
            entityId={person.id}
            picture={person.picture}
            fallback={<InitialsMark name={person.name} size="lg" />}
          />
        }
        name={person.name}
        suffix={nameMeta === '' ? undefined : { role: nameMeta }}
      />

      <RecordNotices
        recordId={person.id}
        duplicates={duplicates}
        parked={enrichment.parked}
      />

      <RecordBody
        groups
        details={
          <>
            <AiCellsProvider entityIds={[person.id]} registry={registry}>
              <PropertyGrid>
                <PropertyFold
                  defs={fields}
                  valueOf={(def) => values[def.slug]}
                  render={(def) => (
                    <RailField
                      key={def.slug}
                      entityId={person.id}
                      def={def}
                      attr={def}
                      objectLabel={'person'}
                      objectPlural="People"
                      fillFrom="person"
                      whereFrom={enrichment.whereFrom[def.slug]}
                      onAttributeSaved={() => router.invalidate()}
                      value={values[def.slug] ?? null}
                      refNames={person.refNames}
                      onSave={async (v) => {
                        const result = await updateRecord({
                          data: { id: person.id, patch: { [def.slug]: v } },
                        })
                        // An email another person holds was refused; say so.
                        const collision = collisionToast(result, 'person')
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
                      objectKind="person"
                      onCreated={() => router.invalidate()}
                      {...opener}
                    />
                  )}
                />
              </PropertyGrid>
            </AiCellsProvider>

            {/* The person's `companies` value, the role on the first. */}
            <RelationSection
              label="Companies"
              rows={companies}
              mark={() => <DitherMark size={14} />}
              lane={(_, i) =>
                i === 0 && role ? (
                  <span className="truncate mono text-micro text-graphite">
                    {role}
                  </span>
                ) : null
              }
              add={(trigger) => (
                <PickPopover
                  trigger={trigger}
                  placeholder="Add a company…"
                  search={searchCompanies}
                  onPick={async (hit) => {
                    await setPersonCompany({
                      data: {
                        personId: person.id,
                        companyId: hit.id,
                        action: 'link',
                      },
                    })
                    void router.invalidate()
                  }}
                />
              )}
            />

            <RelationSection
              label="Deals"
              rows={deals}
              add={(trigger) => (
                <PickPopover
                  trigger={trigger}
                  placeholder="Add to a deal…"
                  search={searchDeals}
                  onPick={(hit) =>
                    saveRelation('deals', [...deals.map((d) => d.id), hit.id])
                  }
                />
              )}
            />

            <RelationSections
              defs={registry}
              halves={person.relations}
              skip={['companies', 'deals']}
              onAdd={saveRelation}
            />

            {/* Inbound record-references outside any relationship, one
                section per attribute — heading and grouping are both data. */}
            {person.referencedBy.map((group) => (
              <RailGroup
                key={`${group.label}:${group.attrSlug}`}
                label={group.label}
                count={`${group.items.length} via ${group.via.toLowerCase()}`}
              >
                {group.items.map((item) => {
                  const href = recordPath({
                    kind: item.kind,
                    id: item.id,
                    objectSlug: item.objectSlug,
                  })
                  return (
                    <RailGroupRow key={item.id}>
                      {href ? (
                        <Link
                          to={href}
                          className="focus-ring min-w-0 flex-1 truncate hover:underline"
                        >
                          {item.name}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-graphite">
                          {item.name}
                        </span>
                      )}
                    </RailGroupRow>
                  )
                })}
              </RailGroup>
            ))}

            <RecordSpacesSection
              entityId={person.id}
              spaces={person.spaces}
              allSpaces={allSpaces}
            />

            <WaitingRail entityId={person.id} waiting={waiting} />
          </>
        }
      >
        <RecordTabs
          label={person.name}
          tab={tab}
          onTabChange={changeTab}
          counts={recordTabCounts({ notes, timeline, documents })}
          panels={{
            overview: (
              <RecordOverview
                record={{ id: person.id, name: person.name, kind: 'person' }}
                readouts={[
                  {
                    label: 'Last contact',
                    value: readoutDay(
                      person.readouts.lastContact,
                      person.readouts.today,
                    ),
                  },
                  {
                    label: 'Last email',
                    value: readoutDay(
                      person.readouts.lastEmail,
                      person.readouts.today,
                    ),
                  },
                  {
                    label: 'Next meeting',
                    value: readoutDay(
                      person.readouts.nextMeeting,
                      person.readouts.today,
                    ),
                  },
                  {
                    label: 'First contact',
                    value: readoutDay(
                      person.readouts.firstContact,
                      person.readouts.today,
                    ),
                  },
                ]}
                timeline={timeline}
                documents={documents}
                onTab={changeTab}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{ id: person.id, name: person.name, kind: 'person' }}
                    trigger={trigger}
                  />
                )}
              />
            ),
            notes: <RecordNotes notes={notes} onNewNote={newNoteAboutThis} />,
            interactions: (
              <RecordInteractions
                items={timeline}
                record={{ id: person.id, name: person.name }}
                logInteraction={(trigger) => (
                  <LogInteractionDialog
                    seed={{ id: person.id, name: person.name, kind: 'person' }}
                    trigger={trigger}
                  />
                )}
              />
            ),
            files: (
              <RecordFiles
                entityId={person.id}
                recordName={person.name}
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
