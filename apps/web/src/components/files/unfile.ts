import { toast } from 'sonner'
import type { FilingTarget } from '#/lib/documents/file-under-writes'
import { fileDocument, unfileDocument } from '#/lib/server-fns'

/**
 * `Unfile from <name>`, wherever it is offered: no dialog, the filing goes,
 * and the toast's Undo files it again through the same write as any filing,
 * so a Gmail-held file keeps its copy. Unfiling the last filing leaves the
 * file Unfiled; it never deletes it. False when the unfile was refused,
 * which is toasted here.
 */
export async function unfileWithUndo(input: {
  documentId: string
  target: FilingTarget
  /** The record or space, as the toast names it. */
  name: string
  /** Reads the lists again: the router's invalidate. */
  refresh: () => Promise<void>
}): Promise<boolean> {
  const { documentId, target, name, refresh } = input
  try {
    await unfileDocument({ data: { documentId, target } })
    await refresh()
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not unfile it')
    return false
  }
  toast(`Unfiled from ${name}`, {
    action: {
      label: 'Undo',
      onClick: () =>
        void fileDocument({ data: { documentId, target } })
          .then(refresh)
          .catch((err: unknown) => {
            toast.error(
              err instanceof Error ? err.message : 'Could not file it',
            )
          }),
    },
  })
  return true
}
