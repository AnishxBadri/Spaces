import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { AtSign, Linkedin, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { RailField } from '#/components/attributes/rail-field'
import { KeyHint } from '#/components/page-header'
import {
  DitherMark,
  InitialsMark,
  PropertyCell,
  PropertyGrid,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  RecordSection,
} from '#/components/record/record-parts'
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

  const jobTitle =
    typeof person.values.job_title === 'string' ? person.values.job_title : null
  const location =
    typeof person.values.location === 'string' ? person.values.location : null

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        crumb={
          <>
            <Link to="/people" className="focus-ring hover:text-foreground">
              People
            </Link>
            {' / '}
            {person.id.slice(0, 8)}
            {person.emails[0] ? ` / ${person.emails[0].valueNorm}` : ''}
          </>
        }
        actions={
          <>
            <LogInteractionDialog
              seed={{ id: person.id, name: person.name, kind: 'person' }}
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
          </>
        }
        mark={<InitialsMark name={person.name} size="lg" />}
        name={person.name}
        readouts={[
          {
            label: 'Title',
            value: jobTitle ?? '—',
            kind: 'text',
            tone: jobTitle ? undefined : 'muted',
          },
          {
            label: 'Companies',
            value:
              person.companies.length > 0 ? (
                <Link
                  to="/companies/$companyId"
                  params={{ companyId: person.companies[0].id }}
                  className="focus-ring hover:underline"
                >
                  {person.companies[0].name}
                  {person.companies.length > 1
                    ? ` +${person.companies.length - 1}`
                    : ''}
                </Link>
              ) : (
                '—'
              ),
            kind: 'text',
            tone: person.companies.length > 0 ? undefined : 'muted',
          },
          {
            label: 'Location',
            value: location ?? '—',
            kind: 'text',
            tone: location ? undefined : 'muted',
          },
          { label: 'Emails', value: `${person.emails.length}` },
          { label: 'Mentions', value: `${person.mentionedIn.length}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <RailSection label="Companies" meta={`${person.companies.length}`}>
              {person.companies.map((c) => (
                <RailItem key={c.id} className="group">
                  <DitherMark size={22} />
                  <Link
                    to="/companies/$companyId"
                    params={{ companyId: c.id }}
                    className="focus-ring min-w-0 flex-1 truncate hover:underline"
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
                    className="focus-ring hidden size-5 items-center justify-center text-graphite group-hover:flex hover:text-foreground focus-visible:flex"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </RailItem>
              ))}
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
                  className="focus-ring mt-1 h-7 w-full border border-rule bg-paper px-2 text-label text-graphite"
                >
                  <option value="">+ Link to company…</option>
                  {unlinkedCompanies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </RailSection>

            <RailSection
              label="Mentioned in"
              meta={`${person.mentionedIn.length}`}
            >
              {person.mentionedIn.length === 0 ? (
                <RailEmpty>Nowhere yet.</RailEmpty>
              ) : (
                person.mentionedIn.map((m) => (
                  <RailItem key={m.fromId}>
                    {m.kind === 'note' ? (
                      <Link
                        to="/notes/$noteId"
                        params={{ noteId: m.fromId }}
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
                ))
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
              objectLabel={'person'}
              onAttributeSaved={() => router.invalidate()}
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
          <PropertyCell label="">
            <AttributeCreateDialog
              objectKind="person"
              onCreated={() => router.invalidate()}
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
              No notes mention {person.name} yet.
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
                    <span className="font-serif text-[0.9375rem] font-medium">
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
          <LogInteractionDialog
            seed={{ id: person.id, name: person.name, kind: 'person' }}
            trigger={
              <button className="focus-ring-inset flex h-row w-full items-center gap-3 border-t border-b border-rule text-left">
                <span className="mono text-micro text-primary">+</span>
                <span className="min-w-0 truncate text-ui text-graphite">
                  Log a call, meeting, or note…
                </span>
                <span className="flex-1" />
                <KeyHint>L</KeyHint>
              </button>
            }
          />
          <RecordTimeline items={timeline} registry={registry} />
        </RecordSection>

        <RecordSection
          rule
          label="Files"
          meta={`${documents.length} file${documents.length === 1 ? '' : 's'}`}
        >
          <RecordFiles entityId={person.id} documents={documents} />
        </RecordSection>
      </RecordBody>
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
    <PropertyCell label={label}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {values.map((v) => (
          <span
            key={v}
            className="flex min-w-0 items-center gap-1 mono text-label"
          >
            <Icon
              className="size-3 shrink-0 text-graphite"
              strokeWidth={1.75}
            />
            <span className="truncate">{v}</span>
          </span>
        ))}
        {adding ? (
          <Input
            autoFocus
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="h-6 w-44 mono text-label"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            + add
          </button>
        )}
      </div>
    </PropertyCell>
  )
}
