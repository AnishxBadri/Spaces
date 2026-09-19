import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { CheckSquare, Trash2 } from 'lucide-react'
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
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { useBornRows } from '#/lib/born-rows'
import { recordPath } from '#/lib/record-path'
import { deleteTask, listTasks, setTaskDone } from '#/lib/server-fns'
import { localToday } from '@spaces/core/tasks/parse-due'
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

/** The local calendar day an ISO timestamp fell on. */
function localDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Done is a log, so it groups by when the work closed, not when it was
 * due — the due date stopped mattering the moment the box was checked.
 */
function groupDone(done: Array<TaskRow>, today: string): Array<Group> {
  const weekAgo = new Date(`${today}T00:00:00Z`)
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
  const since = weekAgo.toISOString().slice(0, 10)
  const groups: Array<Group> = [
    { key: 'done-today', title: 'Today', rows: [] },
    {
      key: 'done-week',
      title: 'This week',
      hint: `since ${since.slice(5)}`,
      rows: [],
    },
    { key: 'done-earlier', title: 'Earlier', rows: [] },
  ]
  for (const t of done) {
    const day = t.doneAt ? localDay(t.doneAt) : ''
    if (day === today) groups[0].rows.push(t)
    else if (day >= since) groups[1].rows.push(t)
    else groups[2].rows.push(t)
  }
  return groups.filter((g) => g.rows.length > 0)
}

/** The when-lane for a closed task: the clock today, then the date. */
function doneFigure(doneAt: string | null, today: string): string {
  if (!doneAt) return '—'
  const d = new Date(doneAt)
  const day = localDay(doneAt)
  if (day === today) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (day.slice(0, 4) === today.slice(0, 4)) return day.slice(5)
  return day
}

/** The row's exit: long enough to read the strike, short enough to ignore. */
const EXIT_MS = 150

function TasksPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [showDone, setShowDone] = useState(false)
  // Rows mid-exit. The write waits for the transition so completing a task
  // reads as the row leaving, not as the list flinching.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  // Rows this page's composer band created — the only ones the wash touches.
  // Everything the loader handed us was already here, so nothing washes on
  // arrival at the page, or on a reload seconds after a task was added.
  const { washes, bear } = useBornRows()
  const { confirm, confirmDialog } = useConfirm()
  const today = localToday()

  // The tabs are exclusive: Done is a different list, not a disclosure on
  // this one. Reopening the last done task takes the tab away, so the view
  // falls back rather than stranding the page on an empty log.
  const viewDone = showDone && data.done.length > 0
  const openGroups = groupTasks(data.open, today)
  const groups = viewDone ? groupDone(data.done, today) : openGroups

  async function write(id: string, done: boolean) {
    try {
      await setTaskDone({ data: { id, done } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    } finally {
      setLeaving((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  function toggle(id: string, done: boolean) {
    setLeaving((s) => new Set(s).add(id))
    window.setTimeout(() => {
      void write(id, done)
      if (done) {
        toast('Task done', {
          action: { label: 'Undo', onClick: () => void write(id, false) },
        })
      }
    }, EXIT_MS)
  }

  async function erase(id: string) {
    try {
      await deleteTask({ data: { id } })
      void router.invalidate()
    } catch {
      toast.error('Could not delete the task')
    } finally {
      setLeaving((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  async function remove(t: TaskRow) {
    const ok = await confirm({
      title: 'Delete this task?',
      body: `"${t.content}" leaves the workspace. This cannot be undone.`,
      action: 'Delete',
    })
    if (!ok) return
    setLeaving((s) => new Set(s).add(t.id))
    window.setTimeout(() => void erase(t.id), EXIT_MS)
  }

  const overdue = openGroups.find((g) => g.key === 'overdue')?.rows.length ?? 0
  const dueToday = openGroups.find((g) => g.key === 'today')?.rows.length ?? 0
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
              <HeaderTab active={!viewDone} onClick={() => setShowDone(false)}>
                Open
              </HeaderTab>
              <HeaderTab active={viewDone} onClick={() => setShowDone(true)}>
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
          state carries its own composer action. Adding from the Done log
          returns to Open, where the new task actually is. */}
      {empty ? null : (
        <TaskComposer
          variant="band"
          onCreated={(id) => {
            bear(id)
            setShowDone(false)
          }}
        />
      )}

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
          {groups.length === 0 ? (
            <p className="text-ui text-graphite">
              {viewDone ? 'Nothing closed yet.' : 'Nothing open. Enjoy it.'}
            </p>
          ) : null}
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
                  figure={
                    viewDone
                      ? doneFigure(t.doneAt, today)
                      : whenFigure(t.dueDate, today, g.key)
                  }
                  done={viewDone}
                  overdue={g.key === 'overdue'}
                  leaving={leaving.has(t.id)}
                  wash={washes(t.id)}
                  last={i === g.rows.length - 1}
                  onToggle={() => toggle(t.id, !viewDone)}
                  onDelete={() => void remove(t)}
                />
              ))}
            </LedgerSection>
          ))}
        </div>
      )}
      {confirmDialog}
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
  leaving,
  wash,
  onToggle,
  onDelete,
}: {
  task: TaskRow
  done?: boolean
  overdue?: boolean
  figure: string
  last?: boolean | undefined
  /** Mid-exit: struck through and fading, write pending. */
  leaving?: boolean | undefined
  /** Added by the composer band in this session — lands on the bone wash. */
  wash?: boolean | undefined
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    // The row reads check → what → where → who → when; the date holds the
    // right lane alone. A leaving row fades on opacity only — the list
    // keeps its height until the write lands and the row unmounts.
    <LedgerRow
      last={last}
      wash={wash}
      className={cn(
        'group transition-opacity duration-150 ease-out-quart',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      <Checkbox
        checked={!!done !== !!leaving}
        onCheckedChange={onToggle}
        aria-label={done ? 'Reopen task' : 'Complete task'}
      />
      <span
        className={cn(
          'min-w-0 truncate text-ui transition-colors duration-150',
          (done || leaving) && 'text-graphite line-through',
        )}
      >
        {t.content}
      </span>
      {t.entities.map((e) => {
        // One route table for the whole app (`recordPath`). A kind with no
        // record page — a document, a term — stays plain text: a wrong-kind
        // route is worse than no link.
        const path = recordPath(e)
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
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete task: ${t.content}`}
        onClick={onDelete}
        className="shrink-0 text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
      >
        <Trash2 />
      </Button>
      <span className="shrink-0 mono text-micro text-graphite">
        {t.assigneeName}
      </span>
      <LedgerFigure wide tone={overdue ? 'bad' : done ? 'muted' : undefined}>
        {figure}
      </LedgerFigure>
    </LedgerRow>
  )
}
