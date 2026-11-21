import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { FilingPickers } from './viewer-sidebar'
import type { RecordDocument } from './types'
import { fileDocument } from '#/lib/server-fns'

/**
 * File on… from a row's `···`: the viewer's record search and space tree in
 * a window. Filing by hand keeps an email attachment's file, so the
 * row leaves the `From email` band for its kind's.
 */
export function FileOnDialog({
  doc,
  open,
  onOpenChange,
}: {
  doc: Pick<RecordDocument, 'id' | 'filename' | 'filedIn'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function file(target: { kind: 'record' | 'space'; entityId: string }) {
    setBusy(true)
    try {
      await fileDocument({ data: { documentId: doc.id, target } })
      onOpenChange(false)
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s">
        <DialogHeader>
          <DialogTitle>File on…</DialogTitle>
          <DialogDescription className="min-w-0 truncate">
            {doc.filename}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          <FilingPickers
            filedIds={doc.filedIn.map((e) => e.id)}
            disabled={busy}
            onPick={(target) => void file(target)}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
