import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  CornerDownRight,
  Layers,
  LayoutTemplate,
  Pencil,
  Plus,
  Star,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { KeyHint } from './page-header'
import {
  RailItem,
  RailSection,
  RecordBody,
  RecordHeader,
} from './record/record-parts'
import { SpaceCriteria } from './space-criteria'
import { SpaceGlossary } from './space-glossary'
import { SpaceMoveDialog } from './space-move-dialog'
import { SpaceTabs, spaceReadouts } from './space-tabs'
import { AddWatchDialog, WatchingLane, WhatsMovingLane } from './space-watching'
import type { Space } from './space-tabs'
import { TasksRail } from './tasks-rail'
import { SaveAsTemplateAction } from './templates'
import { SensitiveToggle } from './sensitive-toggle'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { spaceStamp } from './ui/stamp'
import {
  archiveSpace,
  createNote,
  createSpace,
  renameSpace,
  restoreSpace,
  saveSpaceAsTemplate,
} from '#/lib/server-fns'
import type {
  SpaceWatching,
  getEntitySensitivity,
  listTerms,
} from '#/lib/server-fns'
import {
  syncStarredSpaceName,
  toggleStarredSpace,
  useStarredSpaces,
} from '#/lib/chassis-prefs'
import type { SpaceTab } from '#/lib/spaces/page'
import { useHotkey } from '#/lib/use-hotkey'
import { runBinding, usePageActions } from '#/lib/page-actions'

/**
 * A space reads like a record (D73, D74): the head with its stamp, crumb
 * and three readouts; the details column left (Criteria, Watching, What's
 * moving, Map, Glossary, Tasks); the tabbed view right. The route owns which
 * tab is open.
 */

type Term = Awaited<ReturnType<typeof listTerms>>[number]
type Sensitivity = Awaited<ReturnType<typeof getEntitySensitivity>>

export function SpacePageView({
  spc,
  terms,
  sensitivity,
  watching,
  tab,
  onTabChange,
}: {
  spc: Space
  terms: Array<Term>
  sensitivity: Sensitivity
  watching: SpaceWatching
  tab: SpaceTab
  onTabChange: (tab: SpaceTab) => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)
  const [composing, setComposing] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [addingWatch, setAddingWatch] = useState(false)
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
  usePageActions([
    { id: 'note', label: 'Note here', key: 'N', run: runBinding('N') },
    { id: 'task', label: 'Add a task', key: 'T', run: runBinding('T') },
  ])

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
            <span className="text-rule">·</span>
            <span className="shrink-0">
              created {spc.createdAt.slice(0, 10)}
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
            <Button variant="outline" onClick={() => void newNote()}>
              Note here
              <KeyHint>N</KeyHint>
            </Button>
            <Button
              variant="outline"
              disabled={watching.engines.length === 0}
              onClick={() => setAddingWatch(true)}
            >
              Add watch
            </Button>
            <SpaceMenu
              id={spc.id}
              name={spc.name}
              archived={spc.archive !== null}
              onRename={() => setRenaming(true)}
              onSubspace={() => setComposing(true)}
              onMove={() => setMoving(true)}
              onTemplate={() => setTemplating(true)}
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
        readouts={spaceReadouts(spc)}
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

      <SaveAsTemplateAction
        entityLabel="space"
        defaultName={`${spc.name} breakdown`}
        open={templating}
        onOpenChange={setTemplating}
        onSave={async (name) => {
          await saveSpaceAsTemplate({ data: { spaceId: spc.id, name } })
        }}
      />

      <AddWatchDialog
        open={addingWatch}
        onOpenChange={setAddingWatch}
        spaceId={spc.id}
        spaceName={spc.name}
        engines={watching.engines}
      />

      <RecordBody
        details={
          <>
            {/* What belongs here — the membership rule a watch reads. */}
            <div className="border-b border-hairline px-3">
              <SpaceCriteria spaceId={spc.id} criteria={spc.criteria} />
            </div>

            <WatchingLane spaceId={spc.id} watching={watching} />
            <WhatsMovingLane signals={watching.moving} />

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

            <SpaceGlossary spaceId={spc.id} terms={terms} />

            <TasksRail
              entityId={spc.id}
              entityName={spc.name}
              entityKind="space"
              composer="row"
            />
          </>
        }
      >
        <SpaceTabs
          spc={spc}
          tab={tab}
          onTabChange={onTabChange}
          onNewNote={(kind) => void newNote(kind)}
        />
      </RecordBody>
    </div>
  )
}

/**
 * The head's `···`: Star (kept per browser, which puts this space under
 * Spaces on the chassis), then Rename · New subspace · Move to… · Save as
 * template… · Archive.
 * A star follows a rename here, the one place the name is read.
 */
function SpaceMenu({
  id,
  name,
  archived,
  onRename,
  onSubspace,
  onMove,
  onTemplate,
  onArchive,
  onRestore,
}: {
  id: string
  name: string
  archived: boolean
  onRename: () => void
  onSubspace: () => void
  onMove: () => void
  onTemplate: () => void
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
        <DropdownMenuItem onSelect={opening(onTemplate)}>
          <LayoutTemplate className="size-4" />
          Save as template…
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
