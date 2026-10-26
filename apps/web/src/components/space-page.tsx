import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import {
  Archive,
  ArchiveRestore,
  CornerDownRight,
  Layers,
  BookOpen,
  LayoutTemplate,
  Pencil,
  Plus,
  Search,
  Star,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  RailGroup,
  RailGroupRow,
  RecordBody,
  RecordHeader,
} from './record/record-parts'
import { SpaceCriteria } from './space-criteria'
import { SpaceGlossary } from './space-glossary'
import { SpaceMoveDialog } from './space-move-dialog'
import { SpaceTabs } from './space-tabs'
import { AddWatchDialog, WatchingLane, useAddWatch } from './space-watching'
import type { Space } from './space-tabs'
import { SaveAsTemplateAction } from './templates'
import { useSensitiveItem } from './sensitive-toggle'
import type { SensitivityState } from './sensitive-toggle'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { MENU_RULE, MoreMenu } from './ui/more-menu'
import { Input } from './ui/input'
import { spaceStamp } from './ui/stamp'
import type { StampProps } from './ui/stamp'
import {
  archiveSpace,
  createNote,
  createSpace,
  renameSpace,
  restoreSpace,
  saveSpaceAsTemplate,
} from '#/lib/server-fns'
import type { SpaceWatching, listTerms } from '#/lib/server-fns'
import {
  syncStarredSpaceName,
  toggleStarredSpace,
  useStarredSpaces,
} from '#/lib/chassis-prefs'
import type { SpaceTab } from '#/lib/spaces/page'
import { useHotkey } from '#/lib/use-hotkey'
import { runBinding, usePageActions } from '#/lib/page-actions'
import { openAsk } from '#/lib/ask/dock-store'
import { findQuestion } from '#/lib/ask/find-view'
import { useWebSources } from '#/lib/ask/web-sources'

/**
 * A space reads like a record: the head with its stamp and crumb, `···`
 * its one control; the rail left (Criteria, Watching, Map); the tabbed view
 * right, Overview first. The glossary is a window the `···` opens. The route
 * owns which tab is open, and `into` — the subspace a split moves companies
 * into.
 */

type Term = Awaited<ReturnType<typeof listTerms>>[number]

