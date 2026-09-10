import { useRouter } from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { KeyHint } from './page-header'
import { DitherMark, InitialsMark } from './record/record-parts'
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
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * The task composer (CONTEXT.md 15b — Attio's create-bar as reference):
 * one line of text, pills for due date / assignee / linked records.
 * Natural-language dates parse deterministically; "no date" is legal.
 */

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The chip's reading of a due date: `Today`, `Tomorrow`, else `Fri 09-12`. */
function dueLabel(due: string | null, today: string): string {
  if (!due) return 'No date'
  if (due === today) return 'Today'
  const t = new Date(`${today}T00:00:00Z`)
  const d = new Date(`${due}T00:00:00Z`)
  const days = Math.round((d.getTime() - t.getTime()) / 86400000)
  if (days === 1) return 'Tomorrow'
  return `${WEEKDAY[d.getUTCDay()]} ${due.slice(5)}`
}

type LinkedRecord = { id: string; name: string; kind: string }

export function TaskComposer({
  trigger,
  presetEntity,
  onCreated,
  hotkey,
  variant = 'dialog',
}: {
  trigger?: React.ReactNode
  /** Record page rails pass their record — pre-linked, removable. */
  presetEntity?: LinkedRecord
  onCreated?: () => void
  /** A bare key that opens the composer from anywhere on the page — the
   *  key hint printed in the trigger must be true. Ignored while typing. */
  hotkey?: string
  /** `band` renders the composer inline as the bone band under a page
   *  header (P6); `dialog` (default) opens it from a trigger. */
  variant?: 'dialog' | 'band'
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

  useHotkey(hotkey, () => setOpen(true))

  /** `keep` holds the chips (date, records) for the next task — the band's
   *  ⇧↵ and its create-more switch; the dialog's create-more keeps it open. */
  async function save(keep = createMore) {
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
      if (variant === 'dialog' || !keep) {
        setDue(null)
        if (!presetEntity) setRecords([])
      }
      if (variant === 'dialog' && !keep) setOpen(false)
      onCreated?.()
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
      {variant === 'band' ? (
        <>
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
              onClick={() => setDue(value)}
              className="focus-ring flex h-6 items-center border border-rule bg-paper px-2 mono text-micro text-graphite transition-colors hover:border-hairline hover:text-foreground"
            >
              {label}
            </button>
          ))}
          <span aria-hidden className="mx-1 h-4 w-px bg-rule" />
        </>
      ) : null}
      <AssigneePill assignee={assignee} onChange={setAssignee} />
      <RecordsPill records={records} onChange={setRecords} />
    </>
  )

  if (variant === 'band') {
    return (
      <form
        className="flex shrink-0 flex-col gap-2 border-b border-hairline bg-bone px-8 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex h-9 items-center gap-2.5 rounded-md border border-hairline bg-paper px-3">
          <span className="mono text-ui text-primary">+</span>
          <input
            className="focus-ring h-full min-w-0 flex-1 bg-transparent text-body placeholder:text-graphite"
            placeholder="Add a task — “chase data room Friday”, “revisit after their raise”…"
            aria-label="New task"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                void save(true)
              }
            }}
          />
          <span className="hidden shrink-0 mono text-micro text-graphite md:inline">
            ↵ add · ⇧↵ add & keep open
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-label text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {chips}
          <span className="flex-1" />
          <button
            type="button"
            role="switch"
            aria-checked={createMore}
            onClick={() => setCreateMore((v) => !v)}
            className="focus-ring flex items-center gap-2 mono text-micro text-graphite"
          >
            <span
              aria-hidden
              className={cn(
                'flex h-3 w-6 border border-hairline bg-paper',
                createMore && 'justify-end',
              )}
            >
              <span className="size-2.5 bg-hairline" />
            </span>
            create more
          </button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Add task'}
            <KeyHint>↵</KeyHint>
          </Button>
        </div>
      </form>
    )
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
      {/* gap-0 kills DialogContent's default grid gap — with p-0 overridden,
          that gap reads as phantom bands around the input. py-3.5 centers the
          title on the close button's fixed top-4 line. */}
      <DialogContent className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3.5">
          <DialogTitle className="text-ui font-medium">Create task</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
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
            {chips}
            <div className="ml-auto flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 mono text-micro text-graphite">
                <input
                  type="checkbox"
                  className="focus-ring size-3.5 appearance-none border border-hairline bg-paper checked:bg-primary"
                  checked={createMore}
                  onChange={(e) => setCreateMore(e.target.checked)}
                />
                create more
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
        <button type="button" className="focus-ring">
          <Pill active={due !== null}>
            {due ? dueLabel(due, today) : 'date…'}
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
    listUsers()
      .then((u) => setUsers(u.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => toast.error('Could not load teammates'))
  }, [open, users.length])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="focus-ring">
          <Pill active={assignee !== null}>
            {assignee ? (
              <>
                <InitialsMark name={assignee.name} size="xs" />
                <span className="font-sans text-label">{assignee.name}</span>
              </>
            ) : (
              'assign to me'
            )}
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
      void searchEntities({
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
            <Pill dashed>+ link record</Pill>
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
