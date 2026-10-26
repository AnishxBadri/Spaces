import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import {
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
import { linksPeople } from '#/lib/records/head'
import { PropertyFold } from '#/components/record/property-fold'
import {
  RelationSections,
  withDerived,
} from '#/components/record/relation-section'
import { RecordSpacesSection } from '#/components/record/spaces-section'
import { RecordTabs, useRecordTab } from '#/components/record/record-tabs'
import { RecordOverview } from '#/components/record/record-overview'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordHistory, RecordInteractions } from '#/components/record-timeline'
import type { InteractionFilter } from '#/lib/timeline/interaction-filter'
import type { NotesFilter } from '#/lib/notes/notes-filter'
import { WaitingRail } from '#/components/record/waiting-rail'
import {
  LogComposerRow,
  LogInteractionDialog,
} from '#/components/log-interaction-dialog'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { objectIcon } from '#/lib/object-icons'
import { recordPath } from '#/lib/record-path'
import { readoutDay } from '#/lib/records/readout-format'
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
  getObjectRecord,
  getRecordTimeline,
  listRecordDocuments,
  listRecordDuplicates,
  getEntitySensitivity,
  listOpenSuggestionTitles,
  listRecordNotes,
  listRegistry,
  listSpaces,
  updateRecord,
} from '#/lib/server-fns'

/**
 * The registry-generated record page for a custom object: a
 * company's anatomy minus enrichment. The details column holds the grid
 * from the registry, the records that point here, Spaces and Tasks; the
 * head logs an interaction (`L`) when the object links people. A record
 * merged away redirects to its winner from the loader.
 */
export const Route = createFileRoute('/_app/o_/$objectSlug/$recordId')({
  validateSearch: recordSearch,
  loader: async ({ params }) => {
    const record = await getObjectRecord({ data: { id: params.recordId } })
    if (record.object.slug !== params.objectSlug) throw notFound()
    if (record.object.archived) throw notFound()
    if (record.mergedIntoId)
      throw redirect({
        to: '/o/$objectSlug/$recordId',
        params: {
          objectSlug: params.objectSlug,
          recordId: record.mergedIntoId,
        },
      })
    const [
      registry,
      timeline,
      documents,
      spaces,
      notes,
      waiting,
      sensitivity,
      duplicates,
    ] = await Promise.all([
      // Derived halves too: their rows read the resolver's value.
      listRegistry({
        data: { objectId: record.object.id, includeDerived: true },
      }),
      getRecordTimeline({ data: { entityId: record.id } }),
      listRecordDocuments({ data: { entityId: record.id } }),
      listSpaces(),
      // A custom record is an entity like any other, so the lanes need only
      // its id — the object slug is the page's, never the note row's.
      listRecordNotes({ data: { entityId: record.id } }),
      listOpenSuggestionTitles({ data: { entityId: record.id } }),
      getEntitySensitivity({ data: { entityId: record.id } }),
      listRecordDuplicates({ data: { entityId: record.id } }),
    ])
    return {
      record,
      registry,
      timeline,
      documents,
      allSpaces: spaces,
      notes,
      waiting,
      sensitivity,
      duplicates,
    }
  },
  pendingComponent: () => <RecordHeadPending kind="Record" />,
  component: ObjectRecordPage,
})

