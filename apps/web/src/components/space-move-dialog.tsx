import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
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
import { listSpaces, moveSpace } from '#/lib/server-fns'
import { moveTargets } from '#/lib/spaces/move-targets'
import type { MoveTarget } from '#/lib/spaces/move-targets'
import { cn } from '#/lib/utils'

type Moving = {
  id: string
  name: string
  path: string
  parentId: string | null
}

/**
 * Move to… — a window over the scrim listing the tree, the space and its
 * descendants greyed with the reason and its parent marked "now here". One
 * pick, then Move.
 */
export function SpaceMoveDialog({
  open,
  onOpenChange,
  moving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  moving: Moving
}) {
  const router = useRouter()
  const [tree, setTree] = useState<Awaited<ReturnType<typeof listSpaces>>>([])
  // undefined: nothing picked yet; null: the root.
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setPicked(undefined)
    const live = { current: true }
    void (async () => {
      try {
        const rows = await listSpaces()
        if (live.current) setTree(rows)
      } catch {
        if (live.current) setTree([])
      }
    })()
    return () => {
      live.current = false
    }
  }, [open])

  const rows = moveTargets(tree, moving)
  const target = rows.find(
    (r) => picked !== undefined && r.id === picked && !r.refused && !r.current,
  )

  async function move() {
    if (!target || busy) return
    setBusy(true)
    try {
      await moveSpace({ data: { id: moving.id, parentId: target.id } })
      onOpenChange(false)
      void router.invalidate()
      toast(
        target.id === null
          ? `${moving.name} moved to the root`
          : `${moving.name} moved under ${target.name}`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move')
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
            void move()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Move {moving.name}</DialogTitle>
        </DialogHeader>
        <ul
          role="listbox"
          aria-label="Move to"
          className="flex max-h-80 flex-col overflow-y-auto border border-rule"
        >
          {rows.map((r) => (
            <MoveRow
              key={r.id ?? 'root'}
              row={r}
              picked={picked !== undefined && r.id === picked}
              onPick={() => setPicked(r.id)}
            />
          ))}
        </ul>
        <DialogFooter
          note={
            target
              ? `under ${target.id === null ? 'the root' : target.name}`
              : null
          }
        >
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={!target || busy} onClick={() => void move()}>
            Move
            <kbd className="mono text-micro opacity-85">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MoveRow({
  row,
  picked,
  onPick,
}: {
  row: MoveTarget
  picked: boolean
  onPick: () => void
}) {
  const disabled = row.refused !== null || row.current
  return (
    <li className="border-b border-rule last:border-b-0">
      <button
        type="button"
        role="option"
        aria-selected={picked}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={onPick}
        className={cn(
          'focus-ring-inset flex h-[1.625rem] w-full items-center gap-3 px-2.5 text-left text-label transition-colors',
          disabled ? 'text-graphite' : 'hover:bg-bone',
          picked && 'bg-bone font-medium',
        )}
        style={{ paddingLeft: `${0.625 + row.depth * 0.875}rem` }}
      >
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        {row.refused ? (
          <span className="shrink-0 mono text-micro">{row.refused}</span>
        ) : row.current ? (
          <span className="shrink-0 mono text-micro text-graphite">
            now here
          </span>
        ) : null}
      </button>
    </li>
  )
}
