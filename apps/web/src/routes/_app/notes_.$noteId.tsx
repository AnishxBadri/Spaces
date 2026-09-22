import {
  ClientOnly,
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, Globe, Layers, Lock, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '#/components/document-preview'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { KIND_ICONS } from '#/components/editor/mention'
import type { DroppedDocument } from '#/components/editor/note-editor'
import {
  DOCUMENT_PREVIEW_EVENT,
  documentPreviewRequest,
} from '#/lib/editor/document-preview-event'
import {
  fileAgainstForNote,
  noteDropFailure,
  noteDropFiledIn,
  UNFILED_SHELF_LABEL,
} from '#/lib/documents/note-drop'
import { uploadDocument } from '#/lib/documents/upload'
import type { UploadPhase } from '#/lib/documents/upload'
import type { NoteBody } from '@spaces/db/schema/kinds'
import { SaveAsTemplateAction } from '#/components/templates'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Input } from '#/components/ui/input'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import { recordPath } from '#/lib/record-path'
import {
  deleteNote,
  fileNoteAgainst,
  getDocumentPreview,
  getNote,
  listSpaces,
  listTermsForNote,
  previewNoteDeletion,
  saveNote,
  saveNoteAsTemplate,
  searchEntities,
  setNoteKind,
  setNoteVisibility,
  tagIntoSpace,
  unfileNoteFrom,
  untagFromSpace,
} from '#/lib/server-fns'

/**
 * The prose register: this page reads like a page, not a dashboard.
 * Serif body, capped measure, quiet chrome.
 */
export const Route = createFileRoute('/_app/notes_/$noteId')({
  loader: async ({ params }) => {
    const [note, spaces, terms] = await Promise.all([
      getNote({ data: { id: params.noteId } }),
      listSpaces(),
      listTermsForNote({ data: { noteId: params.noteId } }),
    ])
    return { note, allSpaces: spaces, terms }
  },
  component: NotePage,
})

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

/** One toast, rewritten in place, for the three phases of a dropped file. */
const DROP_PHASES: Record<UploadPhase, string> = {
  hashing: 'Reading…',
  uploading: 'Uploading…',
  filing: 'Filing…',
}

