import {
  createFileRoute,
  Link,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router'
import { CheckSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#/components/empty-state'
import { LabelHead, LedgerFigure } from '#/components/ledger-section'
import { PageHeader } from '#/components/page-header'
import { useTaskMenu } from '#/components/tasks/task-menu'
import { TaskComposer, TaskComposerRow } from '#/components/task-composer'
import { Checkbox } from '#/components/ui/checkbox'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { Segmented } from '#/components/ui/segmented'
import { useBornRows } from '#/lib/born-rows'
import { recordPath } from '#/lib/record-path'
import { deleteTask, listTasks, setTaskDone } from '#/lib/server-fns'
import { focusTab } from '#/lib/tasks/focus'
import {
  dayKey,
  formatDay,
  formatDue,
  formatWeekdayHead,
  formatWhen,
} from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/_app/tasks')({
  // `?task=` is the row a Cmd-K hit lands on; `?record=` narrows the list to
  // one record's tasks. A malformed id catches to undefined: the page renders
  // unfocused and unnarrowed, with no error.
  validateSearch: z.object({
    task: z.string().uuid().optional().catch(undefined),
    record: z.string().uuid().optional().catch(undefined),
  }),
  // The focused id is a loader dep because Done is a 50-row window: a hit on
  // a task closed long ago is fetched by id, not hoped for in the window.
  loaderDeps: ({ search }) => ({ task: search.task, record: search.record }),
  loader: ({ deps }) =>
    listTasks({
      data: { includeDone: true, focus: deps.task, record: deps.record },
    }),
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
  /** The group's head in mono caps. */
  label: string
  tone?: 'bad'
  rows: Array<TaskRow>
}

/** Urgency groups: overdue, today, this week, later, then dateless. */
function groupTasks(open: Array<TaskRow>, today: string): Array<Group> {
  const eow = endOfWeek(today)
  const groups: Array<Group> = [
    { key: 'overdue', label: 'OVERDUE', tone: 'bad', rows: [] },
    {
      key: 'today',
      label: `TODAY · ${formatWeekdayHead(today, today)}`,
      rows: [],
    },
    {
      key: 'week',
      label: `THIS WEEK · THROUGH ${formatWeekdayHead(eow, today)}`,
      rows: [],
    },
    { key: 'later', label: 'LATER', rows: [] },
    { key: 'nodate', label: 'NO DATE', rows: [] },
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

/**
 * Done is a log, so it groups by when the work closed, not when it was
 * due — the due date stopped mattering the moment the box was checked.
 */
function groupDone(done: Array<TaskRow>, today: string): Array<Group> {
  const weekAgo = new Date(`${today}T00:00:00Z`)
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
  const since = weekAgo.toISOString().slice(0, 10)
  const groups: Array<Group> = [
    { key: 'done-today', label: 'TODAY', rows: [] },
    {
      key: 'done-week',
      label: `THIS WEEK · SINCE ${formatDay(since, today).toUpperCase()}`,
      rows: [],
    },
    { key: 'done-earlier', label: 'EARLIER', rows: [] },
  ]
  for (const t of done) {
    const day = t.doneAt ? dayKey(t.doneAt) : ''
    if (day === today) groups[0].rows.push(t)
    else if (day >= since) groups[1].rows.push(t)
    else groups[2].rows.push(t)
  }
  return groups.filter((g) => g.rows.length > 0)
}

/** The row's exit: long enough to read the strike, short enough to ignore. */
const EXIT_MS = 150

type View = 'open' | 'done'

function TasksPage() {
  const data = Route.useLoaderData()
  const { task: focusId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const me = useRouteContext({ from: '/_app' }).session.user
  // A focused task picks the view it lives in: a closed one opens Done
  // instead of rendering nothing.
  const [view, setView] = useState<View>(() =>
    focusTab(focusId, data) === 'done' ? 'done' : 'open',
  )
  // A new focus on a page already mounted — Cmd-K from /tasks itself — picks
  // its view during render, so the wrong one never paints first.
  const [viewFocus, setViewFocus] = useState(focusId)
  if (viewFocus !== focusId) {
    setViewFocus(focusId)
    const tab = focusTab(focusId, data)
    if (tab !== null) setView(tab)
  }

  /**
   * The first interaction spends the focus: the param leaves the history
   * entry (replace, not push), so back/forward never re-focuses a row the
   * user has moved past, and the page keeps its scroll.
   */
  function clearFocus() {
    if (focusId === undefined) return
    void navigate({
      search: (prev) => ({ ...prev, task: undefined }),
      replace: true,
      resetScroll: false,
    })
  }
  // Rows mid-exit. The write waits for the transition so completing a task
  // reads as the row leaving, not as the list flinching.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  // Rows this page's composer created — the only ones the wash touches.
  const { washes, bear } = useBornRows()
  const { today } = useClock()

  const viewDone = view === 'done'
  const groups = viewDone
    ? groupDone(data.done, today)
    : groupTasks(data.open, today)

  function settle(id: string) {
    setLeaving((s) => {
      const next = new Set(s)
      next.delete(id)
      return next
    })
  }

  async function write(id: string, done: boolean) {
    try {
      await setTaskDone({ data: { id, done } })
      void router.invalidate()
    } catch {
      toast.error('Could not update the task')
    } finally {
      settle(id)
    }
  }

  function toggle(id: string, done: boolean) {
    clearFocus()
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
      settle(id)
    }
  }

  // The row's `···`, shared with Today; a confirmed delete fades the row
  // out before the write, as completing one does.
  const { menuFor, windows } = useTaskMenu({
    me,
    today,
    onDelete: (t) => {
      clearFocus()
      setLeaving((s) => new Set(s).add(t.id))
      window.setTimeout(() => void erase(t.id), EXIT_MS)
    },
  })

  const scope = data.record
  const empty =
    scope === null && data.open.length === 0 && data.done.length === 0

  // The composer is the list's last row; on a narrowed list it links the
  // record. Adding from the Done log returns to Open, where the task is.
  const composer = (
    <TaskComposer
      hotkey="t"
      {...(scope === null ? {} : { presetEntity: scope })}
      onCreated={(id) => {
        clearFocus()
        bear(id)
        setView('open')
      }}
      trigger={<TaskComposerRow />}
    />
  )

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Tasks" />

      {empty ? (
        <EmptyState
          icon={CheckSquare}
          title="Nothing to chase yet"
          body={
            'Tasks put dates on judgment calls — "revisit when their round closes", "chase the data room", "re-mark after the bridge". Link them to records so they show up where you work.'
          }
          action={<TaskComposer hotkey="t" />}
        />
      ) : (
        <>
          <div
            data-tasks-band
            className="flex h-11 shrink-0 items-center gap-3 border-b border-rule bg-bone px-8"
          >
            {scope === null ? null : <ScopeChip name={scope.name} />}
            <span className="flex-1" />
            <Segmented
              label="Tasks"
              value={view}
              onChange={(v) => {
                clearFocus()
                setView(v)
              }}
              options={[
                { id: 'open', label: 'Open', count: data.open.length },
                { id: 'done', label: 'Done', count: data.done.length },
              ]}
            />
          </div>
          <div className="flex flex-col gap-8 px-8 py-6">
            {groups.length === 0 ? (
              <ol className="border-t border-rule">
                <li>{composer}</li>
              </ol>
            ) : null}
            {groups.map((g, gi) => (
              <section
                key={g.key}
                aria-label={g.label}
                className="flex flex-col"
              >
                <LabelHead
                  label={
                    <span
                      className={
                        g.tone === 'bad' ? 'text-destructive' : undefined
                      }
                    >
                      {g.label}
                    </span>
                  }
                />
                <ol>
                  {g.rows.map((t) => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      meId={me.id}
                      figure={
                        viewDone
                          ? t.doneAt
                            ? formatWhen(t.doneAt, today)
                            : ''
                          : t.dueDate
                            ? formatDue(t.dueDate, today)
                            : ''
                      }
                      done={viewDone}
                      focused={t.id === focusId}
                      overdue={g.key === 'overdue'}
                      leaving={leaving.has(t.id)}
                      wash={washes(t.id)}
                      menu={menuFor(t)}
                      onToggle={() => toggle(t.id, !viewDone)}
                    />
                  ))}
                  {gi === groups.length - 1 ? <li>{composer}</li> : null}
                </ol>
              </section>
            ))}
          </div>
        </>
      )}
      {windows}
    </div>
  )
}

/**
 * `on Flent ×` — the list is narrowed to one record's tasks; the × clears
 * the param back to every task.
 */
function ScopeChip({ name }: { name: string }) {
  return (
    <span data-task-scope className="mention-chip cursor-default">
      On {name}
      <Link
        to="/tasks"
        search={{}}
        aria-label={`Show every task, not just ${name}'s`}
        className="focus-ring -mr-0.5 text-graphite hover:text-foreground"
      >
        <X className="size-3" strokeWidth={2} />
      </Link>
    </span>
  )
}

function TaskItem({
  task: t,
  meId,
  done,
  focused,
  overdue,
  figure,
  leaving,
  wash,
  menu,
  onToggle,
}: {
  task: TaskRow
  /** The reader: their own name is never printed on a row. */
  meId: string
  done?: boolean
  /** The `?task=` row: scrolls into view and takes focus on its checkbox. */
  focused?: boolean
  overdue?: boolean
  figure: string
  /** Mid-exit: struck through and fading, write pending. */
  leaving?: boolean | undefined
  /** Added by the composer in this session — lands on the bone wash. */
  wash?: boolean | undefined
  menu: ReadonlyArray<MoreMenuEntry>
  onToggle: () => void
}) {
  const box = useRef<HTMLButtonElement>(null)
  // Focus lands on the row's own checkbox, so its `focus-ring` reticle is
  // the whole treatment — no highlight of its own. A frame late: the
  // palette's dialog hands focus back to its trigger as it unmounts, and
  // the row must be the last to take it.
  useEffect(() => {
    if (!focused) return
    const frame = requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focused])

  return (
    // check → what → where → who, then the figure and the `···`. A leaving
    // row fades on opacity only — the list keeps its height until the write
    // lands and the row unmounts.
    <li
      data-row
      data-task-row
      className={cn(
        'flex h-ledger-row items-center gap-3 border-b border-rule px-3 transition-opacity duration-150 ease-out-quart',
        wash === true && 'row-wash',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      <Checkbox
        ref={box}
        checked={!!done !== !!leaving}
        onCheckedChange={onToggle}
        aria-label={done ? 'Reopen task' : 'Complete task'}
      />
      <span
        className={cn(
          'min-w-0 truncate text-body transition-colors duration-150',
          (done || leaving) && 'text-graphite line-through',
        )}
      >
        {t.content}
      </span>
      {t.entities.map((e) => (
        <RecordName key={e.id} entity={e} />
      ))}
      <span className="flex-1" />
      {t.assigneeId === meId ? null : (
        <span className="shrink-0 truncate text-label text-graphite">
          {t.assigneeName}
        </span>
      )}
      <LedgerFigure wide tone={overdue ? 'bad' : done ? 'muted' : undefined}>
        {figure}
      </LedgerFigure>
      <MoreMenu variant="row" label={t.content} items={menu} />
    </li>
  )
}

/**
 * A linked record in graphite. One route table for the whole app
 * (`recordPath`); a kind with no record page stays plain text.
 */
function RecordName({ entity: e }: { entity: TaskRow['entities'][number] }) {
  const path = recordPath(e)
  return path ? (
    <Link
      to={path}
      className="focus-ring shrink-0 truncate text-ui text-graphite hover:text-foreground"
    >
      {e.name}
    </Link>
  ) : (
    <span className="shrink-0 truncate text-ui text-graphite">{e.name}</span>
  )
}
