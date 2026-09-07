import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Building2, CheckSquare, Kanban, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
import { TaskComposer } from '#/components/task-composer'
import { listTasks, setTaskDone } from '#/lib/server-fns'
import { localToday } from '#/lib/tasks/parse-due'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/tasks')({
  loader: () => listTasks({ data: { includeDone: true } }),
  component: TasksPage,
})

type TaskRow = Awaited<ReturnType<typeof listTasks>>['open'][number]

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
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    }
  }

  return (
    <div className="mx-auto w-full max-w-column px-6 py-8 md:px-10">
      <header>
        <h1 className="text-page font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-ui text-muted-foreground">
          Follow-ups with dates attached — what resurfaces parked deals and
          keeps diligence moving.
        </p>
      </header>

      {/* The one way to add things, everywhere: a composer bar, not a corner
          button. Opens the same TaskComposer dialog. Hidden when empty — the
          empty state carries its own composer action. */}
      {data.open.length === 0 && data.done.length === 0 ? null : (
        <TaskComposer
          trigger={
            <button className="mt-5 flex h-9 w-full items-center gap-2 rounded-md border border-input px-3 text-left text-ui text-muted-foreground focus-ring transition-colors duration-150 ease-out-quart hover:border-border hover:bg-accent">
              <Plus className="size-3.5 shrink-0" strokeWidth={2} />
              Add a task — "chase data room Friday", "revisit after their
              raise"…
            </button>
          }
        />
      )}

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
                <span className="tabular ml-2 font-normal">
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
                className="rounded text-label font-semibold tracking-wide text-muted-foreground uppercase focus-ring"
                onClick={() => setShowDone((s) => !s)}
              >
                Done {showDone ? '▾' : '▸'}
                <span className="tabular ml-2 font-normal">
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
    // The row reads check → what → where → when: entity chips sit inline
    // after the content; the date holds the right lane alone.
    <li className="flex h-10 items-center gap-3 px-4">
      <input
        type="checkbox"
        className="accent-primary"
        checked={!!done}
        onChange={onToggle}
        aria-label={done ? 'Reopen task' : 'Complete task'}
      />
      <span className={cn('truncate text-ui', done && 'line-through')}>
        {t.content}
      </span>
      {t.entities.map((e) => {
        const path = entityPath(e.kind, e.id)
        const Icon = ENTITY_ICONS[e.kind] ?? Building2
        const chip = (
          <>
            <Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
            {e.name}
          </>
        )
        // Kinds without a record page (organizations) stay plain chips —
        // a wrong-kind route is worse than no link.
        return path ? (
          <Link
            key={e.id}
            to={path}
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-micro font-medium focus-ring hover:bg-selected"
          >
            {chip}
          </Link>
        ) : (
          <span
            key={e.id}
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground"
          >
            {chip}
          </span>
        )
      })}
      <span className="ml-auto flex shrink-0 items-baseline gap-3">
        <span className="text-label text-muted-foreground">
          {t.assigneeName}
        </span>
        {t.dueDate ? (
          <span
            className={cn(
              'tabular text-label',
              overdue ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {t.dueDate}
          </span>
        ) : null}
      </span>
    </li>
  )
}

const ENTITY_ICONS: Record<string, typeof Users> = {
  person: Users,
  company: Building2,
  deal: Kanban,
}

function entityPath(kind: string, id: string): string | null {
  switch (kind) {
    case 'company':
      return `/companies/${id}`
    case 'person':
      return `/people/${id}`
    case 'deal':
      return `/deals/${id}`
    default:
      return null
  }
}