function NotePage() {
  const { note: initial, allSpaces, terms } = Route.useLoaderData()
  const [title, setTitle] = useState(initial.title)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const preview = useDocumentPreview()
  const onFileDrop = useNoteFileDrop(initial.spaces)

  const latest = useRef<{
    document: NoteBody
    blocksToMarkdownLossy: () => Promise<string>
  } | null>(null)
  const titleRef = useRef(initial.title)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    const snapshot = latest.current
    setSaveState('saving')
    try {
      // No editor change yet → title-only save; body stays untouched.
      let body
      if (snapshot) {
        const doc = snapshot.document
        const lossyMd = await snapshot.blocksToMarkdownLossy()
        body = {
          bodyJson: doc,
          bodyMd: deriveMarkdown(lossyMd, doc),
          mentionIds: extractMentionIds(doc),
        }
      }
      await saveNote({
        data: { id: initial.id, title: titleRef.current, body },
      })
      setSaveState('saved')
    } catch {
      setSaveState('dirty') // retried on next change
    }
  }, [initial.id])

  const scheduleSave = useCallback(() => {
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void flush()
    }, 800)
  }, [flush])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className="flex min-h-full flex-col">
      {/* The head runs the full field on a hairline; the sheet below keeps
          its 72ch measure at the gutter. */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-8">
        <Link
          to="/notes"
          className="focus-ring flex items-center gap-1.5 rounded-md text-ui text-graphite hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Notes
        </Link>
        <span className="flex items-center gap-3">
          <KindToggle noteId={initial.id} kind={initial.kind} />
          <span
            className="text-label text-graphite"
            role="status"
            aria-live="polite"
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved'
                : saveState === 'dirty'
                  ? 'Unsaved changes'
                  : ''}
          </span>
          <SaveAsTemplateAction
            entityLabel="note"
            defaultName={initial.title}
            onSave={async (name) => {
              await saveNoteAsTemplate({
                data: { noteId: initial.id, name },
              })
            }}
          />
          {initial.isMine ? (
            <VisibilityToggle
              noteId={initial.id}
              isPrivate={initial.isPrivate}
            />
          ) : null}
          <DeleteNoteAction noteId={initial.id} />
        </span>
      </div>

      <div className="max-w-[72ch] px-8 pt-6 pb-8">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            titleRef.current = e.target.value
            scheduleSave()
          }}
          placeholder="Untitled"
          aria-label="Note title"
          className="w-full bg-transparent title-serif outline-none placeholder:text-graphite"
        />

        <SpaceFiling
          noteId={initial.id}
          filed={initial.spaces}
          allSpaces={allSpaces}
        />

        <RecordFiling noteId={initial.id} filed={initial.filedAgainst} />

        <div className="prose-note mt-4">
          <ClientOnly fallback={<div className="min-h-40" />}>
            <NoteEditor
              initialContent={initial.bodyJson}
              terms={terms}
              onChange={(editor) => {
                latest.current = editor
                scheduleSave()
              }}
              onFileDrop={onFileDrop}
            />
          </ClientOnly>
        </div>

        {initial.backlinks.length > 0 ? (
          <aside className="mt-12 border-t border-rule pt-5">
            <h2 className="text-label font-medium text-graphite">
              Linked from
            </h2>
            <ul className="mt-2 space-y-1">
              {initial.backlinks.map((b) => {
                // KIND_ICONS' Record index type hides misses — widen honestly.
                const Icon: LucideIcon | undefined = KIND_ICONS[b.kind]
                const row = (
                  <>
                    {Icon ? (
                      <Icon className="size-3.5" strokeWidth={1.75} />
                    ) : null}
                    {b.name}
                  </>
                )
                const className =
                  'flex items-center gap-2 rounded-md px-1 py-0.5 text-ui text-graphite hover:text-foreground'
                // One route table for the whole app, as the chip row below
                // already uses: `KIND_ROUTES` covers four kinds, so every
                // other one rendered `<Link to={undefined}>` — a focusable
                // row that goes nowhere. A document has no page at all, and
                // opens the same preview its chip does.
                const href = recordPath({ kind: b.kind, id: b.fromId })
                return (
                  <li key={b.fromId}>
                    {b.kind === 'document' ? (
                      <button
                        type="button"
                        className={className}
                        onClick={() => preview.open(b.fromId)}
                      >
                        {row}
                      </button>
                    ) : href ? (
                      <Link to={href} className={className}>
                        {row}
                      </Link>
                    ) : (
                      <span className={className}>{row}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </aside>
        ) : null}
      </div>

      {/* Mounted by the page, not by the editor: a mention chip renders
          inside BlockNote's ProseMirror tree, where a Radix dialog has no
          context to open in and is remounted on every nearby keystroke.
          The chip dispatches; this listens. */}
      <DocumentPreview doc={preview.doc} onOpenChange={preview.onOpenChange} />
    </div>
  )
}

/**
 * §3.1 **entry point 4** (SPA-140): a file dropped on the note body becomes a
 * document filed exactly where the note is filed, and a mention chip where
 * the pointer let go.
 *
 * The editor owns the gesture and the insert; this owns the upload and
 * everything the reader is told, because the two things that decide both are
 * facts about the page — which spaces the note is filed in, and that a note
 * in none of them files the document nowhere rather than guessing one.
 *
 * `uploadDocument` is docsurf-6a's one browser lane and the only hasher in
 * the app (`lib/documents/upload.ts`): the bytes go from the page straight to
 * storage and only the row is filed through a server fn. One call per file,
 * carrying **every** space in one `fileAgainst` array — that array is the
 * whole reason birth takes a list, and the difference between one document
 * row with N edges and N copies of one deck (§3.4).
 */
function useNoteFileDrop(
  spaces: Array<{ id: string; name: string }>,
): (file: File) => Promise<DroppedDocument | null> {
  const navigate = useNavigate()

  // Read once, for the page, not once per file: four files dropped together
  // inherit the filing the note had when they were dropped, even if a space
  // chip is removed while the third is still hashing.
  const fileAgainst = useMemo(() => fileAgainstForNote(spaces), [spaces])
  const filedIn = useMemo(() => noteDropFiledIn(spaces), [spaces])
  const unfiled = fileAgainst.length === 0

  return useCallback(
    async (file: File) => {
      // One toast per file, rewritten through the three phases and then into
      // its own outcome, so a four-file drop is four lines and not twelve.
      const id = toast.loading(`${file.name} · ${DROP_PHASES.hashing}`)
      try {
        const born = await uploadDocument({
          file,
          fileAgainst,
          onPhase: (phase) =>
            toast.loading(`${file.name} · ${DROP_PHASES[phase]}`, { id }),
        })
        if (unfiled) {
          // Not an error — unfiled is a first-class state (§3.2) — but not a
          // silent success either: the document is real and nobody has said
          // where it lives, so the line that says so carries the way to it.
          toast.message(filedIn, {
            id,
            description: `${file.name} is on the shelf with no filing of its own.`,
            action: {
              label: UNFILED_SHELF_LABEL,
              onClick: () =>
                void navigate({
                  to: '/documents',
                  search: { filed: 'unfiled' },
                }),
            },
          })
        } else {
          toast.success(`${file.name} · ${filedIn}`, { id })
        }
        return { entityId: born.id, label: file.name }
      } catch (err) {
        // Caught per file and inside the caller's loop: one 300MB deck
        // refused by the size guard must not take the three good files after
        // it with it, and returning null is what leaves no chip behind.
        toast.error(noteDropFailure(file.name, err), { id })
        return null
      }
    },
    [fileAgainst, filedIn, navigate, unfiled],
  )
}

/**
 * The document preview this page opens on behalf of its mention chips
 * (SPA-27). The chip carries only an entity id, so the row is fetched on the
 * click rather than loaded with the note — a note may mention a dozen decks
 * and open none of them.
 */
function useDocumentPreview() {
  const [doc, setDoc] =
    useState<Awaited<ReturnType<typeof getDocumentPreview>>>(null)

  // A run token, not a boolean: a second chip clicked while the first fetch
  // is in flight must win, and a fetch that resolves after a close must not
  // reopen the dialog.
  const runRef = useRef(0)

  const open = useCallback((entityId: string) => {
    const run = ++runRef.current
    void (async () => {
      try {
        const row = await getDocumentPreview({ data: { id: entityId } })
        if (runRef.current !== run) return
        if (!row) {
          toast.error('That document is no longer here')
          return
        }
        setDoc(row)
      } catch (err) {
        if (runRef.current !== run) return
        toast.error(
          err instanceof Error ? err.message : 'Could not open that document',
        )
      }
    })()
  }, [])

  const onOpenChange = useCallback((next: boolean) => {
    if (next) return
    runRef.current++
    setDoc(null)
  }, [])

  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = documentPreviewRequest(event)
      if (request) open(request.entityId)
    }
    // The event bubbles out of the editor to the document, which is the one
    // node guaranteed to be above every chip however BlockNote nests them.
    globalThis.document.addEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    return () => {
      globalThis.document.removeEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    }
  }, [open])

  return { doc, open, onOpenChange }
}

/** The three kinds the enum holds, as `getNote` hands them over. */
type NoteKind = Awaited<ReturnType<typeof getNote>>['kind']

/**
 * Note · Memo · Scratch, in the head row beside the save state. Kind is
 * presentation and intent, never structure (CONTEXT.md → The note model): a
 * promote or a demote moves this one column and leaves every link, every
 * space filing and the body exactly where they were.
 *
 * Not gated on `isMine`, unlike visibility beside it — a shared note's genre
 * is the team's reading of it, and the server agrees.
 */
function KindToggle({
  noteId,
  kind: initial,
}: {
  noteId: string
  kind: NoteKind
}) {
  const router = useRouter()
  const [kind, setKind] = useState(initial)
  const [pending, setPending] = useState(false)

  async function pick(next: NoteKind) {
    if (next === kind || pending) return
    const previous = kind
    // Optimistic: the segment inks on the click, and rolls back if the
    // server refuses — the alternative is a control that lags a round trip.
    setKind(next)
    setPending(true)
    try {
      await setNoteKind({ data: { id: noteId, kind: next } })
      await router.invalidate()
    } catch (e) {
      setKind(previous)
      toast.error(e instanceof Error ? e.message : 'Could not change that')
    } finally {
      setPending(false)
    }
  }

  return (
    <Segmented
      size="sm"
      label="Note kind"
      value={kind}
      disabled={pending}
      options={[
        { id: 'note', label: 'Note' },
        { id: 'memo', label: 'Memo' },
        { id: 'scratch', label: 'Scratch' },
      ]}
      onChange={(next) => void pick(next)}
    />
  )
}

/**
 * Author-only. Default is shared — private is the exception you opt into
 * (CONTEXT.md: notes private-by-default is the trap that keeps partner #2
 * writing in Apple Notes).
 */
function VisibilityToggle({
  noteId,
  isPrivate: initialPrivate,
}: {
  noteId: string
  isPrivate: boolean
}) {
  const [isPrivate, setIsPrivate] = useState(initialPrivate)
  const [pending, setPending] = useState(false)

  async function toggle() {
    const next = !isPrivate
    setPending(true)
    try {
      await setNoteVisibility({
        data: { id: noteId, visibility: next ? 'private' : 'shared' },
      })
      setIsPrivate(next)
      toast.success(
        next ? 'Only you can see this note now' : 'Visible to the workspace',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change that')
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label font-medium text-graphite hover:bg-bone hover:text-foreground"
      title={
        isPrivate
          ? 'Private — only you. Click to share with the workspace.'
          : 'Shared with the workspace. Click to make private.'
      }
    >
      {isPrivate ? (
        <Lock className="size-3" strokeWidth={1.75} />
      ) : (
        <Globe className="size-3" strokeWidth={1.75} />
      )}
      {isPrivate ? 'Private' : 'Shared'}
    </button>
  )
}

/** One chip: what it is, where it goes, how it is spelled. */
type FilingChip = {
  id: string
  name: string
  /** null = this kind has no page; the chip reads as text, not a dead link. */
  href: string | null
  Icon: LucideIcon | undefined
}

/**
 * The chip row, once. Both filing lanes draw it — spaces through
 * `entity_space`, records through `link(tagged_in)` — because the two are
 * different *writes*, not different shapes: a square chip, its kind icon,
 * its link, and an × that removes exactly that one edge.
 *
 * Deliberately **not** pre-parameterised for the documents surface. It takes
 * the chips it is given and an adder node; the lane above it owns the write,
 * the picker and the refresh. A third caller adds a third lane, and whatever
 * that lane needs gets argued then, with the caller in front of us.
 */
function FilingRow({
  label,
  chips,
  busy,
  removeLabel,
  onRemove,
  adder,
}: {
  label: string
  chips: Array<FilingChip>
  busy: boolean
  removeLabel: (name: string) => string
  onRemove: (chip: FilingChip) => void
  adder: React.ReactNode
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="w-24 shrink-0 field-label text-graphite">{label}</span>
      {/* Square chips, like the subspace chips on a space page. */}
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="flex h-6 items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2 text-label font-medium"
        >
          {chip.Icon ? (
            <chip.Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
          ) : null}
          {chip.href ? (
            <Link to={chip.href} className="focus-ring hover:underline">
              {chip.name}
            </Link>
          ) : (
            chip.name
          )}
          <button
            type="button"
            aria-label={removeLabel(chip.name)}
            disabled={busy}
            onClick={() => onRemove(chip)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      {adder}
    </div>
  )
}

/** Run a filing write, then let the loader say what the row now is. */
function useFiling() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await router.invalidate()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not file')
      } finally {
        setBusy(false)
      }
    },
    [router],
  )

  return { busy, run }
}

