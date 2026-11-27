import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { FileUnderPanel } from './file-under'
import type { RecordDocument } from './types'

/**
 * File under… from a row's `···`: the rail's popover in a window, ticks
 * and all. Filing by hand keeps an email attachment's file, so the row
 * leaves the `From email` band for its kind's.
 */
export function FileOnDialog({
  doc,
  open,
  onOpenChange,
}: {
  doc: Pick<RecordDocument, 'id' | 'filename'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s">
        <DialogHeader>
          <DialogTitle>File under…</DialogTitle>
          <DialogDescription className="min-w-0 truncate">
            {doc.filename}
          </DialogDescription>
        </DialogHeader>
        <div className="border border-hairline">
          {open ? <FileUnderPanel documentId={doc.id} /> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
