import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { TaskComposer } from './task-composer'
import { listEntityTasks, setTaskDone } from '#/lib/server-fns'
import { fmtDate } from '#/lib/portfolio/format'
import { localToday } from '#/lib/tasks/parse-due'

type RailTask = {
  id: string
  content: string
  dueDate: string | null
  assigneeName: string
}

/**
 * Open tasks on a record page — the rail that makes "revisit when their
 * round closes" show up where the judgment happens. Self-contained fetch
 * so record routes don't each grow a loader dependency.
 */
export function TasksRail({
  entityId,
  entityName,
  entityKind,
}: {
  entityId: string
  entityName: string
  entityKind: string
}) {
  const [tasks, setTasks] = useState<Array<RailTask> | null>(null)

  async function load() {
    try {
      setTasks(await listEntityTasks({ data: { entityId } }))
    } catch {
      setTasks([])
    }
  }

  useEffect(() => {
    let alive = true
    listEntityTasks({ data: { entityId } })
      .then((t) => {
        if (alive) setTasks(t)
      })
      .catch(() => {
        if (alive) setTasks([])
      })
    return () => {
      alive = false
    }
  }, [entityId])

  async function complete(id: string) {
    try {
      await setTaskDone({ data: { id, done: true } })
      load()
    } catch {
      toast.error('Could not complete the task')
    }
  }

  const today = localToday()

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Tasks</span>
        <TaskComposer
          presetEntity={{ id: entityId, name: entityName, kind: entityKind }}
          onCreated={load}
          trigger={
            <button className="focus-ring flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground">
              <Plus className="size-3" strokeWidth={2} />
              Add
            </button>
          }
        />
      </div>
      {tasks === null ? null : tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">None open.</p>
      ) : (
        <ol className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-baseline gap-2">
              <input
                type="checkbox"
                className="accent-primary translate-y-0.5"
                checked={false}
                onChange={() => complete(t.id)}
                aria-label={`Complete: ${t.content}`}
              />
              <span className="min-w-0 flex-1 truncate text-ui">
                {t.content}
              </span>
              {t.dueDate ? (
                <span
                  className={
                    t.dueDate < today
                      ? 'text-label text-destructive'
                      : 'text-label text-muted-foreground'
                  }
                >
                  {fmtDate(t.dueDate)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
