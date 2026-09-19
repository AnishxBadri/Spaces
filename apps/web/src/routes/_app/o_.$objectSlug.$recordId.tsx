import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Layers, Link2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { RailField } from '#/components/attributes/rail-field'
import {
  PropertyCell,
  PropertyGrid,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  RecordSection,
} from '#/components/record/record-parts'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { Button } from '#/components/ui/button'
import { Select } from '#/components/ui/select'
import { objectIcon } from '#/lib/object-icons'
import { recordPath } from '#/lib/record-path'
import {
  createNote,
  getObjectRecord,
  getRecordTimeline,
  listRecordDocuments,
  listRegistry,
  listSpaces,
  tagIntoSpace,
  untagFromSpace,
  updateRecord,
} from '#/lib/server-fns'

/**
 * The registry-generated record page for a custom object (spec §9). Same
 * shape as a company page minus the identity machinery: rail from the
 * registry, activity/notes/files, spaces, backlinks both ways. No
 * interactions, no aliases, no merge — by design, not by omission.
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
    const [registry, timeline, documents, spaces] = await Promise.all([
      listRegistry({ data: { objectId: record.object.id } }),
      getRecordTimeline({ data: { entityId: record.id } }),
      listRecordDocuments({ data: { entityId: record.id } }),
      listSpaces(),
    ])
    return { record, registry, timeline, documents, allSpaces: spaces }
  },
  component: ObjectRecordPage,
})

function ObjectRecordPage() {
  const { record, registry, timeline, documents, allSpaces } =
    Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const Icon = objectIcon(record.object)
  const noteMentions = record.mentionedIn.filter((m) => m.kind === 'note')
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

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
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
          <Button variant="outline" onClick={newNoteAboutThis}>
            Note about this
          </Button>
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
          { label: 'Object', value: record.object.singular, kind: 'text' },
          { label: 'Spaces', value: `${record.spaces.length}` },
          { label: 'Referenced by', value: `${record.referencedBy.length}` },
          { label: 'Mentions', value: `${record.mentionedIn.length}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <RailSection label="Spaces" meta={`${record.spaces.length}`}>
              {record.spaces.map((s) => (
                <RailItem key={s.id} className="group">
                  <Layers
                    className="size-3.5 shrink-0 text-graphite"
                    strokeWidth={1.75}
                  />
                  <Link
                    to="/spaces/$spaceId"
                    params={{ spaceId: s.id }}
                    className="focus-ring min-w-0 flex-1 truncate hover:underline"
                  >
                    {s.name}
                  </Link>
                  <button
                    aria-label={`Remove from ${s.name}`}
                    onClick={async () => {
                      await untagFromSpace({
                        data: { entityId: record.id, spaceId: s.id },
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

            <RailSection
              label="Mentioned in"
              meta={`${record.mentionedIn.length}`}
            >
              {record.mentionedIn.length === 0 ? (
                <RailEmpty>Nowhere yet.</RailEmpty>
              ) : (
                record.mentionedIn.map((m) => {
                  const href = recordPath({
                    kind: m.kind,
                    id: m.fromId,
                    objectSlug: m.objectSlug,
                  })
                  return (
                    <RailItem key={m.fromId}>
                      {href ? (
                        <Link
                          to={href}
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
                  )
                })
              )}
            </RailSection>
          </>
        }
      >
        <PropertyGrid>
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def}
              attr={def}
              objectLabel={record.object.singular}
              onAttributeSaved={() => router.invalidate()}
              value={record.values[def.slug] ?? null}
              refNames={record.refNames}
              onSave={async (v) => {
                await updateRecord({
                  data: { id: record.id, patch: { [def.slug]: v } },
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
              No notes mention {record.name} yet. Write one — it links itself
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
          <RecordTimeline items={timeline} registry={registry} />
        </RecordSection>

        <RecordSection
          rule
          label="Files"
          meta={`${documents.length} file${documents.length === 1 ? '' : 's'}`}
        >
          <RecordFiles entityId={record.id} documents={documents} />
        </RecordSection>
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
