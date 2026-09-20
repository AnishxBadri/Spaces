import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Boxes, FileText, Layers, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import { KeyHint } from '#/components/page-header'
import {
  DitherMark,
  RailEmpty,
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
} from '#/components/record/record-parts'
import { SpaceGlossary } from '#/components/space-glossary'
import { TagCompanyRow } from '#/components/space-tag-row'
import { TasksRail } from '#/components/tasks-rail'
import { SaveAsTemplateAction } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  createNote,
  createSpace,
  getSpace,
  listTerms,
  saveSpaceAsTemplate,
  tagIntoSpace,
  untagFromSpace,
} from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * A space is a record like any other (P7): the head measures it, the body
 * is what you think (filed notes) and what you track (companies, records)
 * with the vocabulary underneath, the rail is the map around it — parent,
 * subspaces, the notes that mention it, open tasks. Reading runs left;
 * moving runs right.
 */
export const Route = createFileRoute('/_app/spaces_/$spaceId')({
  loader: async ({ params }) => {
    const [spc, terms] = await Promise.all([
      getSpace({ data: { id: params.spaceId } }),
      listTerms({ data: { spaceId: params.spaceId } }),
    ])
    return { spc, terms }
  },
  component: SpacePage,
})

type Space = Awaited<ReturnType<typeof getSpace>>
type Company = Space['companies'][number]

/** The row's exit: long enough to read, short enough to ignore. */
const EXIT_MS = 150