/**
 * Filing, not referencing. Mentioning a space in the body links to it;
 * filing says the note *lives* here, and puts it in the space's top block.
 * Same `entity_space` write a company tag makes — one mechanism per kind.
 */
function SpaceFiling({
  noteId,
  filed,
  allSpaces,
}: {
  noteId: string
  filed: Array<{ id: string; name: string }>
  allSpaces: Awaited<ReturnType<typeof listSpaces>>
}) {
  const { busy, run } = useFiling()
  const unfiled = allSpaces.filter((s) => !filed.some((f) => f.id === s.id))

  return (
    <FilingRow
      label="Filed in space"
      busy={busy}
      chips={filed.map((s) => ({
        id: s.id,
        name: s.name,
        href: `/spaces/${s.id}`,
        Icon: Layers,
      }))}
      removeLabel={(name) => `Remove from ${name}`}
      onRemove={(chip) =>
        void run(() =>
          untagFromSpace({ data: { entityId: noteId, spaceId: chip.id } }),
        )
      }
      adder={
        /*
          A picker that files rather than holds: its value stays empty, so the
          trigger keeps the dashed invitation and the sheet is the one the rest
          of the app draws. Spaces are a tree of a few dozen, so the whole list
          is offered and it nests by depth — the record lane below cannot do
          that, which is why it searches instead.
        */
        unfiled.length > 0 ? (
          <Select
            aria-label="File this note in a space"
            value=""
            disabled={busy}
            onChange={(spaceId) =>
              void run(() =>
                tagIntoSpace({ data: { entityId: noteId, spaceId } }),
              )
            }
            items={unfiled.map((s) => ({
              value: s.id,
              label: s.name,
              depth: s.depth,
            }))}
            width="content"
            placeholder="+ File in space…"
            searchPlaceholder="Search spaces…"
            emptyLabel="No space matches."
            className="h-6 w-auto rounded-none border-dashed bg-transparent px-2 text-label text-graphite hover:text-foreground"
          />
        ) : null
      }
    />
  )
}

