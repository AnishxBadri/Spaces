import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { CheckSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
import { TaskComposer } from '#/components/task-composer'
import { listTasks, setTaskDone } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/tasks')({
  loader: () => listTasks({ data: { includeDone: true } }),
  component: TasksPage,
})

type TaskRow = Awaited<ReturnType<typeof listTasks>>['open'][number]

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function endOfWeek(today: string): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay() || 7))
  return d.toISOString().slice(0, 10)
}

type Group = { key: string; title: string; tone?: string; rows: Array<TaskRow> }

/** Urgency groups, Attio-style: overdue red, today, this week, later, dateless. */
function groupTasks(open: Array<TaskRow>, today: string): Array<Group> {
  const eow = endOfWeek(today)
  const groups: Array<Group> = [
    { key: 'overdue', title: 'Overdue', tone: 'text-destructive', rows: [] },
    { key: 'today', title: 'Today', rows: [] },
    { key: 'week', title: 'This week', rows: [] },
    { key: 'later', title: 'Later', rows: [] },
    { key: 'nodate', title: 'No date', rows: [] },
  ]
  for (const t of open) {
    if (!t.dueDate) groups[4].rows.push(t)
    else if (t.dueDate < today) groups[0].rows.push(t)
    else if (t.dueDate === today) groups[1].rows.push(t)
    else if (t.dueDate <= eow) groups[2].rows.push(t)
    else groups[3].rows.push(t)
  }
  return groups.filter((g) => g.rows.length > 0)
}

function TasksPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [showDone, setShowDone] = useState(false)
  const today = localToday()
  const groups = groupTasks(data.open, today)

  async function toggle(id: string, done: boolean) {
    try {
      await setTaskDone({ data: { id, done } })
      router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Tasks</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            Follow-ups with dates attached — what resurfaces parked deals and
            keeps diligence moving.
          </p>
        </div>
        <TaskComposer />
      </header>

      {data.open.length === 0 && data.done.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="Nothing to chase yet"
          body={
            'Tasks put dates on judgment calls — "revisit when their round closes", "chase the data room", "re-mark after the bridge". Link them to records so they show up where you work.'
          }
          action={<TaskComposer />}
        />
      ) : (
        <div className="mt-6 space-y-8">
          {groups.map((g) => (
            <section key={g.key}>
              <h2
                className={cn(
                  'mb-2 text-label font-semibold tracking-wide uppercase',
                  g.tone ?? 'text-muted-foreground',
                )}
              >
                {g.title}
                <span className="ml-2 font-normal tabular">
                  {g.rows.length}
                </span>
              </h2>
              <ol className="divide-y divide-border rounded-lg border border-border">
                {g.rows.map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    overdue={g.key === 'overdue'}
                    onToggle={() => toggle(t.id, true)}
                  />
                ))}
              </ol>
            </section>
          ))}

          {data.done.length > 0 ? (
            <section>
              <button
                type="button"
                className="focus-ring rounded text-label font-semibold tracking-wide text-muted-foreground uppercase"
                onClick={() => setShowDone((s) => !s)}
              >
                Done {showDone ? '▾' : '▸'}
                <span className="ml-2 font-normal tabular">
                  {data.done.length}
                </span>
              </button>
              {showDone ? (
                <ol className="mt-2 divide-y divide-border rounded-lg border border-border opacity-60">
                  {data.done.map((t) => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      done
                      onToggle={() => toggle(t.id, false)}
                    />
                  ))}
                </ol>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}

function TaskItem({
  task: t,
  done,
  overdue,
  onToggle,
}: {
  task: TaskRow
  done?: boolean
  overdue?: boolean
  onToggle: () => void
}) {
  return (
    <li className="flex items-baseline gap-3 px-4 py-2.5">
      <input
        type="checkbox"
        className="accent-primary translate-y-0.5"
        checked={!!done}
        onChange={onToggle}
        aria-label={done ? 'Reopen task' : 'Complete task'}
      />
      <span className={cn('text-ui', done && 'line-through')}>{t.content}</span>
      <span className="ml-auto flex shrink-0 items-baseline gap-3">
        {t.entities.map((e) => (
          <Link
            key={e.id}
            to={entityPath(e.kind, e.id)}
            className="focus-ring rounded text-label text-muted-foreground hover:text-foreground"
          >
            {e.name}
          </Link>
        ))}
        {t.dueDate ? (
          <span
            className={cn(
              'text-label tabular',
              overdue ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {t.dueDate}
          </span>
        ) : null}
        <span className="text-label text-muted-foreground">
          {t.assigneeName}
        </span>
      </span>
    </li>
  )
}

function entityPath(kind: string, id: string): string {
  switch (kind) {
    case 'company':
      return `/companies/${id}`
    case 'person':
      return `/people/${id}`
    case 'deal':
      return `/deals/${id}`
    default:
      return `/companies/${id}`
  }
}