export function SpacePageView({
  spc,
  terms,
  sensitivity,
  watching,
  tab,
  into,
  markedWatch = null,
  onTabChange,
}: {
  spc: Space
  terms: Array<Term>
  sensitivity: SensitivityState
  watching: SpaceWatching
  tab: SpaceTab
  into: string | null
  /** A watch to mark in the Watching lane. */
  markedWatch?: string | null
  onTabChange: (tab: SpaceTab) => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)
  const [composing, setComposing] = useState(false)
  // ··· Split into a subspace: the new child becomes Move here's target.
  const [splitting, setSplitting] = useState(false)
  const [templating, setTemplating] = useState(false)
  const [addingWatch, setAddingWatch] = useState(false)
  const [glossary, setGlossary] = useState(false)
  const saveWatch = useAddWatch(spc.id)
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
  /** A split lands here on Companies, selecting into the new child. */
  async function subspaceCreated(id: string) {
    setComposing(false)
    if (splitting) {
      setSplitting(false)
      await navigate({
        to: '/spaces/$spaceId',
        params: { spaceId: spc.id },
        search: { tab: 'companies', into: id },
        resetScroll: false,
      })
    }
    void router.invalidate()
  }

  useHotkey('n', () => void newNote())
  // A space reads like a record, so its verbs are scoped to it.
  usePageActions(
    [
      { id: 'note', label: 'Note here', key: 'N', run: runBinding('N') },
      { id: 'task', label: 'Add a task', key: 'T', run: runBinding('T') },
    ],
    spc.name,
  )

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={stampOf(spc.archive?.on ?? null, sensitivity)}
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
        suffix={{
          path: (
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
            </nav>
          ),
        }}
        actions={
          <SpaceMenu
            id={spc.id}
            name={spc.name}
            criteria={spc.criteria}
            archived={spc.archive !== null}
            sensitivity={sensitivity}
            onRename={() => setRenaming(true)}
            onSubspace={() => {
              setSplitting(true)
              setComposing(true)
            }}
            onMove={() => setMoving(true)}
            onTemplate={() => setTemplating(true)}
            onGlossary={() => setGlossary(true)}
            onArchive={() => void archive()}
            onRestore={() => void restore()}
          />
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
        space={{ id: spc.id, name: spc.name, criteria: spc.criteria }}
        engines={watching.engines}
        onSave={saveWatch}
      />

      <Dialog open={glossary} onOpenChange={setGlossary}>
        <DialogContent size="m" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Glossary</DialogTitle>
          <SpaceGlossary spaceId={spc.id} terms={terms} />
        </DialogContent>
      </Dialog>

      <RecordBody
        groups
        details={
          <>
            {/* What belongs here — the membership rule a watch reads. */}
            <SpaceCriteria spaceId={spc.id} criteria={spc.criteria} />

            <WatchingLane
              spaceId={spc.id}
              watching={watching}
              marked={markedWatch}
              // Absent until an installed watch engine is enabled.
              {...(watching.engines.length > 0
                ? { onAdd: () => setAddingWatch(true) }
                : {})}
            />

            <RailGroup label="Map" count={`${spc.children.length} sub`}>
              {spc.parent ? (
                <RailGroupRow>
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
                </RailGroupRow>
              ) : null}
              {spc.children.map((c) => (
                <RailGroupRow key={c.id}>
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
                        : ''}
                  </span>
                </RailGroupRow>
              ))}
              <NewSubspace
                parentId={spc.id}
                editing={composing}
                onEditingChange={(editing) => {
                  setComposing(editing)
                  if (!editing) setSplitting(false)
                }}
                onCreated={(id) => void subspaceCreated(id)}
              />
            </RailGroup>
          </>
        }
      >
        <SpaceTabs
          spc={spc}
          signals={watching.moving}
          tab={tab}
          into={into}
          onTabChange={onTabChange}
          onNewNote={(kind) => void newNote(kind)}
        />
      </RecordBody>
    </div>
  )
}

/** A space's stamp: outlined once archived, locked while sensitive. */
function stampOf(
  archivedOn: string | null,
  sensitivity: SensitivityState,
): StampProps {
  if (archivedOn !== null || sensitivity.sensitivity !== 'sensitive')
    return spaceStamp(archivedOn)
  return { kind: 'Space', state: 'sensitive' }
}

/**
 * The head's `···`, the space head's one control: Find companies · Star
 * (kept per browser, which puts this space under Spaces on the chassis) ·
 * Rename · Move to… · Split into a subspace… · Save as template… ·
 * Glossary…, then Sensitive, then Archive.
 * A star follows a rename here, the one place the name is read.
 */
