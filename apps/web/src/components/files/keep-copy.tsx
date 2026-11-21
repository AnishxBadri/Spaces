import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { icon } from '#/components/icons'
import type { MoreMenuAction } from '../ui/more-menu'
import { keepDocumentCopy } from '#/lib/server-fns'
import type { RemoteBytes } from '#/lib/documents/files-tab'

/**
 * Keep a copy: an email attachment whose file is still in the
 * mailbox, stored here from then on. One hook and one menu item, so a row's
 * `···`, a thread card's `···` and the viewer's Source line say and do the
 * same thing.
 */

export type KeepCopy = {
  /** True while a copy is being fetched. */
  readonly busy: boolean
  /** Fetches and stores the file; false when it was refused (the toast says why). */
  readonly keep: (documentId: string) => Promise<boolean>
}

export function useKeepCopy(): KeepCopy {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function keep(documentId: string): Promise<boolean> {
    setBusy(true)
    try {
      await keepDocumentCopy({ data: { documentId } })
      toast.success('Copy kept')
      await router.invalidate()
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not keep a copy')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, keep }
}

/** Whether a file offers Keep a copy: its file is in a mailbox that still answers. */
export function offersKeepCopy(doc: {
  readonly remoteBytes?: RemoteBytes
}): boolean {
  return doc.remoteBytes === 'linked'
}

/**
 * `Keep a copy` for a `···`, or none when the file is not in a reachable
 * mailbox. Spread it into the menu's items.
 */
export function keepCopyItems(
  doc: { readonly id: string; readonly remoteBytes?: RemoteBytes },
  keeper: KeepCopy,
): Array<MoreMenuAction> {
  if (!offersKeepCopy(doc)) return []
  return [
    {
      label: keeper.busy ? 'Keeping a copy…' : 'Keep a copy',
      icon: <icon.keep />,
      disabled: keeper.busy,
      onSelect: () => void keeper.keep(doc.id),
    },
  ]
}