function SpacePage() {
  const { spc, terms } = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  // Companies mid-untag: faded until the write lands and the row unmounts.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())

  async function newNote(kind?: 'memo') {
    try {
      const { id } = await createNote({
        data: {
          about: { entityId: spc.id, label: spc.name, kind: 'space' },
          ...(kind ? { noteKind: kind } : {}),
        },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }
  useHotkey('n', () => void newNote())

  async function retag(c: Company) {
    try {
      await tagIntoSpace({ data: { entityId: c.id, spaceId: spc.id } })
      void router.invalidate()
    } catch {
      toast.error(`Could not re-tag ${c.name}`)
    }
  }

  async function writeUntag(c: Company) {
    try {
      await untagFromSpace({ data: { entityId: c.id, spaceId: spc.id } })
      void router.invalidate()
      toast(`${c.name} untagged from ${spc.name}`, {
        action: { label: 'Undo', onClick: () => void retag(c) },
      })
    } catch {
      toast.error(`Could not untag ${c.name}`)
    } finally {
      setLeaving((s) => {
        const next = new Set(s)
        next.delete(c.id)
        return next
      })
    }
  }

  /** Untagging reads as the row leaving, not the list flinching. */
  function untag(c: Company) {
    setLeaving((s) => new Set(s).add(c.id))
    window.setTimeout(() => void writeUntag(c), EXIT_MS)
  }

  const inPipeline = spc.companies.filter((c) => c.deals > 0).length
  const ownTerms = terms.filter((t) => t.spaceId === spc.id).length
  const taggedIds = new Set(spc.companies.map((c) => c.id))
  const zero = (n: number) => (n === 0 ? ('muted' as const) : undefined)

  const rowLink =
    'focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone'

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        crumb={
          <nav aria-label="Breadcrumb" className="flex items-center gap-2">
            <Link
              to="/spaces"
              className="focus-ring shrink-0 transition-colors hover:text-foreground"
            >
              Spaces
            </Link>
            {spc.ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-2">
                <span className="text-rule">/</span>
                <Link
                  to="/spaces/$spaceId"
                  params={{ spaceId: a.id }}
                  className="focus-ring truncate transition-colors hover:text-foreground"
                >
                  {a.name}
                </Link>
              </span>
            ))}
            <span className="text-rule">/</span>
            <span className="truncate font-medium text-foreground">
              {spc.name}
            </span>
            {spc.isSeeded ? (
              <>
                <span className="text-rule max-md:hidden">·</span>
                <span className="shrink-0 max-md:hidden">seeded</span>
              </>
            ) : null}
          </nav>
        }
        actions={
          <>
            <SaveAsTemplateAction
              entityLabel="space"
              defaultName={`${spc.name} breakdown`}
              onSave={async (name) => {
                await saveSpaceAsTemplate({ data: { spaceId: spc.id, name } })
              }}
              trigger={<Button variant="outline">Save as template</Button>}
            />
            <Button variant="outline" onClick={() => void newNote()}>
              Note here
              <KeyHint>N</KeyHint>
            </Button>
          </>
        }
        mark={
          /* The space mark: a paper tile on a hairline, never a circle. */
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center border border-hairline bg-paper"
          >
            <Layers className="size-3.5" strokeWidth={1.75} />
          </span>
        }
        name={spc.name}
        readouts={[
          {
            label: 'Subspaces',
            value: `${spc.children.length}`,
            tone: zero(spc.children.length),
          },
          {
            label: 'Companies',
            value: `${spc.companies.length}`,
            tone: zero(spc.companies.length),
          },
          {
            label: 'In pipeline',
            value: `${inPipeline}`,
            tone: zero(inPipeline),
          },
          {
            label: 'Filed notes',
            value: `${spc.filed.length}`,
            tone: zero(spc.filed.length),
          },
          {
            label: 'Terms',
            value:
              terms.length === ownTerms
                ? `${ownTerms}`
                : `${ownTerms} +${terms.length - ownTerms}`,
            tone: zero(terms.length),
          },
          {
            label: 'Referenced',
            value: `${spc.notes.length}`,
            tone: zero(spc.notes.length),
          },
        ]}
      />

      <RecordBody
        rail={
          <>
            <RailSection label="Map" meta={`${spc.children.length} sub`}>
              {spc.parent ? (
                <RailItem>
                  <span
                    aria-hidden
                    className="w-3.5 shrink-0 text-center mono text-label text-graphite"
                  >
                    ↑
                  </span>
                  <Link
                    to="/spaces/$spaceId"
                    params={{ spaceId: spc.parent.id }}
                    className="focus-ring min-w-0 flex-1 truncate text-graphite hover:text-foreground hover:underline"
                  >
                    {spc.parent.name}
                  </Link>
                </RailItem>
              ) : null}
              {spc.children.map((c) => (
                <RailItem key={c.id}>
                  <Layers
                    className="size-3.5 shrink-0 text-graphite"
                    strokeWidth={1.75}
                  />
                  <Link
                    to="/spaces/$spaceId"
                    params={{ spaceId: c.id }}
                    className="focus-ring min-w-0 flex-1 truncate hover:underline"
                  >
                    {c.name}
                  </Link>
                  <span className="shrink-0 mono text-micro text-graphite">
                    {c.companies > 0
                      ? `${c.companies} compan${c.companies === 1 ? 'y' : 'ies'}`
                      : c.memos > 0
                        ? `${c.memos} note${c.memos === 1 ? '' : 's'}`
                        : '—'}
                  </span>
                </RailItem>
              ))}
              <NewSubspace
                parentId={spc.id}
                first={spc.children.length === 0}
              />
            </RailSection>

            {/* Referenced: notes whose body mentions this space but which
                live somewhere else. Filed notes are in the body and never
                repeat here. */}
            <RailSection label="Referenced" meta={`${spc.notes.length}`}>
              {spc.notes.length === 0 ? (
                <RailEmpty>
                  Notes that @mention {spc.name} without being filed here
                  collect here.
                </RailEmpty>
              ) : (
                spc.notes.map((n) => (
                  <RailItem key={n.id}>
                    <FileText
                      className="size-3.5 shrink-0 text-graphite"
                      strokeWidth={1.75}
                    />
                    <Link
                      to="/notes/$noteId"
                      params={{ noteId: n.id }}
                      className="focus-ring min-w-0 flex-1 truncate hover:underline"
                    >
                      {n.title}
                    </Link>
                    <span className="shrink-0 mono text-micro text-graphite">
                      {n.updatedAt.slice(5, 10)}
                    </span>
                  </RailItem>
                ))
              )}
            </RailSection>

            <TasksRail
              entityId={spc.id}
              entityName={spc.name}
              entityKind="space"
            />
          </>
        }
      >
        {/* What I think here — the prose filed against this space. */}
        <LedgerSection
          label="Filed here"
          count={`${spc.filed.length} note${spc.filed.length === 1 ? '' : 's'}`}
          link={
            <Link to="/notes" className="focus-ring text-primary">
              all notes ›
            </Link>
          }
        >
          {spc.filed.map((f) => (
            <li key={f.id} className="border-b border-rule">
              <Link
                to="/notes/$noteId"
                params={{ noteId: f.id }}
                className="focus-ring-inset flex flex-col gap-2 py-4 transition-colors hover:bg-bone"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-title font-medium">
                    {f.title || `${spc.name} ${f.kind}`}
                  </h3>
                  <span className="shrink-0 mono text-label text-graphite">
                    {f.kind} · updated {f.updatedAt.slice(5, 10)}
                  </span>
                </div>
                {f.snippet ? (
                  <p className="text-prose max-w-160 font-serif leading-6.75 text-graphite">
                    {f.snippet}
                    {f.snippet.length >= 400 ? '…' : ''}
                  </p>
                ) : (
                  <p className="text-ui text-graphite">
                    Empty so far — open it and set down what you know.
                  </p>
                )}
              </Link>
            </li>
          ))}
          <LedgerRow last>
            <button
              type="button"
              onClick={() =>
                void newNote(spc.filed.length === 0 ? 'memo' : undefined)
              }
              className={cn(rowLink, 'text-left')}
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-graphite">
                {spc.filed.length === 0
                  ? 'Write the memo — what this space is, why it matters, what would make it investible'
                  : 'File another — a market map, a teardown, a second memo'}
              </span>
              <span className="shrink-0 text-graphite">
                <KeyHint>N</KeyHint>
              </span>
            </button>
          </LedgerRow>
        </LedgerSection>

        {/* What I track here — the market map. Tracking is not evaluating:
            a company can sit here in no pipeline at all. */}
        <LedgerSection
          label="Companies"
          count={
            spc.companies.length === 0
              ? '0'
              : inPipeline === 0
                ? `${spc.companies.length} · all watching`
                : `${spc.companies.length} · ${inPipeline} in pipeline`
          }
          link={
            spc.companies.length > 0 ? (
              <Link to="/companies" className="focus-ring text-primary">
                all companies ›
              </Link>
            ) : null
          }
        >
          {spc.companies.map((c) => (
            <LedgerRow
              key={c.id}
              className={cn(
                'group transition-opacity duration-150 ease-out-quart',
                leaving.has(c.id) && 'pointer-events-none opacity-0',
              )}
            >
              <Link
                to="/companies/$companyId"
                params={{ companyId: c.id }}
                className={rowLink}
              >
                <DitherMark size={14} />
                <span className="min-w-0 flex-1 truncate text-ui font-medium">
                  {c.name}
                </span>
                {c.stage ? (
                  <span className="flex h-5 shrink-0 items-center bg-bone px-1.5 mono text-micro font-medium">
                    {c.stage}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'w-20 shrink-0 truncate text-right mono text-micro',
                    c.deals > 0 ? 'text-foreground' : 'text-graphite',
                  )}
                >
                  {c.deals > 0
                    ? `${c.deals} deal${c.deals === 1 ? '' : 's'}`
                    : 'watching'}
                </span>
                <span className="w-24 shrink-0 truncate text-right mono text-label text-graphite max-md:hidden">
                  {c.geo ?? ''}
                </span>
              </Link>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Untag ${c.name} from ${spc.name}`}
                onClick={() => void untag(c)}
                className="shrink-0 text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
              >
                <X />
              </Button>
            </LedgerRow>
          ))}
          <TagCompanyRow
            spaceId={spc.id}
            spaceName={spc.name}
            taggedIds={taggedIds}
          />
        </LedgerSection>

        {spc.records.length > 0 ? (
          <LedgerSection
            label="Records"
            count={`${spc.records.length} · custom objects tagged here`}
          >
            {spc.records.map((r, i) => (
              <LedgerRow key={r.id} last={i === spc.records.length - 1}>
                <Link
                  to="/o/$objectSlug/$recordId"
                  params={{ objectSlug: r.objectSlug, recordId: r.id }}
                  className={rowLink}
                >
                  <Boxes
                    className="size-3.5 shrink-0 text-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {r.name}
                  </span>
                  <LedgerFigure tone="muted" wide>
                    {r.objectPlural}
                  </LedgerFigure>
                </Link>
              </LedgerRow>
            ))}
          </LedgerSection>
        ) : null}

        <SpaceGlossary spaceId={spc.id} spaceName={spc.name} terms={terms} />
      </RecordBody>
    </div>
  )
}

/** The rail's composer: a subspace is added where the map is read. */
function NewSubspace({
  parentId,
  first,
}: {
  parentId: string
  first: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  async function create() {
    const name = draft.trim()
    if (!name) return setEditing(false)
    try {
      await createSpace({ data: { name, parentId } })
      setDraft('')
      setEditing(false)
      void router.invalidate()
    } catch {
      toast.error('Could not create the subspace')
    }
  }

  return editing ? (
    <RailItem>
      <Input
        autoFocus
        value={draft}
        placeholder="Subspace name"
        aria-label="Subspace name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={create}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create()
          if (e.key === 'Escape') {
            setDraft('')
            setEditing(false)
          }
        }}
        className="h-7 flex-1 px-2 text-label"
      />
    </RailItem>
  ) : (
    <RailItem>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 text-left text-graphite transition-colors hover:text-foreground"
      >
        <Plus className="size-3.5 shrink-0 text-primary" strokeWidth={2.5} />
        <span className="min-w-0 flex-1 truncate">
          {first ? 'Break it down — add a subspace' : 'Subspace'}
        </span>
      </button>
    </RailItem>
  )
}