/**
 * The other lane (SPA-116): the records this note is filed against, which is
 * `link(tagged_in)` — the outbound direction, and the opposite of the
 * "Linked from" aside, which lists who mentions the note.
 *
 * Unfiling removes the filing alone. A body mention of the same record is a
 * different edge and stays, so the note slides from "Filed here" to "Mentions
 * this" on that record instead of vanishing from it.
 */
function RecordFiling({
  noteId,
  filed,
}: {
  noteId: string
  filed: Awaited<ReturnType<typeof getNote>>['filedAgainst']
}) {
  const { busy, run } = useFiling()

  return (
    <FilingRow
      label="Filed against"
      busy={busy}
      chips={filed.map((r) => ({
        id: r.id,
        name: r.name,
        // One route table for the whole app: a custom record goes through
        // its object's slug, and a kind with no page reads as text.
        href: recordPath(r),
        Icon: KIND_ICONS[r.kind],
      }))}
      removeLabel={(name) => `Unfile from ${name}`}
      onRemove={(chip) =>
        void run(() =>
          unfileNoteFrom({ data: { id: noteId, targetId: chip.id } }),
        )
      }
      adder={
        <RecordFilingPicker
          noteId={noteId}
          filedIds={filed.map((r) => r.id)}
          disabled={busy}
          onPick={(targetId) =>
            void run(() => fileNoteAgainst({ data: { id: noteId, targetId } }))
          }
        />
      }
    />
  )
}

