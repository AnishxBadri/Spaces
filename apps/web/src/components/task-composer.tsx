import { useRouteContext, useRouter } from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DitherMark, InitialsMark } from './record/record-parts'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Switch } from './ui/switch'
import { createTask, listUsers, searchEntities } from '#/lib/server-fns'
import { daysBetween, formatWeekday } from '@spaces/core/format'
import { parseDue } from '@spaces/core/tasks/parse-due'
import { useClock } from '#/components/clock'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/** The four quick-pick due dates, in the order both surfaces show them. */
function duePresets(today: string): Array<[string, string | null]> {
  return [
    ['Today', today],
    ['Tomorrow', parseDue('tomorrow', today)],
    ['Next week', parseDue('next week', today)],
    ['No date', null],
  ]
}

/**
 * The task composer: one line of text, pills for due date / assignee / linked records.
 * Natural-language dates parse deterministically; "no date" is legal.
 */

/** The chip's reading of a due date: `Today`, `Tomorrow`, else `Fri 12 Sep`. */
function dueLabel(due: string | null, today: string): string {
  if (!due) return 'No date'
  if (due === today) return 'Today'
  if (daysBetween(today, due) === 1) return 'Tomorrow'
  return formatWeekday(due, today)
}

type LinkedRecord = { id: string; name: string; kind: string }

export function TaskComposer({
  trigger,
  presetEntity,
  onCreated,
  hotkey,
}: {
  trigger?: React.ReactNode
  /** Record page rails pass their record — pre-linked, removable. */
  presetEntity?: LinkedRecord
  /** The composer's row landed: the id is what the list's wash reads
   *  (`useBornRows`). */
  onCreated?: (id: string) => void
  /** A bare key that opens the composer from anywhere on the page — the
   *  key hint printed in the trigger must be true. Ignored while typing. */
  hotkey?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [due, setDue] = useState<string | null>(null)
  const [assignee, setAssignee] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [records, setRecords] = useState<Array<LinkedRecord>>(
    presetEntity ? [presetEntity] : [],
  )
  const [keepOpen, setKeepOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { today } = useClock()
  // Who the task lands on when the pill is untouched: `assignee_id` is NOT
  // NULL and the server defaults it to the caller, so "nobody" is not a
  // state the pill can honestly offer.
  const me = useRouteContext({ from: '/_app' }).session.user

  useHotkey(hotkey, () => setOpen(true))

  /**
   * `keep`: the sheet stays, the chips stay, only the text clears — so a
   * run of tasks against one record keeps its date and its links. ⇧↵ is
   * the one-shot version of the switch.
   */
  async function save(keep = keepOpen) {
    if (!content.trim()) {
      setError('Say what the task is.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const created = await createTask({
        data: {
          content: content.trim(),
          dueDate: due,
          assigneeId: assignee?.id,
          entityIds: records.map((r) => r.id),
        },
      })
      toast('Task created')
      setContent('')
      if (!keep) {
        setDue(null)
        if (!presetEntity) setRecords([])
        setOpen(false)
      }
      onCreated?.(created.id)
      void router.invalidate()
    } catch {
      setError('Could not create the task.')
    } finally {
      setPending(false)
    }
  }

  // Cancel/close discards the draft entirely — a chip linked in an
  // abandoned draft must never leak into the next task.
  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setContent('')
      setDue(null)
      setAssignee(null)
      setRecords(presetEntity ? [presetEntity] : [])
      setError(null)
    }
  }

  const chips = (
    <>
      <DuePill due={due} today={today} onChange={setDue} />
      <AssigneePill assignee={assignee} me={me} onChange={setAssignee} />
      <RecordsPill records={records} onChange={setRecords} />
    </>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" strokeWidth={2} />
            New task
          </Button>
        )}
      </DialogTrigger>
      {/* Quick task: no title bar — the input is the title. 48px prompt row
          with a pine +, chips under it, a bone foot. */}
      <DialogContent size="s" className="top-[20%] translate-y-0 p-0">
        <DialogTitle className="sr-only">Create task</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault()
              void save(true)
            }
          }}
        >
          <div className="flex h-12 items-center gap-2.5 border-b border-hairline px-5">
            <span className="mono text-ui text-primary">+</span>
            {/* The input is the title: no reticle here — the caret in a
                sheet that just opened is the focus, and marks at the
                corners of a borderless full-width box read as a frame
                around the head. */}
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-graphite"
              placeholder="Chase the data room, revisit after their round closes…"
              aria-label="New task"
              value={content}
              autoFocus
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="px-5 pt-3 text-label text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            {chips}
          </div>
          <div className="flex min-h-11 items-center gap-4 border-t border-rule bg-bone px-5 py-2">
            <Switch checked={keepOpen} onCheckedChange={setKeepOpen}>
              Keep open
            </Switch>
            <span className="flex-1" />
            <span className="hidden mono text-micro text-graphite sm:inline">
              ↵ add · ⇧↵ add & keep open
            </span>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" pending={pending}>
              {pending ? 'Saving…' : 'Add task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Pill({
  children,
  active,
  dashed,
}: {
  children: React.ReactNode
  active?: boolean
  dashed?: boolean
}) {
  return (
    <span
      className={cn(
        'flex h-6 cursor-pointer items-center gap-1.5 border bg-paper px-2 mono text-micro transition-colors duration-150',
        active
          ? 'border-hairline text-foreground'
          : 'border-rule text-graphite hover:border-hairline hover:text-foreground',
        dashed && 'border-dashed bg-transparent',
      )}
    >
      {children}
    </span>
  )
}

