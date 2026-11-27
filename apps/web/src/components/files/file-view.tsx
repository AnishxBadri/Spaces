import { FileBody } from '../document-preview'
import { useAskSubject } from '#/lib/ask/page-scope'
import { FileHead, fileChip } from './file-head'
import type { FileViewData } from './file-head'
import { FileViewerSidebar } from './viewer-sidebar'

/**
 * One file, as its window and its page show it: the head, then the body
 * with its tool bar beside the rail. The container around it is the
 * caller's: `FileWindow` or the `/files/<id>` route.
 */
export function FileView({
  view,
  startPage,
  container,
  onAsk,
}: {
  view: FileViewData
  /** The 1-based page a PDF opens at. */
  startPage: number
  container: 'window' | 'page'
  /** After Ask opens on the file. */
  onAsk?: () => void
}) {
  const { doc } = view
  // An open file is Ask's default chip while it is on screen.
  useAskSubject(fileChip(doc))
  return (
    <>
      <FileHead
        view={view}
        container={container}
        {...(onAsk === undefined ? {} : { onAsk })}
      />
      <div className="flex min-h-0 flex-1">
        <FileBody key={doc.id} doc={doc} startPage={startPage} />
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-rule bg-bone">
          <FileViewerSidebar view={view} container={container} />
        </aside>
      </div>
    </>
  )
}
