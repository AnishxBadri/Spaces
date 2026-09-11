import {
  ClientOnly,
  createFileRoute,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, Globe, Layers, Lock, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { KIND_ICONS, KIND_ROUTES } from '#/components/editor/mention'
import { SaveAsTemplateAction } from '#/components/templates'
import {
  getNote,
  listSpaces,
  listTermsForNote,
  saveNote,
  saveNoteAsTemplate,
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
    document: unknown
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
          className="focus-ring flex items-center gap-1.5 rounded-md text-ui text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Notes
        </Link>
        <span className="flex items-center gap-3">
          <span
            className="text-xs text-muted-foreground"
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
          <aside className="mt-12 border-t border-border pt-5">
            <h2 className="text-xs font-medium text-muted-foreground">
              Linked from
            </h2>
            <ul className="mt-2 space-y-1">
              {initial.backlinks.map((b) => {
                // KIND_ICONS' Record index type hides misses — widen honestly.
                const Icon = (
                  KIND_ICONS as Record<string, LucideIcon | undefined>
                )[b.kind]
                return (
                  <li key={b.fromId}>
                    <Link
                      to={
                        b.kind === 'note'
                          ? '/notes/$noteId'
                          : KIND_ROUTES[b.kind]
                      }
                      params={b.kind === 'note' ? { noteId: b.fromId } : {}}
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-ui text-muted-foreground hover:text-foreground"
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

/**
 * Filing, not referencing. Mentioning a space in the body links to it;
 * filing says the note *lives* here, and puts it in the space's top block.
 * Same `entity_space` write a company tag makes — one mechanism per kind.
 */
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
      className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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
      {filed.map((s) => (
        <span
          key={s.id}
          className="group flex h-6 items-center gap-1 rounded-full border border-border pr-1 pl-2 text-xs font-medium text-muted-foreground"
        >
          <Layers className="size-3 shrink-0" strokeWidth={1.75} />
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId: s.id }}
            className="focus-ring rounded hover:text-foreground"
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
            className="focus-ring flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="size-2.5" strokeWidth={2.5} />
          </button>
        </span>
      ))}

      {unfiled.length > 0 ? (
        <select
          aria-label="File this note in a space"
          value=""
          disabled={busy}
          onChange={(e) => {
            if (!e.target.value) return
            const spaceId = e.target.value
            e.target.value = ''
            void run(() =>
              tagIntoSpace({ data: { entityId: noteId, spaceId } }),
            )
          }}
          className="focus-ring h-6 rounded-full border border-dashed border-border bg-transparent px-2 text-xs text-muted-foreground outline-none hover:border-input hover:text-foreground"
        >
          <option value="">+ File in space…</option>
          {unfiled.map((s) => (
            <option key={s.id} value={s.id}>
              {' '.repeat(s.depth * 2)}
              {s.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  )
}
