import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TaskComposer } from './task-composer'
import { RailEmpty, RailSection } from './record/record-parts'
import { listEntityTasks, setTaskDone } from '#/lib/server-fns'
import { localToday } from '#/lib/tasks/parse-due'
import { cn } from '#/lib/utils'

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
      void load()
    } catch {
      toast.error('Could not complete the task')
    }
  }

  const today = localToday()

  return (
    <RailSection
      label="Tasks"
      meta={
        <>
          {tasks ? <span>{tasks.length} open</span> : null}
          <TaskComposer
            presetEntity={{ id: entityId, name: entityName, kind: entityKind }}
            onCreated={load}
            trigger={
              <button className="focus-ring mono text-micro text-primary hover:underline">
                + add
              </button>
            }
          />
        </>
      }
    >
      {tasks === null ? null : tasks.length === 0 ? (
        <RailEmpty>None open.</RailEmpty>
      ) : (
        <ol>
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex h-row items-center gap-3 border-t border-rule"
            >
              <input
                type="checkbox"
                className="focus-ring size-3.5 shrink-0 appearance-none border border-hairline bg-paper checked:bg-primary"
                checked={false}
                onChange={() => complete(t.id)}
                aria-label={`Complete: ${t.content}`}
              />
              <span className="min-w-0 flex-1 truncate text-ui">
                {t.content}
              </span>
              {t.dueDate ? (
                <span
                  className={cn(
                    'shrink-0 mono text-micro',
                    t.dueDate < today ? 'text-destructive' : 'text-graphite',
                  )}
                >
                  {t.dueDate}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </RailSection>
  )
}
