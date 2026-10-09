import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  Boxes,
  CornerDownRight,
  FileText,
  Layers,
  Pencil,
  Plus,
  Star,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { SpaceContacts } from '#/components/space-contacts'
import { SpaceCriteria } from '#/components/space-criteria'
import { SpaceGlossary } from '#/components/space-glossary'
import { SpaceMoveDialog } from '#/components/space-move-dialog'
import { SpaceSources } from '#/components/space-sources'
import { TagCompanyRow } from '#/components/space-tag-row'
import { TasksRail } from '#/components/tasks-rail'
import { SaveAsTemplateAction } from '#/components/templates'
import { SensitiveToggle } from '#/components/sensitive-toggle'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { spaceStamp } from '#/components/ui/stamp'
import {
  archiveSpace,
  createNote,
  createSpace,
  getEntitySensitivity,
  getSpace,
  listTerms,
  renameSpace,
  restoreSpace,
  saveSpaceAsTemplate,
  tagIntoSpace,
  untagFromSpace,
} from '#/lib/server-fns'
import {
  syncStarredSpaceName,
  toggleStarredSpace,
  useStarredSpaces,
} from '#/lib/chassis-prefs'
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
    const [spc, terms, sensitivity] = await Promise.all([
      getSpace({ data: { id: params.spaceId } }),
      listTerms({ data: { spaceId: params.spaceId } }),
      getEntitySensitivity({ data: { entityId: params.spaceId } }),
    ])
    return { spc, terms, sensitivity }
  },
  component: SpacePage,
})

type Space = Awaited<ReturnType<typeof getSpace>>
type Company = Space['companies'][number]

/** The row's exit: long enough to read, short enough to ignore. */
const EXIT_MS = 150

