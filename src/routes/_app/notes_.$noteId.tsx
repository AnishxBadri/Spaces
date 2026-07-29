import {
  ClientOnly,
  createFileRoute,
  Link,
} from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deriveMarkdown,
  extractMentionIds,
  NoteEditor,
} from '#/components/editor/note-editor'
import { KIND_ICONS, KIND_ROUTES } from '#/components/editor/mention'
import { getNote, saveNote } from '#/lib/server-fns'

/**
 * The prose register: this page reads like a page, not a dashboard.
 * Serif body, capped measure, quiet chrome.
 */
export const Route = createFileRoute('/_app/notes_/$noteId')({
  loader: ({ params }) => getNote({ data: { id: params.noteId } }),
  component: NotePage,
})

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved'

function NotePage() {
  const initial = Route.useLoaderData()
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

      <div className="prose-note mt-4">
        <ClientOnly fallback={<div className="min-h-40" />}>
          <NoteEditor
            initialContent={initial.bodyJson}
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
