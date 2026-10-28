import { Link, useLocation } from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '#/components/ui/button'
import {
  DOCK_MAX,
  DOCK_MIN,
  addMention,
  clearPageChip,
  clearWeb,
  closeAsk,
  removeMention,
  setDockThread,
  setDockWidth,
  takeDraft,
  useAskDock,
} from '#/lib/ask/dock-store'
import {
  chipKey,
  dockScope,
  pageScope,
  usePageSubject,
  withWeb,
} from '#/lib/ask/page-scope'
import { useWebSources } from '#/lib/ask/web-sources'
import type { AskScopeChip } from '#/lib/ask/types'
import { usePageActionsList } from '#/lib/page-actions'
import { AskComposer, AskTurns, SaveAsNote, useAskThread } from './ask-thread'

/**
 * Ask docked: a third column right of the page, the page usable beside it.
 * - 408px by default, resized from its left edge between 360 and 560px;
 *   ⌘J or × closes it completely, leaving no rail, and the thread is kept.
 * - The page you are on is the default scope chip — a record, a space, a
 *   saved view or an open file; `@` adds more. The chips sit inside the
 *   composer, every one removable; with none nothing prints and the
 *   question reads the whole workspace.
 */

/** The page's own chip: a view or file it published, else its record or space. */
export function usePageChip(): AskScopeChip | null {
  const { pathname } = useLocation()
  const { scope: name } = usePageActionsList()
  const subject = usePageSubject()
  return subject ?? pageScope(pathname, name)
}

/** The scope a question here is asked in; the web while a plugin can mount. */
export function useDockScope(): ReadonlyArray<AskScopeChip> {
  const page = usePageChip()
  const { cleared, mentioned, web } = useAskDock()
  const sources = useWebSources()
  return withWeb(dockScope(page, cleared, mentioned), web, sources.length > 0)
}

/** The left edge: drag or arrow keys resize, and a tag prints the width while dragging. */
function ResizeEdge({ width }: { width: number }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <>
      {dragging ? (
        <span
          data-width-tag
          className="absolute top-14 -left-2 z-sticky -translate-x-full border border-rule bg-paper px-1.5 py-0.5 mono text-micro"
        >
          {width}
        </span>
      ) : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Ask"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          start.current = { x: e.clientX, w: width }
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (start.current === null) return
          setDockWidth(start.current.w + (start.current.x - e.clientX))
        }}
        onPointerUp={() => {
          start.current = null
          setDragging(false)
        }}
        onPointerCancel={() => {
          start.current = null
          setDragging(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setDockWidth(width + 16)
          if (e.key === 'ArrowRight') setDockWidth(width - 16)
        }}
        className="focus-ring-inset absolute inset-y-0 -left-1 z-sticky w-2 cursor-col-resize"
      />
    </>
  )
}

export function AskDock() {
  const dock = useAskDock()
  const scope = useDockScope()
  const page = usePageChip()
  const [draft, setDraft] = useState('')
  const { thread, live, error, ask, stop } = useAskThread(dock.threadId, (id) =>
    setDockThread(id),
  )
  const webSources = useWebSources().map((s) => s.name)

  // A held thread that is gone (deleted on /ask) gives way to a new one.
  useEffect(() => {
    if (error !== null && dock.threadId !== null) setDockThread(null)
  }, [error, dock.threadId])
  const body = useRef<HTMLDivElement | null>(null)

  // A door's text lands in the composer once.
  useEffect(() => {
    if (dock.draft !== null) {
      setDraft(dock.draft)
      takeDraft()
    }
  }, [dock.draft])

  // Follow the answer as it arrives.
  const length = (thread?.turns.length ?? 0) + (live?.text.length ?? 0)
  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [length])

  if (!dock.open) return null

  const send = (question: string) => {
    setDraft('')
    void ask(question, scope)
  }

  return (
    <aside
      aria-label="Ask"
      style={{ width: dock.width }}
      className="sticky top-0 hidden h-dvh shrink-0 flex-col self-start border-l border-hairline bg-paper md:flex"
    >
      <ResizeEdge width={dock.width} />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule bg-bone px-4">
        <h2 className="min-w-0 flex-1 truncate text-title font-medium">
          {thread?.title ?? 'Ask'}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New thread"
          title="New thread"
          onClick={() => setDockThread(null)}
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close Ask"
          title="Close (⌘J)"
          onClick={closeAsk}
        >
          <X className="size-4" strokeWidth={1.75} />
        </Button>
      </header>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <AskTurns
          turns={thread?.turns ?? []}
          live={live}
          variant="dock"
          threadId={thread?.id ?? null}
          onRetry={send}
          onStop={stop}
        />
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-rule px-4 py-3">
        <AskComposer
          value={draft}
          onChange={setDraft}
          onSend={() => send(draft.trim())}
          onMention={addMention}
          scope={scope}
          onRemoveChip={(chip) => {
            if (chip.kind === 'web') clearWeb()
            if (page !== null && chipKey(page) === chipKey(chip))
              clearPageChip(chip)
            removeMention(chip)
          }}
          webSources={webSources}
          streaming={live?.phase === 'streaming'}
          focus={dock.focus}
        />
        <div className="flex items-center justify-between gap-3">
          <SaveAsNote thread={thread} />
          <Link
            to="/ask"
            search={thread === null ? {} : { thread: thread.id }}
            className="focus-ring ml-auto text-label text-graphite hover:text-foreground"
          >
            Open in /ask ›
          </Link>
        </div>
      </footer>
    </aside>
  )
}
