import { useRouter } from '@tanstack/react-router'
import { AtSign, Calendar, Link2, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { createTask, listUsers, searchEntities } from '#/lib/server-fns'
import { localToday, parseDue } from '#/lib/tasks/parse-due'
import { cn } from '#/lib/utils'

/**
 * The task composer (CONTEXT.md 15b — Attio's create-bar as reference):
 * one line of text, pills for due date / assignee / linked records.
 * Natural-language dates parse deterministically; "no date" is legal.
 */

function dueLabel(due: string | null, today: string): string {
  if (!due) return 'No date'
  if (due === today) return 'Today'
  const t = new Date(`${today}T00:00:00Z`)
  const d = new Date(`${due}T00:00:00Z`)
  const days = Math.round((d.getTime() - t.getTime()) / 86400000)
  if (days === 1) return 'Tomorrow'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

type LinkedRecord = { id: string; name: string; kind: string }

export function TaskComposer({
  trigger,
  presetEntity,
  onCreated,
}: {
  trigger?: React.ReactNode
  /** Record page rails pass their record — pre-linked, removable. */
  presetEntity?: LinkedRecord
  onCreated?: () => void
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
  const [createMore, setCreateMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = localToday()

  async function save() {
    if (!content.trim()) {
      setError('Say what the task is.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await createTask({
        data: {
          content: content.trim(),
          dueDate: due,
          assigneeId: assignee?.id,
          entityIds: records.map((r) => r.id),
        },
      })
      toast('Task created')
      setContent('')
      setDue(null)
      if (!presetEntity) setRecords([])
      if (!createMore) setOpen(false)
      onCreated?.()
      router.invalidate()
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
      <DialogContent className="top-[20%] translate-y-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-ui font-medium">Create task</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            className="w-full bg-transparent px-4 py-4 text-base outline-none placeholder:text-muted-foreground"
            placeholder="Chase the data room, revisit after their round closes…"
            value={content}
            autoFocus
            onChange={(e) => setContent(e.target.value)}
          />
          {error ? (
            <p role="alert" className="px-4 pb-2 text-ui text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <DuePill due={due} today={today} onChange={setDue} />
            <AssigneePill assignee={assignee} onChange={setAssignee} />
            <RecordsPill records={records} onChange={setRecords} />
            <div className="ml-auto flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-label text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={createMore}
                  onChange={(e) => setCreateMore(e.target.checked)}
                />
                Create more
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Pill({
  icon: Icon,
  children,
  active,
}: {
  icon: typeof Calendar
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <span
      className={cn(
        'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-label transition-colors duration-150',
        active
          ? 'border-primary/40 bg-selected text-foreground'
          : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} />
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
  const [text, setText] = useState('')
  const parsed = parseDue(text, today)

  function pick(d: string | null) {
    onChange(d)
    setText('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="focus-ring rounded-md">
          <Pill icon={Calendar} active={due !== null}>
            {dueLabel(due, today)}
          </Pill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
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
            autoFocus
          />
        </form>
        <p
          className={cn(
            'mt-1 px-1 text-xs',
            text && !parsed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {text
            ? (parsed ?? 'Not a date I understand — try "in 2 weeks"')
            : 'Type a date, or pick:'}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {(
            [
              ['Today', today],
              ['Tomorrow', parseDue('tomorrow', today)],
              ['Next week', parseDue('next week', today)],
              ['No date', null],
            ] as Array<[string, string | null]>
          ).map(([label, value]) => (
            <button
              key={label}
              type="button"
              className="focus-ring rounded-md border border-border px-2 py-1 text-label text-muted-foreground hover:text-foreground"
              onClick={() => pick(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="date"
          className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1 text-label"
          value={due ?? ''}
          onChange={(e) => pick(e.target.value || null)}
          aria-label="Pick a date"
        />
      </PopoverContent>
    </Popover>
  )
}

function AssigneePill({
  assignee,
  onChange,
}: {
  assignee: { id: string; name: string } | null
  onChange: (a: { id: string; name: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!open || users.length > 0) return
    listUsers().then((u) =>
      setUsers(u.map((x) => ({ id: x.id, name: x.name }))),
    )
  }, [open, users.length])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="focus-ring rounded-md">
          <Pill icon={AtSign} active={assignee !== null}>
            {assignee ? assignee.name : 'Assigned to you'}
          </Pill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {users.length === 0 ? (
          <p className="px-2 py-1.5 text-label text-muted-foreground">
            Loading…
          </p>
        ) : (
          users.map((u) => (
            <button
              key={u.id}
              type="button"
              className="focus-ring flex w-full items-center rounded-md px-2 py-1.5 text-ui hover:bg-accent"
              onClick={() => {
                onChange(u)
                setOpen(false)
              }}
            >
              {u.name}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
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
      searchEntities({
        data: { q, kinds: ['company', 'person', 'deal', 'organization'] },
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
          className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-label"
        >
          {r.name}
          <button
            type="button"
            aria-label={`Unlink ${r.name}`}
            className="focus-ring rounded text-muted-foreground hover:text-foreground"
            onClick={() => onChange(records.filter((x) => x.id !== r.id))}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="focus-ring rounded-md">
            <Pill icon={Link2}>
              {records.length === 0 ? 'Add record' : 'Add'}
            </Pill>
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
                  className="focus-ring flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-accent"
                  onClick={() => {
                    onChange([...records, r])
                    setQ('')
                    setOpen(false)
                  }}
                >
                  {r.name}
                  <span className="text-label text-muted-foreground">
                    {r.kind}
                  </span>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