/**
 * Records are unbounded where spaces are a tree of a few dozen, so this is a
 * debounced search rather than a list — the combobox `value-editor.tsx`'s
 * record-reference picker already draws.
 *
 * `searchEntities` filters merged records and unreadable notes in SQL; the
 * `kinds` argument is what keeps `space`, `note` and `document` out. That is
 * a convenience, not the rule: `fileNoteAgainstProgram` refuses the same
 * targets server-side. `mandate` is absent from the list because it is a
 * workspace row rather than an entity — it has no id the `link` table could
 * point at, so it cannot be offered and could not be accepted.
 */
function RecordFilingPicker({
  noteId,
  filedIds,
  disabled,
  onPick,
}: {
  noteId: string
  filedIds: Array<string>
  disabled: boolean
  onPick: (targetId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<
    Awaited<ReturnType<typeof searchEntities>>
  >([])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const rows = await searchEntities({
          data: { q: query, kinds: ['company', 'person', 'deal', 'custom'] },
        })
        if (alive) setResults(rows)
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  // Already filed, and the note itself — the second is unreachable through
  // `kinds` above, and held here anyway so the exclusion does not depend on
  // an argument a future edit could widen.
  const excluded = useMemo(
    () => new Set([...filedIds, noteId]),
    [filedIds, noteId],
  )
  const offered = results.filter((r) => !excluded.has(r.id))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="File this note against a record"
        disabled={disabled}
        className="focus-ring flex h-6 items-center rounded-none border border-dashed border-rule px-2 text-label text-graphite hover:text-foreground disabled:opacity-50"
      >
        + File against…
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="p-1.5">
          <Input
            value={query}
            autoFocus
            placeholder="Search records…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-7 text-label"
          />
        </div>
        {offered.map((r) => (
          <DropdownMenuItem
            key={r.id}
            onSelect={() => {
              onPick(r.id)
              setQuery('')
            }}
          >
            {r.name}
          </DropdownMenuItem>
        ))}
        {query.trim() && offered.length === 0 ? (
          <p className="px-2 py-1.5 text-label text-graphite">
            No record matches.
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Hard delete, no trash (CONTEXT.md → The note model, 2026-09-19). The
 * preview runs before the sheet opens, so the sheet can name what loses its
 * edge to this note — and so the mandate's note is refused *in the dialog*,
 * in the registry's own words, rather than by a toast after the user has
 * already said yes.
 */
function DeleteNoteAction({ noteId }: { noteId: string }) {
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const { confirm, confirmDialog } = useConfirm()

  async function remove() {
    setBusy(true)
    try {
      const impact = await previewNoteDeletion({ data: { id: noteId } })
      const name = impact.title || 'Untitled'
      if (impact.blockedReason !== null) {
        // A notice, not a question: no Delete button, because the server has
        // already said it would refuse, and it said why.
        await confirm({
          title: `“${name}” stays`,
          body: impact.blockedReason,
          kind: 'primary',
          keep: 'Close',
        })
        return
      }
      const ok = await confirm({
        title: `Delete “${name}”?`,
        body:
          impact.unlinks.length > 0
            ? 'The note and its text go for good. Everything listed below keeps its own row — only its link to this note goes.'
            : 'The note and its text go for good. This cannot be undone.',
        rows: impact.unlinks,
        action: 'Delete',
      })
      if (!ok) return
      await deleteNote({ data: { id: noteId } })
      // Leave first, then invalidate: this route's loader would otherwise
      // refetch a note that is no longer there.
      await navigate({ to: '/notes' })
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        title="Delete this note"
        className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label font-medium text-graphite hover:bg-bone hover:text-destructive"
      >
        <Trash2 className="size-3" strokeWidth={1.75} />
        Delete
      </button>
      {confirmDialog}
    </>
  )
}
