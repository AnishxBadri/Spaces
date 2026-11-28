import { MeetingSheet } from '#/components/meetings/meeting-sheet'
import { Dialog, DialogContent } from '#/components/ui/dialog'

/**
 * The meeting window: the meeting's sheet (`MeetingSheet`) in a dialog.
 * - Opens from `?modal=meeting&id=` over a record or Today, and from a
 *   Meetings row below the page's two-pane width.
 * - Done is the one close; Prep, then Save as note, is the one commit.
 */
export function MeetingDialog({
  id,
  prepOnOpen = false,
  onOpenChange,
  onChanged,
  onPrepRunning,
  onOpenNote,
}: {
  id: string | null
  /** Start Prep once the meeting is read: the row's Prep. */
  prepOnOpen?: boolean
  onOpenChange: (open: boolean) => void
  /** A write landed: the caller re-reads what it shows. */
  onChanged?: () => void
  /** Prep started or stopped, so the row behind can say it is running. */
  onPrepRunning?: (running: boolean) => void
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
            prepOnOpen={prepOnOpen}
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            onPrepRunning={onPrepRunning}
            onOpenNote={onOpenNote}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
