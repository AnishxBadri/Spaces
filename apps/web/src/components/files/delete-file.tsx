import { useRouter } from '@tanstack/react-router'
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { DitherNoun } from '../dither-noun'
import { useConfirm } from '../ui/confirm-dialog'
import { filingKindWord } from './viewer-sidebar'
import type { FileViewData } from './file-head'
import type { RecordDocument } from './types'
import { deleteFileWords, filingKind } from '#/lib/documents/delete-confirm'
import type { DeletableFile } from '#/lib/documents/delete-confirm'
import { deleteDocument } from '#/lib/server-fns'

/**
 * `Delete…` on a file, from any `···` that offers it: the drawn confirm,
 * then the row leaves at once and the delete runs behind it. A refused or
 * failed delete brings the row back with the reason as an error toast.
 */

/** The files whose delete is in flight: every list leaves them out. */
let deleting: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const NONE: ReadonlySet<string> = new Set()

function setDeleting(id: string, on: boolean) {
  const next = new Set(deleting)
  if (on) next.add(id)
  else next.delete(id)
  deleting = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The ids being deleted right now; a list hides these rows. */
export function useDeletingFiles(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => deleting,
    () => NONE,
  )
}

/**
 * A Files-tab row as the confirm reads it. A followed file's revisions go
 * with it; a file a folder binding filed (no follow of its own) came from
 * a synced folder.
 */
export function deletableRow(
  doc: Pick<
    RecordDocument,
    | 'id'
    | 'filename'
    | 'mime'
    | 'externalUrl'
    | 'sizeBytes'
    | 'sourceCapability'
    | 'sourcePath'
    | 'bindingId'
    | 'follow'
    | 'filedIn'
  >,
): DeletableFile {
  return {
    id: doc.id,
    filename: doc.filename,
    mime: doc.mime,
    externalUrl: doc.externalUrl,
    sizeBytes: doc.sizeBytes,
    sourceCapability: doc.sourceCapability,
    sourcePath: doc.sourcePath,
    inSyncedFolder: doc.bindingId !== null && doc.follow === null,
    versions: doc.follow?.revisions ?? 1,
    filings: doc.filedIn.map((e) => ({ name: e.name, kind: filingKind(e) })),
  }
}

/** The open viewer as the confirm reads it: a space with its path. */
export function deletableView(view: FileViewData): DeletableFile {
  return {
    ...deletableRow(view.doc),
    filings: view.filings.map((o) => ({
      name: [...o.parents, o.name].join(' › '),
      kind: filingKindWord(o),
    })),
  }
}

/** The files noun, cropped to the confirm's 120×98 panel, in crimson. */
const DRAWING = (
  <DitherNoun
    kind="files"
    tone="destructive"
    crop={{ x: 24, y: 14, width: 120, height: 98 }}
  />
)

export function useDeleteFile(): {
  /**
   * Asks, then deletes; false when the reader kept it. `onGone` runs the
   * moment they confirm, before the server answers: the viewer closes there.
   */
  deleteFile: (file: DeletableFile, onGone?: () => void) => Promise<boolean>
  deleteDialog: ReactNode
} {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const deleteFile = useCallback(
    async (file: DeletableFile, onGone?: () => void) => {
      const words = deleteFileWords(file)
      const sure = await confirm({
        title: 'Delete this file?',
        subject: { name: words.name, facts: words.facts },
        rows: words.rows,
        note: words.note,
        action: 'Delete file',
        drawing: DRAWING,
      })
      if (!sure) return false
      onGone?.()
      setDeleting(file.id, true)
      try {
        await deleteDocument({ data: { id: file.id } })
        // The row stays hidden until the lists have read it gone.
        await router.invalidate()
        toast(`Deleted ${file.filename}`)
        return true
      } catch (err) {
        toast.error(
          err instanceof Error && err.message !== ''
            ? err.message
            : 'Could not delete this file',
        )
        return false
      } finally {
        setDeleting(file.id, false)
      }
    },
    [confirm, router],
  )
  return { deleteFile, deleteDialog: confirmDialog }
}
