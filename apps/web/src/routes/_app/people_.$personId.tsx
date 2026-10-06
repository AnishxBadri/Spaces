import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { AtSign, Layers, Linkedin, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { AttributeCreateDialog } from '#/components/attributes/attribute-create-dialog'
import { RailField } from '#/components/attributes/rail-field'
import { AiCellsProvider } from '#/components/attributes/ai-cell'
import { KeyHint } from '#/components/page-header'
import {
  InitialsMark,
  PropertyCell,
  PropertyGrid,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
  RecordSection,
} from '#/components/record/record-parts'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { SummarizeRecordButton } from '#/components/summarize'
import { RecordNotes } from '#/components/record/record-notes'
import { RecordFiles } from '#/components/record-files'
import { RecordContext } from '#/components/record-context'
import { RecordLedger } from '#/components/record-timeline'
import { WaitingRail } from '#/components/record/waiting-rail'
import { SuggestSpacesAction } from '#/components/record/suggest-spaces'
import { PluginActions } from '#/components/record/plugin-actions'
import { recordPath } from '#/lib/record-path'
import {
  addPersonContact,
  countOpenSuggestions,
  createNote,
  getEntitySensitivity,
  getPerson,
  getRecordTimeline,
  listRecordActions,
  listRecordDocuments,
  listRecordNotes,
  listRegistry,
  listSpaces,
  tagIntoSpace,
  untagFromSpace,
  updateRecord,
} from '#/lib/server-fns'

export const Route = createFileRoute('/_app/people_/$personId')({
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
    ] = await Promise.all([
      getPerson({ data: { id: params.personId } }),
      listSpaces(),
      listRegistry({ data: { kind: 'person' } }),
      getRecordTimeline({ data: { entityId: params.personId } }),
      listRecordDocuments({ data: { entityId: params.personId } }),
      listRecordNotes({ data: { entityId: params.personId } }),
      countOpenSuggestions({ data: { entityId: params.personId } }),
      getEntitySensitivity({ data: { entityId: params.personId } }),
      listRecordActions({ data: { kind: 'person' } }),
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
    }
  },
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
  } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()

  const untaggedSpaces = allSpaces.filter(
    (s) => !person.spaces.some((ps) => ps.id === s.id),
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
            <SensitiveToggle entityId={person.id} state={sensitivity} />
            <SummarizeRecordButton recordId={person.id} />
            <PluginActions entityId={person.id} actions={pluginActions} />
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
            label: 'Location',
            value: location ?? '—',
            kind: 'text',
            tone: location ? undefined : 'muted',
          },
          { label: 'Emails', value: `${person.emails.length}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <WaitingRail entityId={person.id} counts={waiting} />
            {/* Spaces (SPA-99). The same rail the company and custom-record
                pages carry, on the same two server fns — and the writer the
                space page's Contacts section had been missing: `entity_space`
                always took a person, but nothing in the UI could write one,
                so the direct lane could never fill. */}
            <RailSection label="Spaces" meta={`${person.spaces.length}`}>
              {person.spaces.map((s) => (
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
                        data: { entityId: person.id, spaceId: s.id },
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
                      data: { entityId: person.id, spaceId },
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
              <SuggestSpacesAction entityId={person.id} />
            </RailSection>
          </>
        }
      >
        <AiCellsProvider entityIds={[person.id]} registry={registry}>
          <PropertyGrid>
            {registry.map((def) => (
              <RailField
                key={def.slug}
                entityId={person.id}
                def={def}
                attr={def}
                objectLabel={'person'}
                onAttributeSaved={() => router.invalidate()}
                value={person.values[def.slug] ?? null}
                refNames={person.refNames}
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
        </AiCellsProvider>

        <RecordNotes
          filed={notes.filed}
          mentions={notes.mentions}
          onNewNote={newNoteAboutThis}
        />

        {/* Inbound record-references, one section per attribute — the
            heading and the grouping are both data (`attr_slug` and the
            attribute's display name), so a second attribute pointing at
            people lands here with no edit. No inbound refs, no heading. */}
        {person.referencedBy.map((group) => (
          <RecordSection
            key={`${group.label}:${group.attrSlug}`}
            label={group.label}
            meta={`via ${group.via} · ${group.items.length}`}
          >
            <ol>
              {group.items.map((item) => {
                const href = recordPath({
                  kind: item.kind,
                  id: item.id,
                  objectSlug: item.objectSlug,
                })
                const body = (
                  <>
                    <span className="font-serif text-title font-medium">
                      {item.name}
                    </span>
                    <span className="flex-1" />
                    <span className="mono text-micro text-graphite">
                      {item.objectSingular ?? item.kind}
                    </span>
                  </>
                )
                return (
                  <li key={item.id} className="border-b border-rule">
                    {href ? (
                      <Link
                        to={href}
                        className="focus-ring-inset flex h-ledger-row items-center gap-3 px-3 text-ui hover:bg-bone"
                      >
                        {body}
                      </Link>
                    ) : (
                      <span className="flex h-ledger-row items-center gap-3 px-3 text-ui text-graphite">
                        {body}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </RecordSection>
        ))}

        <RecordLedger
          items={timeline}
          registry={registry}

          composer={
            <LogInteractionDialog
              seed={{ id: person.id, name: person.name, kind: 'person' }}
              trigger={
                <button className="focus-ring-inset flex h-ledger-row w-full items-center gap-3 border-b border-rule px-3 text-left">
                  <span className="mono text-micro text-primary">+</span>
                  <span className="min-w-0 truncate text-ui text-graphite">
                    Log a call, meeting, or note…
                  </span>
                  <span className="flex-1" />
                  <KeyHint>L</KeyHint>
                </button>
              }
            />
          }
        />

        <RecordFiles entityId={person.id} documents={documents} />

        <RecordContext entityId={person.id} />
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
            'Flagged as a possible duplicate — the pair is waiting in Review.',
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
