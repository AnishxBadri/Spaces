import { useEffect, useMemo, useState } from 'react'
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
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import { spacePathLabel } from '#/lib/file-in-space'
import { listSpaces, tagManyIntoSpace, untagFromSpace } from '#/lib/server-fns'

type SpaceRow = Awaited<ReturnType<typeof listSpaces>>[number]

/** What the window adds: the records, and what to call them. */
export type AddTarget = {
  readonly ids: ReadonlyArray<string>
  /** `Flent` for one record from its row; absent, the count and the noun. */
  readonly name?: string | undefined
}

/** `3 companies`, or the one record's name. */
export function targetWords(
  target: AddTarget,
  noun: { one: string; many: string },
  n: number = target.ids.length,
): string {
  if (target.name !== undefined && n === 1) return target.name
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun.one : noun.many}`
}

/**
 * Add to space: one Space field picking from the tree by path, then Add n.
 * Every record goes in one transaction; the toast's Undo untags the ones
 * this call filed, so a record that was already there stays.
 */
export function AddToSpaceDialog({
  open,
  onOpenChange,
  target,
  noun,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: AddTarget
  noun: { one: string; many: string }
  /** After the write and after an Undo: the list clears and refreshes. */
  onAdded: () => void
}) {
  const [spaces, setSpaces] = useState<Array<SpaceRow> | null>(null)
  const [spaceId, setSpaceId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setSpaceId('')
    listSpaces()
      .then((rows) => {
        if (live) setSpaces(rows)
      })
      .catch(() => {
        if (live) setSpaces([])
      })
    return () => {
      live = false
    }
  }, [open])

  const items = useMemo(() => {
    const rows = spaces ?? []
    const byId = new Map(rows.map((r) => [r.id, r]))
    return rows.map((r) => ({ value: r.id, label: spacePathLabel(r, byId) }))
  }, [spaces])
  const chosen = spaces?.find((s) => s.id === spaceId)
  const count = target.ids.length

  async function add() {
    if (chosen === undefined || busy) return
    setBusy(true)
    try {
      const { tagged } = await tagManyIntoSpace({
        data: { spaceId: chosen.id, entityIds: [...target.ids] },
      })
      onOpenChange(false)
      onAdded()
      if (tagged.length === 0) {
        toast(`Already in ${chosen.name}`)
        return
      }
      toast(
        `${targetWords(target, noun, tagged.length)} added to ${chosen.name}`,
        {
          action: {
            label: 'Undo',
            onClick: () =>
              void Promise.all(
                tagged.map((entityId) =>
                  untagFromSpace({ data: { entityId, spaceId: chosen.id } }),
                ),
              )
                .then(onAdded)
                .catch(() => toast.error('Could not undo')),
          },
        },
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="s"
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void add()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add {targetWords(target, noun)} to a space</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-to-space">Space</Label>
          <Select
            id="add-to-space"
            value={spaceId}
            onChange={setSpaceId}
            items={items}
            width="trigger"
            placeholder={spaces === null ? 'Loading…' : 'Pick a space'}
            searchPlaceholder="Search spaces…"
            disabled={spaces === null}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            shortcut="⌘↵"
            disabled={chosen === undefined}
            pending={busy}
            onClick={() => void add()}
          >
            Add {count.toLocaleString('en-US')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
