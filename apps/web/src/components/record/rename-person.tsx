import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'

/**
 * Rename a person: the name in its two parts, which the write path joins
 * into the record's name. The head's `···` opens it; the rail holds neither
 * part, since the title already says them.
 */
export function RenamePersonDialog({
  open,
  onOpenChange,
  first,
  last,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  first: string
  last: string
  onSave: (name: {
    first_name: string | null
    last_name: string | null
  }) => Promise<void>
}) {
  const [firstDraft, setFirst] = useState(first)
  const [lastDraft, setLast] = useState(last)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Each opening starts from the name as it stands.
  useEffect(() => {
    if (!open) return
    setFirst(first)
    setLast(last)
    setError(null)
  }, [open, first, last])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (firstDraft.trim() === '' && lastDraft.trim() === '') {
      setError('Give a first or a last name.')
      return
    }
    setPending(true)
    try {
      await onSave({
        first_name: firstDraft.trim() || null,
        last_name: lastDraft.trim() || null,
      })
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not rename'
      setError(message)
      toast.error(message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rename-first">First name</Label>
            <Input
              id="rename-first"
              value={firstDraft}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setFirst(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-last">Last name</Label>
            <Input
              id="rename-last"
              value={lastDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setLast(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" pending={pending}>
              {pending ? 'Saving…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
