import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { DueField, MemberList } from '#/components/task-composer'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { MENU_RULE } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { recordPath } from '#/lib/record-path'
import { deleteTask, setTaskAssignee, setTaskDue } from '#/lib/server-fns'

/** What a task row's `···` reads off its task. */
export type MenuTask = {
  id: string
  content: string
  dueDate: string | null
  assigneeId: string
  entities: ReadonlyArray<{
    id: string
    name: string
    kind: string
    objectSlug: string | null
  }>
}

/** Which window a row's `···` opened, and on which task. */
type Editing = { kind: 'due' | 'assign'; task: MenuTask } | null

/**
 * A task row's `···`, wherever a task is a row: `Open <record>` · `Due
 * date…` · `Assign…` · `Copy link` · rule · `Delete task`. Returns the
 * entries for a row and the windows they open, which the caller mounts once.
 * - Delete confirms first; `onDelete` takes over after the yes (a list that
 *   fades the row out first), else the task is deleted at once.
 */
export function useTaskMenu({
  me,
  today,
  onDelete,
}: {
  me: { id: string; name: string }
  today: string
  onDelete?: ((task: MenuTask) => void) | undefined
}): {
  menuFor: (task: MenuTask) => Array<MoreMenuEntry>
  windows: ReactNode
} {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [editing, setEditing] = useState<Editing>(null)

  async function erase(t: MenuTask) {
    try {
      await deleteTask({ data: { id: t.id } })
      void router.invalidate()
    } catch {
      toast.error('Could not delete the task')
    }
  }

  async function remove(t: MenuTask) {
    const ok = await confirm({
      title: 'Delete this task?',
      body: `"${t.content}" leaves the workspace. This cannot be undone.`,
      action: 'Delete',
    })
    if (!ok) return
    if (onDelete) onDelete(t)
    else void erase(t)
  }

  async function edit(run: () => Promise<unknown>, failed: string) {
    setEditing(null)
    try {
      await run()
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : failed)
    }
  }

  function menuFor(t: MenuTask): Array<MoreMenuEntry> {
    const first = t.entities.at(0)
    const path = first === undefined ? null : recordPath(first)
    return [
      ...(first !== undefined && path !== null
        ? [
            {
              label: `Open ${first.name}`,
              onSelect: () => void router.navigate({ to: path }),
            },
          ]
        : []),
      {
        label: 'Due date…',
        opens: true,
        onSelect: () => setEditing({ kind: 'due', task: t }),
      },
      {
        label: 'Assign…',
        opens: true,
        onSelect: () => setEditing({ kind: 'assign', task: t }),
      },
      {
        label: 'Copy link',
        copy: () => `${window.location.origin}/tasks?task=${t.id}`,
      },
      MENU_RULE,
      {
        label: 'Delete task',
        destructive: true,
        opens: true,
        onSelect: () => void remove(t),
      },
    ]
  }

  const windows = (
    <>
      <EditWindow
        editing={editing}
        today={today}
        me={me}
        onClose={() => setEditing(null)}
        onDue={(t, dueDate) =>
          void edit(
            () => setTaskDue({ data: { id: t.id, dueDate } }),
            'Could not set the due date',
          )
        }
        onAssign={(t, assigneeId) =>
          void edit(
            () => setTaskAssignee({ data: { id: t.id, assigneeId } }),
            'Could not assign the task',
          )
        }
      />
      {confirmDialog}
    </>
  )
  return { menuFor, windows }
}

/** A row's `Due date…` and `Assign…` windows. */
function EditWindow({
  editing,
  today,
  me,
  onClose,
  onDue,
  onAssign,
}: {
  editing: Editing
  today: string
  me: { id: string; name: string }
  onClose: () => void
  onDue: (t: MenuTask, dueDate: string | null) => void
  onAssign: (t: MenuTask, assigneeId: string) => void
}) {
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {editing?.kind === 'assign' ? 'Assign' : 'Due date'}
          </DialogTitle>
        </DialogHeader>
        {editing === null ? null : editing.kind === 'due' ? (
          <DueField
            due={editing.task.dueDate}
            today={today}
            onPick={(d) => onDue(editing.task, d)}
          />
        ) : (
          <MemberList
            selected={editing.task.assigneeId}
            me={me}
            onPick={(u) => onAssign(editing.task, u.id)}
          />
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