function ObjectRecordPage() {
  const {
    record,
    registry,
    timeline,
    documents,
    allSpaces,
    notes,
    waiting,
    sensitivity,
    duplicates,
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const Icon = objectIcon(record.object)
  const values = withDerived(record.values, record.relations)
  const go = Route.useNavigate()
  const search = Route.useSearch()
  const [tab, changeTab] = useRecordTab(
    linkedRecordTab(search),
    (next) =>
      void go({ search: { tab: next }, replace: true, resetScroll: false }),
  )
  // The Notes and Interactions filters, held here so the tab head's counts
  // follow them.
  const [notesFilter, setNotesFilter] = useState<NotesFilter>('all')
  const [interactionFilter, setInteractionFilter] =
    useState<InteractionFilter>('all')

  async function newNoteAboutThis() {
    try {
      const { id } = await createNote({
        data: {
          about: {
            entityId: record.id,
            label: record.name,
            kind: 'custom',
            objectSlug: record.object.slug,
          },
        },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  // Interactions are logged with people: only an object that links them
  // logs one.
  const logs = linksPeople(registry)
  usePageActions(
    [
      ...(logs
        ? [
            {
              id: 'log',
              label: 'Log interaction',
              key: 'L',
              run: runBinding('L'),
            },
          ]
        : []),
      { id: 'task', label: 'Add task', key: 'T', run: runBinding('T') },
      fileInSpaceAction({
        id: record.id,
        name: record.name,
        filedIds: record.spaces.map((s) => s.id),
      }),
    ],
    record.name,
  )

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={sensitiveStamp(record.object.singular, sensitivity)}
        actions={
          <RecordHeadActions
            record={{ id: record.id, name: record.name, kind: 'custom' }}
            log={logs}
            sensitivity={sensitivity}
          />
        }
        mark={
          <span className="flex size-7 shrink-0 items-center justify-center border border-hairline bg-paper">
            <Icon className="size-3.5 text-foreground" strokeWidth={1.75} />
          </span>
        }
        name={
          <RecordName
            name={record.name}
            onSave={async (name) => {
              await updateRecord({ data: { id: record.id, name } })
              void router.invalidate()
            }}
          />
        }
      />

      <RecordNotices recordId={record.id} duplicates={duplicates} />

      <RecordBody
        groups
        details={
          <>
            <AiCellsProvider entityIds={[record.id]} registry={registry}>
              <PropertyGrid>
                <PropertyFold
                  defs={registry}
                  valueOf={(def) => values[def.slug]}
                  render={(def) => (
                    <RailField
                      key={def.slug}
                      entityId={record.id}
                      def={def}
                      attr={def}
                      objectLabel={record.object.singular}
                      objectPlural={record.object.plural}
                      onAttributeSaved={() => router.invalidate()}
                      value={values[def.slug] ?? null}
                      refNames={record.refNames}
                      onSave={async (v) => {
                        const result = await updateRecord({
                          data: { id: record.id, patch: { [def.slug]: v } },
                        })
                        // The save succeeded either way — the value is the
                        // operator's field and always lands. What a collision
                        // withholds is the *claim*, and this is where it is said.
                        const collision = collisionToast(
                          result,
                          record.object.singular,
                        )
                        if (collision)
                          toast(collision.title, {
                            description: collision.description,
                          })
                        void router.invalidate()
                      }}
                    />
                  )}
                  create={(opener) => (
                    <AttributeDialog
                      mode="create"
                      objectId={record.object.id}
                      objectLabel={record.object.singular}
                      objectPlural={record.object.plural}
                      onSaved={() => router.invalidate()}
                      {...opener}
                    />
                  )}
                />
              </PropertyGrid>
            </AiCellsProvider>

            {/* Each relationship, either half, through the resolver. */}
            <RelationSections
              defs={registry}
              halves={record.relations}
              onAdd={async (slug, value) => {
                await updateRecord({
                  data: { id: record.id, patch: { [slug]: value } },
                })
                void router.invalidate()
              }}
            />

            {/* The records that point here outside any relationship, one
                section per referring object and attribute. */}
            {record.referencedBy.map((group) => (
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
              entityId={record.id}
              spaces={record.spaces}
              allSpaces={allSpaces}
            />

            <WaitingRail entityId={record.id} waiting={waiting} />
          </>
        }
      >
        <RecordTabs
          label={record.name}
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
            overview: (
              <RecordOverview
                record={{ id: record.id, name: record.name, kind: 'custom' }}
                readouts={[
                  {
                    label: 'Last contact',
                    value: readoutDay(
                      record.readouts.lastContact,
                      record.readouts.today,
                    ),
                  },
                  {
                    label: 'Next meeting',
                    value: readoutDay(
                      record.readouts.nextMeeting,
                      record.readouts.today,
                    ),
                  },
                  {
                    label: 'Moving, 30 days',
                    value: record.readouts.moving30,
                  },
                ]}
                timeline={timeline}
                documents={documents}
                onTab={changeTab}
                logInteraction={
                  logs
                    ? (trigger) => (
                        <LogInteractionDialog
                          seed={{
                            id: record.id,
                            name: record.name,
                            kind: 'custom',
                          }}
                          trigger={trigger}
                        />
                      )
                    : undefined
                }
              />
            ),
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
                recordId={record.id}
                refNames={record.refNames}
                composer={
                  <LogInteractionDialog
                    seed={{ id: record.id, name: record.name, kind: 'custom' }}
                    trigger={<LogComposerRow />}
                  />
                }
              />
            ),
            files: (
              <RecordFiles
                entityId={record.id}
                recordName={record.name}
                documents={documents}
              />
            ),
            history: (
              <RecordHistory
                items={timeline}
                registry={registry}
                refNames={record.refNames}
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

function RecordName({
  name,
  onSave,
}: {
  name: string
  onSave: (name: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(name)
  return (
    <input
      value={draft}
      aria-label="Record name"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim()
        if (!next) return setDraft(name)
        if (next !== name)
          onSave(next).catch((err: unknown) => {
            setDraft(name)
            toast.error(err instanceof Error ? err.message : 'Could not rename')
          })
      }}
      onKeyDown={(e) => {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- React types a key event's target as EventTarget; the handler is on the input itself
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="focus-ring block w-full truncate bg-transparent title-serif"
    />
  )
}
