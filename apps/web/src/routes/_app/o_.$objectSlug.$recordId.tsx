import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Link2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { SpaceRailRow } from '#/components/record/space-rail-row'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import {
  PropertyCell,
  PropertyGrid,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
} from '#/components/record/record-parts'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordContext } from '#/components/record-context'
import { RecordLedger } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { SuggestSpacesAction } from '#/components/record/suggest-spaces'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { SummarizeRecordButton } from '#/components/summarize'
import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { collisionToast } from '#/lib/attributes/collision-toast'
import { objectIcon } from '#/lib/object-icons'
import { recordPath } from '#/lib/record-path'
import { DASH, readoutDayAgo } from '#/lib/records/readout-format'
import { fileInSpaceAction } from '#/lib/file-in-space'
import { usePageActions } from '#/lib/page-actions'
import {
  countOpenSuggestions,
  createNote,
  getObjectRecord,
  getRecordTimeline,
  listRecordDocuments,
  getEntitySensitivity,
  listRecordNotes,
  listRegistry,
  listSpaces,
  tagIntoSpace,
  untagFromSpace,
  updateRecord,
} from '#/lib/server-fns'

/**
 * The registry-generated record page for a custom object (spec §9). Same
 * shape as a company page minus the core-only machinery: rail from the
 * registry, activity/notes/files, spaces, backlinks both ways. No
 * interactions and no enrichment — by design, not by omission. Merge does
 * reach here (narrowed 2026-09-13): a record merged away redirects to its
 * winner from the loader below.
 */
export const Route = createFileRoute('/_app/o_/$objectSlug/$recordId')({
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
    const [registry, timeline, documents, spaces, notes, waiting, sensitivity] =
      await Promise.all([
        listRegistry({ data: { objectId: record.object.id } }),
        getRecordTimeline({ data: { entityId: record.id } }),
        listRecordDocuments({ data: { entityId: record.id } }),
        listSpaces(),
        // A custom record is an entity like any other, so the lanes need only
        // its id — the object slug is the page's, never the note row's.
        listRecordNotes({ data: { entityId: record.id } }),
        countOpenSuggestions({ data: { entityId: record.id } }),
        getEntitySensitivity({ data: { entityId: record.id } }),
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
    }
  },
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
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const Icon = objectIcon(record.object)
  const untaggedSpaces = allSpaces.filter(
    (s) => !record.spaces.some((rs) => rs.id === s.id),
  )

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

  usePageActions([
    {
      id: 'note',
      label: 'Note about this',
      run: () => void newNoteAboutThis(),
    },
    fileInSpaceAction({
      id: record.id,
      name: record.name,
      filedIds: record.spaces.map((s) => s.id),
    }),
  ])

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={{ kind: record.object.singular, fact: record.id.slice(0, 8) }}
        crumb={
          <>
            <Link
              to="/o/$objectSlug"
              params={{ objectSlug: record.object.slug }}
              className="focus-ring hover:text-foreground"
            >
              {record.object.plural}
            </Link>
            {' / '}
            {record.id.slice(0, 8)}
            {' / added '}
            {record.createdAt.slice(0, 10)}
            {record.createdByName ? ` · ${record.createdByName}` : ''}
          </>
        }
        actions={
          <>
            <SensitiveToggle entityId={record.id} state={sensitivity} />
            <SummarizeRecordButton recordId={record.id} />
            <Button variant="outline" onClick={newNoteAboutThis}>
              Note about this
            </Button>
          </>
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
        readouts={[
          {
            label: 'Last contact',
            value: readoutDayAgo(
              record.readouts.lastContact,
              record.readouts.today,
            ),
          },
          // A dash until calendar sync.
          { label: 'Next meeting', value: DASH },
          {
            label: 'Moving, 30 days',
            value: `${record.readouts.moving30}`,
            tone: record.readouts.moving30 === 0 ? 'muted' : undefined,
          },
        ]}
      />

      <RecordBody
        rail={
          <>
            <WaitingRail entityId={record.id} counts={waiting} />
            <RailSection label="Spaces" meta={`${record.spaces.length}`}>
              {record.spaces.map((s) => (
                <SpaceRailRow
                  key={s.id}
                  space={s}
                  onRemove={async () => {
                    await untagFromSpace({
                      data: { entityId: record.id, spaceId: s.id },
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
                      data: { entityId: record.id, spaceId },
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
              <SuggestSpacesAction entityId={record.id} />
            </RailSection>

            <RailSection
              label="Referenced by"
              meta={`${record.referencedBy.length}`}
            >
              {record.referencedBy.length === 0 ? (
                <RailEmpty>No record points here yet.</RailEmpty>
              ) : (
                record.referencedBy.map((r) => {
                  const href = recordPath({
                    kind: r.kind,
                    id: r.fromId,
                    objectSlug: r.objectSlug,
                  })
                  const body = (
                    <>
                      <Link2
                        className="size-3.5 shrink-0 text-graphite"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="mono text-micro text-graphite">
                        {r.objectSingular ?? r.kind}
                      </span>
                    </>
                  )
                  return (
                    <RailItem key={`${r.fromId}:${r.attrSlug}`}>
                      {href ? (
                        <Link
                          to={href}
                          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 hover:underline"
                        >
                          {body}
                        </Link>
                      ) : (
                        <span className="flex min-w-0 flex-1 items-center gap-2.5">
                          {body}
                        </span>
                      )}
                    </RailItem>
                  )
                })
              )}
            </RailSection>
          </>
        }
      >
        <AiCellsProvider entityIds={[record.id]} registry={registry}>
          <PropertyGrid>
            {registry.map((def) => (
              <RailField
                key={def.slug}
                entityId={record.id}
                def={def}
                attr={def}
                objectLabel={record.object.singular}
                onAttributeSaved={() => router.invalidate()}
                value={record.values[def.slug] ?? null}
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
            ))}
            <PropertyCell label="">
              <AttributeDialog
                mode="create"
                objectId={record.object.id}
                objectLabel={record.object.singular}
                onSaved={() => router.invalidate()}
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

        <RecordLedger items={timeline} registry={registry} />

        <RecordFiles entityId={record.id} documents={documents} />

        <RecordContext entityId={record.id} />
      </RecordBody>
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
