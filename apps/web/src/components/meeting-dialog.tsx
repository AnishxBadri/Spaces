import { MeetingSheet } from '#/components/meetings/meeting-sheet'
import { Dialog, DialogContent } from '#/components/ui/dialog'

/**
 * The meeting window: the meeting's sheet (`MeetingSheet`) in a dialog.
 * - Opens from `?modal=meeting&id=` over a record or Today, and from a
 *   Meetings row below the page's two-pane width.
 * - The head's close is the one close; the brief starts only from its own
 *   card.
 */
export function MeetingDialog({
  id,
  onOpenChange,
  onChanged,
  onOpenNote,
}: {
  id: string | null
  onOpenChange: (open: boolean) => void
  /** A write landed: the caller re-reads what it shows. */
  onChanged?: () => void
  /** Opens a note in the window over the record, in this window's place. */
  onOpenNote?: ((noteId: string) => void) | undefined
}) {
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent size="note">
        {id === null ? null : (
          <MeetingSheet
            key={id}
            id={id}
            frame="window"
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            onOpenNote={onOpenNote}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
