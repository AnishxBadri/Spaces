import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
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
import { FileGlyph } from './file-glyph'
import type { RecordDocument } from './types'
import { markNewerVersion } from '#/lib/server-fns'
import { fileType } from '#/lib/documents/files-tab'
import { cn } from '#/lib/utils'

/**
 * "Newer version of…": the record's other files of the same kind, one
 * pick, then Mark as newer. Writes one `supersedes` link; nothing is deleted
 * and the older file stays readable and searchable, ranked lower.
 */
export function NewerVersionDialog({
  doc,
  older,
  open,
  onOpenChange,
}: {
  doc: RecordDocument
  /** The files `doc` may replace: same record, same kind, not itself. */
  older: ReadonlyArray<RecordDocument>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setPicked(null)
  }, [open])

  const target = older.find((d) => d.id === picked) ?? null

  async function mark() {
    if (target === null || busy) return
    setBusy(true)
    try {
      await markNewerVersion({
        data: { newerId: doc.id, olderId: target.id },
      })
      onOpenChange(false)
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not mark the newer version',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[27.5rem]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void mark()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Newer version of…</DialogTitle>
          <DialogDescription className="min-w-0 truncate">
            {doc.filename}
          </DialogDescription>
        </DialogHeader>
        <ul
          role="listbox"
          aria-label="Older version"
          className="flex max-h-80 flex-col overflow-y-auto border border-rule"
        >
          {older.map((d) => (
            <li key={d.id} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                role="option"
                aria-selected={d.id === picked}
                onClick={() => setPicked(d.id)}
                className={cn(
                  'focus-ring-inset flex h-ledger-row w-full items-center gap-3 px-2.5 text-left text-label transition-colors hover:bg-bone',
                  d.id === picked && 'bg-bone font-medium',
                )}
              >
                <FileGlyph type={fileType(d)} />
                <span className="min-w-0 flex-1 truncate">{d.filename}</span>
                <span className="shrink-0 mono text-micro text-graphite">
                  {d.createdAt.slice(0, 10)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={target === null || busy}
            onClick={() => void mark()}
          >
            Mark as newer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
