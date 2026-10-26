import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TaskComposer } from './task-composer'
import { Band, EmptyRow } from './ledger-section'
import { RailSection } from './record/record-parts'
import { Checkbox } from './ui/checkbox'
import { listEntityTasks, setTaskDone } from '#/lib/server-fns'
import { formatDue } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

type OpenTask = {
  id: string
  content: string
  dueDate: string | null
  assigneeName: string
}

/**
 * A record's open tasks, fetched where they are drawn so record routes don't
 * each grow a loader dependency. `tasks` is null until the first answer.
 */
function useEntityTasks(entityId: string) {
  const [tasks, setTasks] = useState<Array<OpenTask> | null>(null)

  const load = useCallback(async () => {
    try {
      setTasks(await listEntityTasks({ data: { entityId } }))
    } catch {
      setTasks([])
    }
  }, [entityId])

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

  return { tasks, load, complete }
}

/** The `/tasks` list narrowed to one record: an Overview band's way out. */
export function recordTasksHref(entityId: string): string {
  return `/tasks?record=${encodeURIComponent(entityId)}`
}

/**
 * A record Overview's Tasks group: `TASKS … All tasks ›` on a band, a 40px
 * row per open task (a 14px checkbox, the task in ink, its due day in a
 * 72px mono lane, crimson once overdue), then `+ Add a task…` with `T` in
 * its end lane. With nothing open it is the one `Tasks +` row, which `T`
 * opens as well.
 */
export function TasksBand({
  entityId,
  entityName,
  entityKind,
}: {
  entityId: string
  entityName: string
  entityKind: string
}) {
  const { tasks, load, complete } = useEntityTasks(entityId)
  const { today } = useClock()
  const preset = { id: entityId, name: entityName, kind: entityKind }

  if (tasks === null) return null
  if (tasks.length === 0)
    return (
      <TaskComposer
        presetEntity={preset}
        onCreated={() => void load()}
        hotkey="t"
        trigger={<EmptyRow name="Tasks" />}
      />
    )

  return (
    <section aria-label="Tasks" className="flex flex-col">
      <Band
        label="Tasks"
        link={
          // A plain link: `/tasks` reads `?record=` on its own.
          <a
            href={recordTasksHref(entityId)}
            className="focus-ring hover:text-foreground"
          >
            All tasks ›
          </a>
        }
      />
      <ol>
        {tasks.map((t) => {
          const overdue = t.dueDate !== null && t.dueDate < today
          return (
            <li
              key={t.id}
              data-task={t.id}
              className="flex h-ledger-row items-center gap-3 border-b border-rule px-3"
            >
              <Checkbox
                checked={false}
                onCheckedChange={() => void complete(t.id)}
                aria-label={`Complete: ${t.content}`}
              />
              <span className="min-w-0 flex-1 truncate text-body text-foreground">
                {t.content}
              </span>
              <span
                data-due
                className={cn(
                  'w-18 shrink-0 text-right mono text-micro',
                  overdue ? 'text-destructive' : 'text-graphite',
                )}
              >
                {t.dueDate === null ? '' : formatDue(t.dueDate, today)}
              </span>
            </li>
          )
        })}
      </ol>
      <TaskComposer
        presetEntity={preset}
        onCreated={() => void load()}
        hotkey="t"
        trigger={
          // A plain button: the dialog trigger hands its props to it.
          <button
            type="button"
            className="focus-ring-inset flex h-ledger-row w-full min-w-0 items-center gap-3 border-b border-rule px-3 text-left text-ui text-graphite transition-colors hover:text-foreground"
          >
            <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
              +
            </span>
            <span className="min-w-0 flex-1 truncate">Add a task…</span>
            <kbd className="w-18 shrink-0 text-right mono text-micro">T</kbd>
          </button>
        }
      />
    </section>
  )
}

/**
 * Open tasks in a space's rail, ending on a `+ Add a task…` row that `T`
 * opens. Record pages carry theirs in Overview (`TasksBand`).
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
  const { tasks, load, complete } = useEntityTasks(entityId)
  const { today } = useClock()
  const preset = { id: entityId, name: entityName, kind: entityKind }

  if (tasks !== null && tasks.length === 0)
    return (
      <RailSection label="Tasks" empty>
        <TaskComposer
          presetEntity={preset}
          onCreated={() => void load()}
          hotkey="t"
          trigger={<EmptyRow name="Tasks" />}
        />
      </RailSection>
    )

  return (
    <RailSection
      label="Tasks"
      meta={tasks ? <span>{tasks.length} open</span> : null}
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
                onCheckedChange={() => void complete(t.id)}
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
                  {formatDue(t.dueDate, today)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <TaskComposer
        presetEntity={preset}
        onCreated={() => void load()}
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
    </RailSection>
  )
}
