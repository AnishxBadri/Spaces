import { useLocation, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Twinkle } from '../twinkle'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog'
import { WindowControls } from '../ui/window-controls'
import {
  DOCUMENT_PREVIEW_EVENT,
  documentPreviewRequest,
} from '#/lib/editor/document-preview-event'
import { openFileWindowOf } from '#/lib/modal-search'
import { getFileView } from '#/lib/server-fns'
import type { FileViewData } from './file-head'
import { FileView } from './file-view'
import { useCloseFile, useOpenFile } from './file-window-nav'

/**
 * The file's window, over whatever page its address (`?modal=file&id=`,
 * `&page=`) stands on. The app shell mounts it once, so a file opens over
 * every page; it reads the URL itself because a page's own search schema
 * need not know the key. Back, `Esc`, the scrim and the close all close it.
 */
export function FileWindow() {
  const search = useLocation({ select: (l) => l.search })
  const at = openFileWindowOf(search)
  const close = useCloseFile()
  useFileChipOpens()
  return (
    <Dialog
      open={at !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent size="viewer" className="gap-0 overflow-hidden">
        {at === null ? null : (
          <OpenFile key={at.id} id={at.id} page={at.page} onAsk={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A file chip in a note asks for its file with a bubbling event: the chip
 * renders inside BlockNote's tree, which has no router to navigate with.
 * One listener, here, opens it over whatever page or window the note is in.
 */
function useFileChipOpens() {
  const openFile = useOpenFile()
  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = documentPreviewRequest(event)
      if (request) openFile(request.entityId)
    }
    globalThis.document.addEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    return () => {
      globalThis.document.removeEventListener(DOCUMENT_PREVIEW_EVENT, onRequest)
    }
  }, [openFile])
}

type Loaded =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'failed'; message: string }
  | { state: 'open'; view: FileViewData }

/**
 * The file, read again whenever the router reloads, so a change made from
 * the rail or the head (which invalidates the router) shows here too.
 */
function useFileView(id: string): Loaded {
  const loadedAt = useRouterState({ select: (s) => s.loadedAt })
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    let live = true
    getFileView({ data: { id } }).then(
      (view) => {
        if (live)
          setLoaded(view === null ? { state: 'gone' } : { state: 'open', view })
      },
      (err: unknown) => {
        // A failed refresh keeps the file on screen.
        if (live)
          setLoaded((prev) =>
            prev.state === 'open'
              ? prev
              : {
                  state: 'failed',
                  message:
                    err instanceof Error
                      ? err.message
                      : 'Could not read the file',
                },
          )
      },
    )
    return () => {
      live = false
    }
  }, [id, loadedAt])
  return loaded
}

function OpenFile({
  id,
  page,
  onAsk,
}: {
  id: string
  page: number | null
  onAsk: () => void
}) {
  const loaded = useFileView(id)
  if (loaded.state === 'open')
    return (
      <FileView
        view={loaded.view}
        startPage={page ?? 1}
        container="window"
        onAsk={onAsk}
      />
    )
  if (loaded.state === 'gone')
    return (
      <WindowState
        title="Not found"
        line="It was deleted, or the link is wrong."
      />
    )
  if (loaded.state === 'failed')
    return <WindowState title="Couldn't load" line={loaded.message} />
  return (
    <WindowState title="Opening the file" line="Loading…">
      <Twinkle size={29} />
    </WindowState>
  )
}

/** A window with no file in it yet, or none to show: its title and the close. */
function WindowState({
  title,
  line,
  children,
}: {
  title: string
  line: string
  children?: ReactNode
}) {
  return (
    <>
      <div className="flex h-24 shrink-0 items-center gap-3 border-b border-hairline bg-paper px-6">
        <DialogTitle className="min-w-0 flex-1 truncate font-serif text-page font-semibold">
          {title}
        </DialogTitle>
        <WindowControls />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-bone text-ui text-graphite">
        {children}
        <DialogDescription>{line}</DialogDescription>
      </div>
    </>
  )
}