function SpacePage() {
  const { spc, terms, sensitivity } = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  // Companies mid-untag: faded until the write lands and the row unmounts.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)
  const [composing, setComposing] = useState(false)
  const archived = spc.archive !== null || spc.archivedUnder !== null

  /** Archive asks nothing: Restore, on the notice it leaves, undoes it. */
  async function archive() {
    try {
      await archiveSpace({ data: { id: spc.id } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not archive')
    }
  }

  async function restore() {
    try {
      await restoreSpace({ data: { id: spc.id } })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not restore')
    }
  }

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
    'focus-ring-inset -ml-3 flex h-full min-w-0 flex-1 items-center gap-3 pl-3 transition-colors hover:bg-bone'

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={spaceStamp(spc.ancestors.length, spc.archive?.on ?? null)}
        archived={archived}
        {...(renaming
          ? {
              nameField: (
                <RenameField
                  id={spc.id}
                  name={spc.name}
                  onDone={() => setRenaming(false)}
                />
              ),
            }
          : {})}
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
            <SensitiveToggle entityId={spc.id} state={sensitivity} />
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
            <SpaceMenu
              id={spc.id}
              name={spc.name}
              archived={spc.archive !== null}
              onRename={() => setRenaming(true)}
              onSubspace={() => setComposing(true)}
              onMove={() => setMoving(true)}
              onArchive={() => void archive()}
              onRestore={() => void restore()}
            />
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
            label: 'Sources',
            value: `${spc.sources.length}`,
            tone: zero(spc.sources.length),
          },
          {
            // Tagged here only. The inherited lane is a convenience, and a
            // readout that folded it in would claim a tag nobody made.
            label: 'Contacts',
            value: `${spc.contacts.length}`,
            tone: zero(spc.contacts.length),
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

      {archived ? (
        <ArchivedNotice
          filings={spc.archive?.filings ?? 0}
          under={spc.archivedUnder}
          onRestore={() => void restore()}
        />
      ) : null}

      <SpaceMoveDialog
        open={moving}
        onOpenChange={setMoving}
        moving={{
          id: spc.id,
          name: spc.name,
          path: spc.path,
          parentId: spc.parentId,
        }}
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
                editing={composing}
                onEditingChange={setComposing}
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
        {/* What belongs here — the membership rule a watch reads. */}
        <SpaceCriteria spaceId={spc.id} criteria={spc.criteria} />

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
                className="focus-ring-inset flex flex-col gap-2 px-3 py-4 transition-colors hover:bg-bone"
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
              className={cn(rowLink, '-mr-3 pr-3 text-left')}
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate text-body text-graphite">
                {spc.filed.length === 0 ? 'Write the memo…' : 'File another…'}
              </span>
              <span className="shrink-0 text-graphite">
                <KeyHint>N</KeyHint>
              </span>
            </button>
          </LedgerRow>
        </LedgerSection>

        {/* What I read here — the documents filed into this space. Sources
            come before the market map on purpose: a space starts as a stack
            of reading, and the companies are what falls out of it. */}
        <SpaceSources
          spaceId={spc.id}
          spaceName={spc.name}
          sources={spc.sources}
          inherited={spc.inheritedSources}
        />

        {/* Who I know here — the people tagged into this space, then the
            ones the companies here bring with them. Between the reading and
            the market map on purpose: a contact is what turns a stack of
            reading into a company you can actually reach. */}
        <SpaceContacts
          spaceId={spc.id}
          spaceName={spc.name}
          contacts={spc.contacts}
          inherited={spc.inheritedContacts}
        />

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
                <span className="min-w-0 flex-1 truncate text-body font-medium">
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
                  className={cn(rowLink, '-mr-3 pr-3')}
                >
                  <Boxes
                    className="size-3.5 shrink-0 text-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-body font-medium">
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

        <SpaceGlossary spaceId={spc.id} terms={terms} />
      </RecordBody>
    </div>
  )
}

/**
 * The head's `···`: Star (kept per browser, which puts this space under
 * Spaces on the chassis), then Rename · New subspace · Move to… · Archive.
 * A star follows a rename here, the one place the name is read.
 */
function SpaceMenu({
  id,
  name,
  archived,
  onRename,
  onSubspace,
  onMove,
  onArchive,
  onRestore,
}: {
  id: string
  name: string
  archived: boolean
  onRename: () => void
  onSubspace: () => void
  onMove: () => void
  onArchive: () => void
  onRestore: () => void
}) {
  const starred = useStarredSpaces().some((s) => s.id === id)
  useEffect(() => syncStarredSpaceName({ id, name }), [id, name])
  // Rename and New subspace open a field: focus goes there, not back to ···.
  const keepFocus = useRef(false)
  const opening = (open: () => void) => () => {
    keepFocus.current = true
    open()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`More for ${name}`}>
          <span aria-hidden className="mono text-ui">
            ···
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) e.preventDefault()
          keepFocus.current = false
        }}
      >
        <DropdownMenuItem onSelect={() => toggleStarredSpace({ id, name })}>
          <Star className="size-4" />
          {starred ? 'Unstar' : 'Star'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={opening(onRename)}>
          <Pencil className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={opening(onSubspace)}>
          <Plus className="size-4" />
          New subspace
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove}>
          <CornerDownRight className="size-4" />
          Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {archived ? (
          <DropdownMenuItem onSelect={onRestore}>
            <ArchiveRestore className="size-4" />
            Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onArchive}>
            <Archive className="size-4" />
            Archive
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Rename in place: the title becomes its own field. ↵ saves, esc keeps the
 * name. Links, filings and watches point at the space id, so nothing else
 * changes. (D73)
 */
function RenameField({
  id,
  name,
  onDone,
}: {
  id: string
  name: string
  onDone: () => void
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(name)
  // ↵ and the blur that follows must not save twice.
  const settled = useRef(false)

  async function save() {
    if (settled.current) return
    settled.current = true
    const next = draft.trim()
    if (!next || next === name) return onDone()
    try {
      await renameSpace({ data: { id, name: next } })
      void router.invalidate()
    } catch {
      toast.error('Could not rename the space')
    } finally {
      onDone()
    }
  }

  return (
    <input
      autoFocus
      value={draft}
      aria-label="Space name"
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void save()
        if (e.key === 'Escape') {
          settled.current = true
          onDone()
        }
      }}
      className="focus-ring w-full min-w-0 border-b border-rule bg-transparent title-serif outline-none"
    />
  )
}

/**
 * Under an archived head: what still holds, and the one way back. A space
 * archived with an ancestor is restored from that ancestor.
 * - Watches are not built yet, so only the filings are counted.
 */
function ArchivedNotice({
  filings,
  under,
  onRestore,
}: {
  filings: number
  under: { id: string; name: string } | null
  onRestore: () => void
}) {
  return (
    <div
      role="status"
      className="mx-8 mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-3 border-double border-hairline bg-paper px-4 py-2.5"
    >
      <p className="min-w-0 flex-1 text-ui">
        <span className="font-medium">Archived.</span> Out of the tree and the
        space picker.
      </p>
      <span className="shrink-0 mono text-micro text-graphite">
        {filings} filing{filings === 1 ? '' : 's'} kept
      </span>
      {under ? (
        <Link
          to="/spaces/$spaceId"
          params={{ spaceId: under.id }}
          className="focus-ring shrink-0 text-label text-primary"
        >
          Archived with {under.name} ›
        </Link>
      ) : (
        <Button variant="outline" size="sm" onClick={onRestore}>
          Restore
        </Button>
      )}
    </div>
  )
}

/** The rail's composer: a subspace is added where the map is read. */
function NewSubspace({
  parentId,
  first,
  editing,
  onEditingChange: setEditing,
}: {
  parentId: string
  first: boolean
  /** Open from the rail's row or the head's ··· New subspace. */
  editing: boolean
  onEditingChange: (editing: boolean) => void
}) {
  const router = useRouter()
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
