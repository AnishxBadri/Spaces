import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  ArrowLeft,
  AtSign,
  Building2,
  FileText,
  Linkedin,
  MessageSquare,
  Plus,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { RailField } from '#/components/attributes/rail-field'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { RecordFiles } from '#/components/record-files'
import { RecordTimeline } from '#/components/record-timeline'
import {
  addPersonContact,
  createNote,
  getPerson,
  getRecordTimeline,
  listCompanies,
  listRecordDocuments,
  listRegistry,
  setPersonCompany,
  updateRecord,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/people_/$personId')({
  loader: async ({ params }) => {
    const [personData, companies, registry, timeline, documents] =
      await Promise.all([
        getPerson({ data: { id: params.personId } }),
        listCompanies(),
        listRegistry({ data: { kind: 'person' } }),
        getRecordTimeline({ data: { entityId: params.personId } }),
        listRecordDocuments({ data: { entityId: params.personId } }),
      ])
    if (personData.mergedIntoId) {
      throw redirect({
        to: '/people/$personId',
        params: { personId: personData.mergedIntoId },
      })
    }
    return {
      person: personData,
      allCompanies: companies,
      registry,
      timeline,
      documents,
    }
  },
  component: PersonRecordPage,
})

function PersonRecordPage() {
  const { person, allCompanies, registry, timeline, documents } =
    Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'activity' | 'notes' | 'files'>('activity')

  const noteMentions = person.mentionedIn.filter((m) => m.kind === 'note')
  const unlinkedCompanies = allCompanies.filter(
    (c) => !person.companies.some((pc) => pc.id === c.id),
  )

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

  return (
    <div className="px-6 py-8 md:px-10">
      <Link
        to="/people"
        className="flex w-fit items-center gap-1.5 rounded-md text-ui text-muted-foreground focus-ring hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        People
      </Link>

      <header className="mt-5 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-title font-semibold text-muted-foreground">
          {person.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-page font-semibold tracking-tight">
            {person.name}
          </h1>
          {person.values.job_title ? (
            <p className="truncate text-ui text-muted-foreground">
              {String(person.values.job_title)}
            </p>
          ) : null}
        </div>
        {/* Header actions — the record's verbs live top-right, same as the
            deal and company pages. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LogInteractionDialog
            seed={{ id: person.id, name: person.name, kind: 'person' }}
            trigger={
              <Button size="sm" variant="outline">
                <MessageSquare className="size-3.5" strokeWidth={1.75} />
                Log interaction
              </Button>
            }
          />
          <Button size="sm" variant="outline" onClick={newNoteAboutThis}>
            <Plus className="size-3.5" strokeWidth={2} />
            Note about this
          </Button>
        </div>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        {/* Left: details */}
        <aside className="space-y-5">
          {registry.map((def) => (
            <RailField
              key={def.slug}
              def={def as RegistryEntry}
              value={person.values[def.slug] ?? null}
              onSave={async (v) => {
                await updateRecord({
                  data: { id: person.id, patch: { [def.slug]: v } },
                })
                void router.invalidate()
              }}
            />
          ))}

          <ContactField
            personId={person.id}
            label="Emails"
            kind="email"
            icon={AtSign}
            values={person.emails.map((e) => e.valueNorm)}
            placeholder="name@company.com"
          />
          <ContactField
            personId={person.id}
            label="LinkedIn"
            kind="linkedin"
            icon={Linkedin}
            values={person.linkedins.map((l) => l.valueNorm)}
            placeholder="linkedin.com/in/…"
          />

          <AttributeCreateDialog
            objectKind="person"
            onCreated={() => router.invalidate()}
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
            <>
              <LogInteractionDialog
                seed={{ id: person.id, name: person.name, kind: 'person' }}
                trigger={
                  <button className="mt-4 flex h-9 w-full items-center gap-2 rounded-md border border-input px-3 text-left text-ui text-muted-foreground focus-ring transition-colors duration-150 ease-out-quart hover:border-border hover:bg-accent">
                    <MessageSquare
                      className="size-3.5 shrink-0"
                      strokeWidth={1.75}
                    />
                    Log a call, meeting, or note…
                  </button>
                }
              />
              <RecordTimeline
                items={timeline}
                registry={registry as Array<RegistryEntry>}
              />
            </>
          ) : tab === 'files' ? (
            <RecordFiles entityId={person.id} documents={documents} />
          ) : (
            <ul className="mt-4 space-y-1">
              {noteMentions.length === 0 ? (
                <p className="text-ui text-muted-foreground">
                  No notes mention {person.name} yet.
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

        {/* Right: companies */}
        <aside className="space-y-6">
          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Companies
            </h2>
            <ul className="mt-2 space-y-1">
              {person.companies.map((c) => (
                <li
                  key={c.id}
                  className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-ui hover:bg-accent"
                >
                  <Building2
                    className="size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <Link
                    to="/companies/$companyId"
                    params={{ companyId: c.id }}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {c.name}
                  </Link>
                  <button
                    aria-label={`Unlink from ${c.name}`}
                    onClick={async () => {
                      await setPersonCompany({
                        data: {
                          personId: person.id,
                          companyId: c.id,
                          action: 'unlink',
                        },
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
            {unlinkedCompanies.length > 0 ? (
              <select
                aria-label="Link to company"
                value=""
                onChange={async (e) => {
                  if (!e.target.value) return
                  await setPersonCompany({
                    data: {
                      personId: person.id,
                      companyId: e.target.value,
                      action: 'link',
                    },
                  })
                  void router.invalidate()
                }}
                className="mt-2 h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground focus-ring"
              >
                <option value="">+ Link to company…</option>
                {unlinkedCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Mentioned in
            </h2>
            {person.mentionedIn.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Nowhere yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {person.mentionedIn.map((m) => (
                  <li key={m.fromId} className="truncate text-ui">
                    {m.kind === 'note' ? (
                      <Link
                        to="/notes/$noteId"
                        params={{ noteId: m.fromId }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{m.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function ContactField({
  personId,
  label,
  kind,
  icon: Icon,
  values,
  placeholder,
}: {
  personId: string
  label: string
  kind: 'email' | 'linkedin'
  icon: typeof AtSign
  values: Array<string>
  placeholder: string
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  async function add() {
    const value = draft.trim()
    if (!value) return setAdding(false)
    try {
      const result = await addPersonContact({
        data: { id: personId, kind, value },
      })
      if (result.outcome === 'suggested_duplicate') {
        toast(`Another person already owns that ${kind}`, {
          description:
            'Flagged as a possible duplicate — review it in the dedupe inbox.',
        })
      }
      setDraft('')
      setAdding(false)
      void router.invalidate()
    } catch {
      toast.error(`Not a valid ${kind}`)
    }
  }

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <ul className="space-y-1">
        {values.map((v) => (
          <li key={v} className="flex h-7 items-center gap-2 text-ui">
            <Icon
              className="size-3.5 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
            <span className="truncate">{v}</span>
          </li>
        ))}
      </ul>
      {adding ? (
        <Input
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          className="h-7 text-xs"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-md text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          <Plus className="size-3" strokeWidth={2} />
          Add
        </button>
      )}
    </div>
  )
}
