import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { DitherNoun } from '#/components/dither-noun'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { removalFacts, removalRows } from '#/lib/meetings/removal'
import type { MeetingRemoval, RemovalRecord } from '#/lib/meetings/removal'
import { removeMeeting } from '#/lib/server-fns'

/** The meetings noun, cropped to the confirm's 120×98 panel, in crimson. */
const DRAWING = (
  <DitherNoun
    kind="meetings"
    tone="destructive"
    crop={{ x: 24, y: 14, width: 120, height: 98 }}
  />
)

/** The meeting as the confirm reads it. */
export type RemovableMeeting = {
  id: string
  title: string | null
  startsAt: string
  endsAt: string
  records: ReadonlyArray<RemovalRecord>
  /** It has ended: the list names its write-up and tasks, which stay. */
  over: boolean
  writeUp: boolean
  removal: MeetingRemoval
}

/**
 * `Remove from Spaces…` from a meeting's `···`: the drawn confirm (a series
 * asks which, `This meeting` first), then the remove. A refused or failed
 * remove says why in an error toast.
 */
export function useRemoveMeeting(): {
  /** Asks, then removes; false when the reader kept it or it failed. */
  remove: (m: RemovableMeeting, today: string) => Promise<boolean>
  removeDialog: ReactNode
} {
  const { confirm, confirmDialog } = useConfirm()
  const remove = useCallback(
    async (m: RemovableMeeting, today: string) => {
      // Read once confirmed; a narrowed `let` would not see the pick.
      const picked: { scope: 'meeting' | 'series' } = { scope: 'meeting' }
      const sure = await confirm({
        title: 'Remove from Spaces?',
        subject: {
          name: m.title ?? 'Meeting',
          facts: removalFacts(m, m.removal.series, today),
        },
        ...(m.removal.series
          ? {
              choices: {
                label: 'What to remove',
                items: [
                  { value: 'meeting', label: 'This meeting' },
                  { value: 'series', label: 'The whole series' },
                ],
                onChange: (value: string) => {
                  picked.scope = value === 'series' ? 'series' : 'meeting'
                },
              },
            }
          : {}),
        rows: removalRows({
          records: m.records,
          over: m.over,
          writeUp: m.writeUp,
          tasks: m.removal.tasks,
        }),
        note: 'Stays in Google Calendar',
        action: 'Remove',
        drawing: DRAWING,
      })
      if (!sure) return false
      try {
        const { scope } = picked
        await removeMeeting({ data: { id: m.id, scope } })
        toast(
          scope === 'series'
            ? 'Series removed from Spaces'
            : 'Removed from Spaces',
        )
        return true
      } catch (err) {
        toast.error(
          err instanceof Error && err.message !== ''
            ? err.message
            : 'Could not remove the meeting',
        )
        return false
      }
    },
    [confirm],
  )
  return { remove, removeDialog: confirmDialog }
}
