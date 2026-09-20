import {
  ClientOnly,
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, Globe, Layers, Lock, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { KIND_ICONS, KIND_ROUTES } from '#/components/editor/mention'
import type { NoteBody } from '@spaces/db/schema/kinds'
import { SaveAsTemplateAction } from '#/components/templates'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { Segmented } from '#/components/ui/segmented'
import { Select } from '#/components/ui/select'
import {
  deleteNote,
  getNote,
  listSpaces,
  listTermsForNote,
  previewNoteDeletion,
  saveNote,
  saveNoteAsTemplate,
  setNoteKind,
  setNoteVisibility,
  tagIntoSpace,
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

function NotePage() {
  const { note: initial, allSpaces, terms } = Route.useLoaderData()
  const [title, setTitle] = useState(initial.title)
  const [saveState, setSaveState] = useState<SaveState>('idle')

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

        <div className="prose-note mt-4">
          <ClientOnly fallback={<div className="min-h-40" />}>
            <NoteEditor
              initialContent={initial.bodyJson}
              terms={terms}
              onChange={(editor) => {
                latest.current = editor
                scheduleSave()
              }}
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
                return (
                  <li key={b.fromId}>
                    <Link
                      to={
                        b.kind === 'note'
                          ? '/notes/$noteId'
                          : KIND_ROUTES[b.kind]
                      }
                      params={b.kind === 'note' ? { noteId: b.fromId } : {}}
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-ui text-graphite hover:text-foreground"
                    >
                      {Icon ? (
                        <Icon className="size-3.5" strokeWidth={1.75} />
                      ) : null}
                      {b.name}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </aside>
        ) : null}
      </div>
    </div>
  )
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
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const unfiled = allSpaces.filter((s) => !filed.some((f) => f.id === s.id))

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {/* Square chips, like the subspace chips on a space page. */}
      {filed.map((s) => (
        <span
          key={s.id}
          className="flex h-6 items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2 text-label font-medium"
        >
          <Layers className="size-2.5 shrink-0" strokeWidth={1.75} />
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId: s.id }}
            className="focus-ring hover:underline"
          >
            {s.name}
          </Link>
          <button
            aria-label={`Remove from ${s.name}`}
            disabled={busy}
            onClick={() =>
              run(() =>
                untagFromSpace({ data: { entityId: noteId, spaceId: s.id } }),
              )
            }
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}

      {/*
        A picker that files rather than holds: its value stays empty, so the
        trigger keeps the dashed invitation and the sheet is the one the rest
        of the app draws. Space names nest — the sheet sizes to them and
        indents by depth, where the old option list padded with spaces.
      */}
      {unfiled.length > 0 ? (
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
      ) : null}
    </div>
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
