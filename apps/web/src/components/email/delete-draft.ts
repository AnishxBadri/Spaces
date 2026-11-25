import type { ReactNode } from 'react'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { useDraftsChanged } from '#/lib/email/compose'
import { deleteEmailDraft } from '#/lib/server-fns'

/**
 * `Delete draft…`, from the composer's `···` or a Drafts row: one confirm,
 * then the row goes and the drafts count follows. A refused delete throws to
 * the caller, which says so where it stands.
 */
export function useDeleteDraft(): {
  /**
   * Asks, then deletes `id`; false when the reader kept it. `settle` runs
   * between the two, so a pending save cannot land after the delete.
   */
  deleteDraft: (id: string, settle?: () => Promise<void>) => Promise<boolean>
  confirmDialog: ReactNode
} {
  const { confirm, confirmDialog } = useConfirm()
  const draftsChanged = useDraftsChanged()
  async function deleteDraft(id: string, settle?: () => Promise<void>) {
    const sure = await confirm({
      title: 'Delete this draft?',
      note: "Can't be undone",
      action: 'Delete',
      kind: 'destructive',
    })
    if (!sure) return false
    await settle?.()
    await deleteEmailDraft({ data: { id } })
    draftsChanged()
    return true
  }
  return { deleteDraft, confirmDialog }
}