function DuePill({
  due,
  today,
  onChange,
}: {
  due: string | null
  today: string
  onChange: (d: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="focus-ring">
          <Pill active={due !== null}>
            {due ? dueLabel(due, today) : 'Due date'}
          </Pill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <DueField
          due={due}
          today={today}
          onPick={(d) => {
            onChange(d)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Picking a due day: a typed date that parses deterministically, the four
 * presets, or the native calendar. The composer's pill and a task row's
 * `Due date…` window both draw it.
 */
export function DueField({
  due,
  today,
  onPick,
}: {
  due: string | null
  today: string
  onPick: (d: string | null) => void
}) {
  const [text, setText] = useState('')
  const parsed = parseDue(text, today)

  function pick(d: string | null) {
    setText('')
    onPick(d)
  }

  return (
    <div className="flex flex-col">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed) pick(parsed)
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Next Tuesday, in 3 months…"
          aria-label="Due date"
          autoFocus
        />
      </form>
      <p
        className={cn(
          'mt-1 px-1 text-label',
          text && !parsed ? 'text-destructive' : 'text-graphite',
        )}
      >
        {text
          ? (parsed ?? 'Not a date I understand — try "in 2 weeks"')
          : 'Type a date, or pick:'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {duePresets(today).map(([label, value]) => (
          <button
            key={label}
            type="button"
            className="focus-ring h-6 border border-rule bg-paper px-2 mono text-micro text-graphite hover:border-hairline hover:text-foreground"
            onClick={() => pick(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        type="date"
        className="mt-2 w-full rounded-md border border-rule bg-transparent px-2 py-1 text-label"
        value={due ?? ''}
        onChange={(e) => pick(e.target.value || null)}
        aria-label="Pick a date"
      />
    </div>
  )
}

/**
 * The pill shows who the task will actually land on, never an instruction:
 * untouched it reads `Me`, because that is what the server will do. There
 * is no clear option — every task has an assignee by schema.
 */
function AssigneePill({
  assignee,
  me,
  onChange,
}: {
  assignee: { id: string; name: string } | null
  me: { id: string; name: string }
  onChange: (a: { id: string; name: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const effective = assignee ?? me
  const isMe = effective.id === me.id

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Assign to" className="focus-ring">
          <Pill active={assignee !== null}>
            <InitialsMark name={effective.name} size="xs" />
            <span className="font-sans text-label">
              {isMe ? 'Me' : effective.name}
            </span>
          </Pill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <p className="px-2 pt-1 pb-1.5 label-caps text-graphite">Assign to</p>
        {open ? (
          <MemberList
            selected={effective.id}
            me={me}
            onPick={(u) => {
              onChange(u.id === me.id ? null : u)
              setOpen(false)
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The members a task can land on, the reader first — the common case should
 * not need a read of the list. Loads on mount; the composer's pill and a
 * task row's `Assign…` window both draw it.
 */
export function MemberList({
  selected,
  me,
  onPick,
}: {
  selected: string
  me: { id: string; name: string }
  onPick: (u: { id: string; name: string }) => void
}) {
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    let alive = true
    listUsers()
      .then((u) => {
        if (alive) setUsers(u.map((x) => ({ id: x.id, name: x.name })))
      })
      .catch(() => toast.error('Could not load teammates'))
    return () => {
      alive = false
    }
  }, [])

  const ordered = [
    me,
    ...users
      .filter((u) => u.id !== me.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ]

  if (users.length === 0)
    return <p className="px-2 py-1.5 text-label text-graphite">Loading…</p>
  return (
    <div className="flex flex-col">
      {ordered.map((u) => (
        <button
          key={u.id}
          type="button"
          className={cn(
            'focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-bone',
            u.id === selected && 'bg-selected',
          )}
          onClick={() => onPick(u)}
        >
          <InitialsMark name={u.name} size="xs" />
          {u.name}
          {u.id === me.id ? (
            <span className="text-label text-graphite">You</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

/**
 * The composer as a list's last row: `+ Add a task…`, its key in the end
 * lane. A plain button, so the dialog trigger hands it its props.
 */
export function TaskComposerRow(props: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-composer-row
      {...props}
      className="focus-ring-inset flex h-ledger-row w-full min-w-0 items-center gap-3 px-3 text-left transition-colors duration-150 ease-out-quart hover:bg-bone"
    >
      <span
        aria-hidden
        className="w-3.5 shrink-0 text-center mono text-ui text-primary"
      >
        +
      </span>
      <span className="min-w-0 flex-1 truncate text-body text-graphite">
        Add a task…
      </span>
      <kbd className="shrink-0 mono text-micro text-graphite">T</kbd>
    </button>
  )
}

function RecordsPill({
  records,
  onChange,
}: {
  records: Array<LinkedRecord>
  onChange: (r: Array<LinkedRecord>) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<LinkedRecord>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic sequence: a slow older response must never overwrite the
  // results of a newer query.
  const seq = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!q.trim()) {
      seq.current++
      setResults([])
      return
    }
    const mySeq = ++seq.current
    timer.current = setTimeout(() => {
      void searchEntities({
        data: { q, kinds: ['company', 'person', 'deal'] },
      }).then((r) => {
        if (seq.current === mySeq) setResults(r)
      })
    }, 150)
  }, [q])

  return (
    <>
      {records.map((r) => (
        <span
          key={r.id}
          className="flex h-6 items-center gap-1.5 border border-rule bg-paper px-2 text-label"
        >
          <DitherMark size={12} />
          {r.name}
          <button
            type="button"
            aria-label={`Unlink ${r.name}`}
            className="focus-ring text-graphite hover:text-foreground"
            onClick={() => onChange(records.filter((x) => x.id !== r.id))}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="focus-ring">
            <Pill dashed>+ Link record</Pill>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search records…"
            autoFocus
          />
          <div className="mt-1">
            {results
              .filter((r) => !records.some((x) => x.id === r.id))
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="focus-ring flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-bone"
                  onClick={() => {
                    onChange([...records, r])
                    setQ('')
                    setOpen(false)
                  }}
                >
                  {r.name}
                  <span className="text-label text-graphite">{r.kind}</span>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
