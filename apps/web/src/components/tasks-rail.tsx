import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TaskComposer } from './task-composer'
import { EmptyRow } from './ledger-section'
import { RailSection } from './record/record-parts'
import { Checkbox } from './ui/checkbox'
import { listEntityTasks, setTaskDone } from '#/lib/server-fns'
import { localToday } from '@spaces/core/tasks/parse-due'
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
 * - `composer="row"` ends the list on a `+ Add a task…` row that `T` opens,
 *   for a page whose head has no Task button.
 */
export function TasksRail({
  entityId,
  entityName,
  entityKind,
  composer = 'meta',
}: {
  entityId: string
  entityName: string
  entityKind: string
  composer?: 'meta' | 'row' | undefined
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

  if (tasks !== null && tasks.length === 0)
    return (
      <RailSection label="Tasks" empty>
        <TaskComposer
          presetEntity={{ id: entityId, name: entityName, kind: entityKind }}
          onCreated={load}
          {...(composer === 'row' ? { hotkey: 't' } : {})}
          trigger={<EmptyRow name="Tasks" />}
        />
      </RailSection>
    )

  return (
    <RailSection
      label="Tasks"
      meta={
        <>
          {tasks ? <span>{tasks.length} open</span> : null}
          {composer === 'meta' ? (
            <TaskComposer
              presetEntity={{
                id: entityId,
                name: entityName,
                kind: entityKind,
              }}
              onCreated={load}
              trigger={
                <button className="focus-ring mono text-micro text-primary hover:underline">
                  + add
                </button>
              }
            />
          ) : null}
        </>
      }
    >
      {tasks === null ? null : (
        <ol>
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex h-row items-center gap-3 border-t border-rule"
            >
              <Checkbox
                checked={false}
                onCheckedChange={() => complete(t.id)}
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
      {composer === 'row' ? (
        <TaskComposer
          presetEntity={{ id: entityId, name: entityName, kind: entityKind }}
          onCreated={load}
          hotkey="t"
          trigger={
            // A plain button: the dialog trigger hands its props to it.
            <button
              type="button"
              className="focus-ring flex h-row w-full min-w-0 items-center gap-2.5 border-t border-rule text-left text-ui text-graphite transition-colors hover:text-foreground"
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate">Add a task…</span>
              <kbd className="shrink-0 mono text-micro">T</kbd>
            </button>
          }
        />
      ) : null}
    </RailSection>
  )
}
