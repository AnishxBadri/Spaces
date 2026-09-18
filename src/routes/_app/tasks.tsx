import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { CheckSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#/components/empty-state'
import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import { PageHeader } from '#/components/page-header'
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

type Group = {
  key: string
  title: string
  tone?: string
  /** The mono note after the count — the group's frame of reference. */
  hint?: string
  rows: Array<TaskRow>
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function weekdayOf(iso: string): string {
  return WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]
}

/** Whole days from today to `iso` — negative when overdue. */
function daysFrom(today: string, iso: string): number {
  return Math.round(
    (new Date(`${iso}T00:00:00Z`).getTime() -
      new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  )
}

/** The when-lane: `09-08 · −2d` overdue, `today`, `Fri 09-12` this week,
 *  the ISO date later, `—` when dateless. */
function whenFigure(due: string | null, today: string, groupKey: string) {
  if (!due) return '—'
  const d = daysFrom(today, due)
  if (d < 0) return `${due.slice(5)} · −${-d}d`
  if (d === 0) return 'today'
  if (groupKey === 'week') return `${weekdayOf(due)} ${due.slice(5)}`
  return due
}

/** Urgency groups, Attio-style: overdue red, today, this week, later, dateless. */
function groupTasks(open: Array<TaskRow>, today: string): Array<Group> {
  const eow = endOfWeek(today)
  const groups: Array<Group> = [
    { key: 'overdue', title: 'Overdue', tone: 'text-destructive', rows: [] },
    {
      key: 'today',
      title: 'Today',
      hint: `${weekdayOf(today)} ${today.slice(5)}`,
      rows: [],
    },
    {
      key: 'week',
      title: 'This week',
      hint: `through ${weekdayOf(eow)} ${eow.slice(5)}`,
      rows: [],
    },
    { key: 'later', title: 'Later', rows: [] },
    { key: 'nodate', title: 'No date', hint: 'dateless is legal', rows: [] },
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

  const overdue = groups.find((g) => g.key === 'overdue')?.rows.length ?? 0
  const dueToday = groups.find((g) => g.key === 'today')?.rows.length ?? 0
  const empty = data.open.length === 0 && data.done.length === 0

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Tasks"
        description={
          <>
            <span>{data.open.length} open</span>
            <span className={overdue > 0 ? 'text-destructive' : undefined}>
              {overdue} overdue
            </span>
            <span>{dueToday} today</span>
            <span>{data.done.length} done</span>
          </>
        }
        action={
          data.done.length > 0 ? (
            <div className="-mb-4 flex items-center" role="group">
              <HeaderTab active={!showDone} onClick={() => setShowDone(false)}>
                Open
              </HeaderTab>
              <HeaderTab active={showDone} onClick={() => setShowDone(true)}>
                Done
                <span className="font-normal tracking-normal normal-case">
                  {data.done.length}
                </span>
              </HeaderTab>
            </div>
          ) : undefined
        }
      />

      {/* The one way to add things, everywhere: the composer band under the
          header (P6), not a corner button. Hidden when empty — the empty
          state carries its own composer action. */}
      {empty ? null : <TaskComposer variant="band" />}

      {empty ? (
        <EmptyState
          icon={CheckSquare}
          title="Nothing to chase yet"
          body={
            'Tasks put dates on judgment calls — "revisit when their round closes", "chase the data room", "re-mark after the bridge". Link them to records so they show up where you work.'
          }
          action={<TaskComposer />}
        />
      ) : (
        <div className="flex flex-col gap-8 px-8 py-6">
          {groups.map((g) => (
            <LedgerSection
              key={g.key}
              label={<span className={g.tone}>{g.title}</span>}
              count={
                g.hint ? `${g.rows.length} · ${g.hint}` : `${g.rows.length}`
              }
            >
              {g.rows.map((t, i) => (
                <TaskItem
                  key={t.id}
                  task={t}
                  figure={whenFigure(t.dueDate, today, g.key)}
                  overdue={g.key === 'overdue'}
                  last={i === g.rows.length - 1}
                  onToggle={() => toggle(t.id, true)}
                />
              ))}
            </LedgerSection>
          ))}

          {showDone && data.done.length > 0 ? (
            <LedgerSection label="Done" count={`${data.done.length}`}>
              {data.done.map((t, i) => (
                <TaskItem
                  key={t.id}
                  task={t}
                  figure="done"
                  done
                  last={i === data.done.length - 1}
                  onToggle={() => toggle(t.id, false)}
                />
              ))}
            </LedgerSection>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Header tabs: caps mono, pine rule under the current one (the view-tab
 *  treatment). Sits on the header's hairline. */
function HeaderTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-1.5 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-graphite hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function TaskItem({
  task: t,
  done,
  overdue,
  figure,
  last,
  onToggle,
}: {
  task: TaskRow
  done?: boolean
  overdue?: boolean
  figure: string
  last?: boolean | undefined
  onToggle: () => void
}) {
  return (
    // The row reads check → what → where → who → when; the date holds the
    // right lane alone.
    <LedgerRow last={last}>
      <input
        type="checkbox"
        className="focus-ring size-3.5 shrink-0 appearance-none border border-hairline bg-paper checked:border-primary checked:bg-primary"
        checked={!!done}
        onChange={onToggle}
        aria-label={done ? 'Reopen task' : 'Complete task'}
      />
      <span
        className={cn(
          'min-w-0 truncate text-ui',
          done && 'text-graphite line-through',
        )}
      >
        {t.content}
      </span>
      {t.entities.map((e) => {
        const path = entityPath(e.kind, e.id)
        // Kinds without a record page (organizations) stay plain — a
        // wrong-kind route is worse than no link.
        return path ? (
          <Link
            key={e.id}
            to={path}
            className="focus-ring shrink-0 truncate mono text-micro text-graphite hover:text-foreground"
          >
            {e.name}
          </Link>
        ) : (
          <span
            key={e.id}
            className="shrink-0 truncate mono text-micro text-graphite"
          >
            {e.name}
          </span>
        )
      })}
      <span className="flex-1" />
      <span className="shrink-0 mono text-micro text-graphite">
        {t.assigneeName}
      </span>
      <LedgerFigure wide tone={overdue ? 'bad' : done ? 'muted' : undefined}>
        {figure}
      </LedgerFigure>
    </LedgerRow>
  )
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