export function SpaceMenu({
  id,
  name,
  criteria,
  archived,
  sensitivity,
  onRename,
  onSubspace,
  onMove,
  onTemplate,
  onGlossary,
  onArchive,
  onRestore,
}: {
  id: string
  name: string
  criteria: string | null
  archived: boolean
  sensitivity: SensitivityState
  onRename: () => void
  onSubspace: () => void
  onMove: () => void
  onTemplate: () => void
  onGlossary: () => void
  onArchive: () => void
  onRestore: () => void
}) {
  const starred = useStarredSpaces().some((s) => s.id === id)
  const navigate = useNavigate()
  const finders = useWebSources()
  const sensitive = useSensitiveItem(id, sensitivity)
  useEffect(() => syncStarredSpaceName({ id, name }), [id, name])
  // Rename, Split, Move to…, Save as template… and Glossary… open a field or
  // a window, so each runs once the menu's focus trap has let go; opened
  // inside it, the autofocus is pulled back to the item, which unmounts and
  // leaves focus on the body.
  return (
    <MoreMenu
      variant="head"
      label={name}
      items={[
        // Opens Ask with this space and the web in scope.
        {
          label: 'Find companies',
          icon: <Search className="size-4" />,
          hint: finders.length > 0 ? undefined : 'Add an Exa key ›',
          onSelect: () =>
            finders.length > 0
              ? openAsk({ draft: findQuestion(name, criteria), web: true })
              : void navigate({ to: '/settings/plugins' }),
        },
        {
          label: starred ? 'Unstar' : 'Star',
          icon: <Star className="size-4" />,
          onSelect: () => toggleStarredSpace({ id, name }),
        },
        MENU_RULE,
        {
          label: 'Rename',
          icon: <Pencil className="size-4" />,
          onSelect: onRename,
          opens: true,
        },
        {
          label: 'Move to…',
          icon: <CornerDownRight className="size-4" />,
          onSelect: onMove,
          opens: true,
        },
        {
          label: 'Split into a subspace…',
          icon: <Plus className="size-4" />,
          onSelect: onSubspace,
          opens: true,
        },
        {
          label: 'Save as template…',
          icon: <LayoutTemplate className="size-4" />,
          onSelect: onTemplate,
          opens: true,
        },
        {
          label: 'Glossary…',
          icon: <BookOpen className="size-4" />,
          onSelect: onGlossary,
          opens: true,
        },
        MENU_RULE,
        sensitive,
        MENU_RULE,
        archived
          ? {
              label: 'Restore',
              icon: <ArchiveRestore className="size-4" />,
              onSelect: onRestore,
            }
          : {
              label: 'Archive',
              icon: <Archive className="size-4" />,
              onSelect: onArchive,
            },
      ]}
    />
  )
}

/**
 * Rename in place: the title becomes a boxed field with `↵ save` under it.
 * ↵ or a blur saves, Escape keeps the name. Links, filings and watches point
 * at the space id, so nothing else changes.
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
    <span className="flex min-w-0 flex-col gap-2.5">
      <input
        autoFocus
        value={draft}
        aria-label="Space name"
        aria-keyshortcuts="Enter"
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
        className="focus-ring-inset h-10 w-full min-w-0 rounded-md border border-hairline bg-paper px-2 title-serif"
      />
      <span aria-hidden className="mono text-micro text-graphite">
        ↵ save
      </span>
    </span>
  )
}

/**
 * Under an archived head: what still holds, and the one way back. A space
 * archived with an ancestor is restored from that ancestor.
 * - Archive hides and pauses: filings stay, watches stop running.
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
      className="mx-8 mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-3 border-double border-hairline bg-paper px-4 py-2.5 shadow-solid"
    >
      <p className="min-w-0 flex-1 text-ui text-graphite">
        <span className="font-medium text-foreground">Archived</span> · out of
        the tree and the picker · {filings} filing{filings === 1 ? '' : 's'}{' '}
        kept · watches paused
      </p>
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
  editing,
  onEditingChange: setEditing,
  onCreated,
}: {
  parentId: string
  /** Open from the rail's row or the head's ··· Split into a subspace. */
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** The child exists; the page closes the field and reloads. */
  onCreated: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  // Enter saves and the field's blur follows it: one create, not two.
  const saving = useRef(false)

  async function create() {
    if (saving.current) return
    const name = draft.trim()
    if (!name) return setEditing(false)
    saving.current = true
    try {
      const { id } = await createSpace({ data: { name, parentId } })
      setDraft('')
      onCreated(id)
    } catch {
      toast.error('Could not create the subspace')
    } finally {
      saving.current = false
    }
  }

  return editing ? (
    <RailGroupRow>
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
    </RailGroupRow>
  ) : (
    <RailGroupRow>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 text-left text-graphite transition-colors hover:text-foreground"
      >
        <Plus className="size-3.5 shrink-0 text-primary" strokeWidth={2.5} />
        <span className="min-w-0 flex-1 truncate">Subspace</span>
      </button>
    </RailGroupRow>
  )
}
