import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, FileText, Layers, Link2, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import { RailField } from '#/components/attributes/rail-field'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import { Button } from '#/components/ui/button'
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
import { cn } from '#/lib/utils'
import { formatDate } from '#/lib/format'

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
  const [tab, setTab] = useState<'activity' | 'notes' | 'files'>('activity')
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
    <div className="px-6 py-8 md:px-10">
      <Link
        to="/o/$objectSlug"
        params={{ objectSlug: record.object.slug }}
        className="flex w-fit items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        {record.object.plural}
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4.5 text-muted-foreground" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <RecordName
            name={record.name}
            onSave={async (name) => {
              await updateRecord({ data: { id: record.id, name } })
              void router.invalidate()
            }}
          />
          <p className="truncate text-xs text-muted-foreground">
            {record.object.singular} · added {formatDate(record.createdAt)}
            {record.createdByName ? ` by ${record.createdByName}` : ''}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={newNoteAboutThis}>
            <Plus className="size-3.5" strokeWidth={2} />
            Note about this
          </Button>
        </div>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        {/* Left: registry-generated rail */}
        <aside className="space-y-4">
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def as RegistryEntry}
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
          <AttributeDialog
            mode="create"
            objectId={record.object.id}
            objectLabel={record.object.singular}
            onSaved={() => router.invalidate()}
            trigger={
              <button className="flex items-center gap-1 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground">
                <Plus className="size-3" strokeWidth={2} />
                Add attribute
              </button>
            }
          />
        </aside>

        {/* Center: tabs */}
        <section className="min-w-0">
          <div className="flex items-center justify-between border-b border-border">
            <div role="tablist" className="flex gap-1">
              {(['activity', 'notes', 'files'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'relative rounded-t-md px-3 pb-2.5 text-ui font-medium text-muted-foreground capitalize focus-ring transition-colors hover:text-foreground',
                    tab === t &&
                      'text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {tab === 'activity' ? (
            <RecordTimeline
              items={timeline}
              registry={registry as Array<RegistryEntry>}
            />
          ) : tab === 'files' ? (
            <RecordFiles entityId={record.id} documents={documents} />
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-ui text-muted-foreground">
                  No notes mention {record.name} yet. Write one — it links
                  itself here.
                </p>
              ) : (
                noteMentions.map((m) => (
                  <li key={m.fromId}>
                    <Link
                      to="/notes/$noteId"
                      params={{ noteId: m.fromId }}
                      className="flex h-9 items-center gap-2.5 rounded-md px-2 text-ui focus-ring hover:bg-accent"
                    >
                      <FileText
                        className="size-4 text-muted-foreground"
                        strokeWidth={1.75}
                      />
                      <span className="font-medium">{m.name}</span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          )}
        </section>

        {/* Right: related */}
        <aside className="space-y-6">
          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Spaces
            </h2>
            <ul className="mt-2 space-y-1">
              {record.spaces.map((s) => (
                <li
                  key={s.id}
                  className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-ui hover:bg-accent"
                >
                  <Layers
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <Link
                    to="/spaces/$spaceId"
                    params={{ spaceId: s.id }}
                    className="min-w-0 flex-1 truncate focus-ring"
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
                    className="hidden size-5 items-center justify-center rounded text-muted-foreground focus-ring group-hover:flex hover:text-foreground focus-visible:flex"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
            {untaggedSpaces.length > 0 ? (
              <select
                aria-label="Tag into space"
                value=""
                onChange={async (e) => {
                  if (!e.target.value) return
                  await tagIntoSpace({
                    data: { entityId: record.id, spaceId: e.target.value },
                  })
                  void router.invalidate()
                }}
                className="mt-2 h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground focus-ring"
              >
                <option value="">+ Tag into space…</option>
                {untaggedSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {' '.repeat(s.depth * 2)}
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Referenced by
            </h2>
            {record.referencedBy.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No record points here yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {record.referencedBy.map((r) => {
                  const href = recordPath({
                    kind: r.kind,
                    id: r.fromId,
                    objectSlug: r.objectSlug,
                  })
                  const body = (
                    <>
                      <Link2
                        className="size-3.5 shrink-0 text-muted-foreground"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.objectSingular ?? r.kind}
                      </span>
                    </>
                  )
                  return (
                    <li key={`${r.fromId}:${r.attrSlug}`}>
                      {href ? (
                        <Link
                          to={href}
                          className="flex h-7 items-center gap-2 rounded-md px-1.5 text-ui focus-ring hover:bg-accent"
                        >
                          {body}
                        </Link>
                      ) : (
                        <span className="flex h-7 items-center gap-2 px-1.5 text-ui">
                          {body}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Mentioned in
            </h2>
            {record.mentionedIn.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Nowhere yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {record.mentionedIn.map((m) => {
                  const href = recordPath({
                    kind: m.kind,
                    id: m.fromId,
                    objectSlug: m.objectSlug,
                  })
                  return (
                    <li key={m.fromId} className="truncate text-ui">
                      {href ? (
                        <Link
                          to={href}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {m.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{m.name}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

/** The display name, editable in place — it is canonical_name, core-owned. */
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
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(name)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="block w-full truncate rounded bg-transparent text-page font-semibold tracking-tight focus-ring"
    />
  )
}
