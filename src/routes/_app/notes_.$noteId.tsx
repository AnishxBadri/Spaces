import {
  ClientOnly,
  createFileRoute,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeft, Layers, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { KIND_ICONS, KIND_ROUTES } from '#/components/editor/mention'
import {
  getNote,
  listSpaces,
  listTermsForNote,
  saveNote,
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
    timer.current = setTimeout(flush, 800)
  }, [flush])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className="mx-auto max-w-[72ch] px-6 py-8 md:px-10">
      <div className="flex items-center justify-between">
        <Link
          to="/notes"
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-md"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Notes
        </Link>
        <span
          className="text-xs text-muted-foreground/80"
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
      </div>

      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
          titleRef.current = e.target.value
          scheduleSave()
        }}
        placeholder="Untitled"
        aria-label="Note title"
        className="mt-6 w-full bg-transparent text-[26px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50"
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
              const Icon = KIND_ICONS[b.kind]
              return (
                <li key={b.fromId}>
                  <Link
                    to={
                      b.kind === 'note' ? '/notes/$noteId' : KIND_ROUTES[b.kind]
                    }
                    params={b.kind === 'note' ? { noteId: b.fromId } : {}}
                    className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground hover:text-foreground"
                  >
                    {Icon ? <Icon className="size-3.5" strokeWidth={1.75} /> : null}
                    {b.name}
                  </Link>
                </li>
              )
            })}
          </ul>
        </aside>
      ) : null}
    </div>
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
      {filed.map((s) => (
        <span
          key={s.id}
          className="group flex h-6 items-center gap-1 rounded-full border border-border pl-2 pr-1 text-xs font-medium text-muted-foreground"
        >
          <Layers className="size-3 shrink-0" strokeWidth={1.75} />
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId: s.id }}
            className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
            className="flex size-4 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
            run(() => tagIntoSpace({ data: { entityId: noteId, spaceId } }))
          }}
          className="h-6 rounded-full border border-dashed border-border bg-transparent px-2 text-xs text-muted-foreground outline-none hover:border-input hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
