import { useRouter } from '@tanstack/react-router'
import { icon, Phone } from '#/components/icons'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { formatDay, formatTime } from '@spaces/core/format'
import { EMAIL_SUMMARY_MAX } from '@spaces/core/interactions/email-listing'
import { useClock } from '#/components/clock'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Segmented } from '#/components/ui/segmented'
import {
  logInteraction,
  searchEntities,
  writeUpInteraction,
} from '#/lib/server-fns'
import { clearLogged, markLogged } from '#/lib/timeline/log-state'
import type { LoggableKind } from '#/lib/timeline/log-state'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * Manual interaction logging — the calendar primitive, hand-fed. Twenty
 * seconds after a founder call: kind, title, when, who was in the room, and
 * a line of what happened. Calendar sync (`Content.logMeeting`) writes the
 * same kind of interaction row.
 */

type Attendee = { id: string; name: string; kind: string }

const KIND_WORD: Record<LoggableKind, string> = {
  call: 'Call',
  meeting: 'Meeting',
}

function localNow(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The log window.
 * - Opened over a record (`seed`), a write-up opens in the note window over
 *   it (`?modal=note&id=`); with no record underneath (Today) it is the
 *   note's page.
 * - The logged row sits on bone until its toast goes; the toast offers
 *   `Write it up` unless the write-up is already open.
 */
export function LogInteractionDialog({
  seed,
  trigger,
  hotkey,
  defaultKind = null,
}: {
  /**
   * The record the dialog was opened from — pre-added as an attendee.
   * Omitted where no record is in view (Today): the room starts empty.
   */
  seed?: Attendee
  /**
   * Custom trigger element — must forward props (plain DOM elements do).
   * `null` draws no trigger: the hotkey and Cmd-K are the only ways in.
   */
  trigger?: React.ReactNode
  /** Bare key that opens the dialog from the page. */
  hotkey?: string
  /** The kind it opens on: the Interactions tab's Calls or Meetings. */
  defaultKind?: LoggableKind | null | undefined
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<LoggableKind>('meeting')
  const show = () => {
    setKind(defaultKind ?? 'meeting')
    setOpen(true)
  }
  useHotkey(hotkey, show)
  const [subject, setSubject] = useState('')
  const [occurredAt, setOccurredAt] = useState(localNow)
  const [attendees, setAttendees] = useState<Array<Attendee>>(
    seed ? [seed] : [],
  )
  const [summary, setSummary] = useState('')
  // The one variant of the one commit: the same log, plus its note, with
  // the editor as the landing.
  const [writeUp, setWriteUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function openNote(noteId: string) {
    if (seed === undefined) {
      void router.navigate({ to: '/notes/$noteId', params: { noteId } })
      return
    }
    void router.navigate({
      to: '.',
      search: (prev) => ({ ...prev, modal: 'note' as const, id: noteId }),
      resetScroll: false,
    })
  }

  async function writeItUp(interactionId: string) {
    try {
      const { noteId } = await writeUpInteraction({ data: { interactionId } })
      void router.invalidate()
      openNote(noteId)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not write it up')
    }
  }

  async function submit() {
    setError(null)
    if (!subject.trim()) return setError('What was it about?')
    if (attendees.length === 0) return setError('Who was involved?')
    setPending(true)
    try {
      const logged = await logInteraction({
        data: {
          kind,
          subject: subject.trim(),
          occurredAt,
          attendeeIds: attendees.map((a) => a.id),
          writeUp,
          ...(summary.trim() === '' ? {} : { summary: summary.trim() }),
        },
      })
      setOpen(false)
      setSubject('')
      setOccurredAt(localNow())
      setAttendees(seed ? [seed] : [])
      setSummary('')
      setWriteUp(false)
      markLogged(logged.id)
      const done = () => clearLogged(logged.id)
      const noteId = logged.noteId
      toast(`${KIND_WORD[kind]} logged`, {
        onDismiss: done,
        onAutoClose: done,
        ...(noteId === null
          ? {
              action: {
                label: 'Write it up',
                onClick: () => void writeItUp(logged.id),
              },
            }
          : {}),
      })
      void router.invalidate()
      if (noteId !== null) openNote(noteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log it')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? show() : setOpen(false))}
    >
      {trigger === null ? null : (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="xs" variant="outline">
              <Phone className="size-4" />
              Log meeting
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent
        size="m"
        // No record in view, no description: say so rather than leave Radix
        // looking for one.
        {...(seed ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>Log interaction</DialogTitle>
          {seed ? <DialogDescription>{seed.name}</DialogDescription> : null}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="space-y-4"
          noValidate
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.requestSubmit()
            }
          }}
        >
          <Segmented
            label="Interaction kind"
            value={kind}
            options={[
              { id: 'call', label: 'Call' },
              { id: 'meeting', label: 'Meeting' },
            ]}
            onChange={setKind}
          />

          {/* The When lane grows to the native control, whatever its locale. */}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(13rem,max-content)] gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="int-subject">About</Label>
              <Input
                id="int-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                autoFocus
                placeholder="Series B intro"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="int-when">When</Label>
              <WhenField value={occurredAt} onChange={setOccurredAt} />
            </div>
          </div>

          <AttendeeField attendees={attendees} onChange={setAttendees} />

          <div className="space-y-1.5">
            <Label htmlFor="int-summary">Summary</Label>
            <textarea
              id="int-summary"
              rows={2}
              maxLength={EMAIL_SUMMARY_MAX}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What happened, in a line or two"
              className="focus-ring w-full resize-none rounded-md border border-rule bg-paper px-2.5 py-1.5 text-ui outline-none placeholder:text-graphite"
            />
          </div>

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <label className="mr-auto flex items-center gap-2 text-ui">
              <Checkbox checked={writeUp} onCheckedChange={setWriteUp} />
              Write it up next
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              shortcut="⌘↵"
              pending={pending}
              disabled={pending}
            >
              {kind === 'meeting' ? 'Log meeting' : 'Log call'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** `13 Oct, 10:42` — a `datetime-local` value as the app prints a moment. */
function whenText(value: string, today: string): string {
  // A cleared control reads as the empty dash, as a cell does.
  if (value === '') return '—'
  const day = formatDay(value, today)
  return day === '' ? value : `${day}, ${formatTime(value)}`
}

/**
 * When, printed the app's way until clicked, then the native control with
 * its picker open. At rest the native control prints the browser's locale
 * (`10/13/2026, 10:42 AM`), which no other date in the app does.
 */
function WhenField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const { today } = useClock()

  useEffect(() => {
    if (!editing) return
    // The click that opened the field is the activation `showPicker` needs.
    try {
      input.current?.showPicker()
    } catch {
      // No picker to show (an older engine, or no activation): typing works.
    }
  }, [editing])

  return editing ? (
    <Input
      ref={input}
      id="int-when"
      type="datetime-local"
      autoFocus
      className="tabular"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
    />
  ) : (
    <button
      type="button"
      id="int-when"
      onClick={() => setEditing(true)}
      className={cn(
        'tabular focus-ring flex h-8 w-full items-center rounded-md border border-rule bg-paper px-2.5 text-left text-ui transition-colors duration-150 ease-out-quart',
        value === '' && 'text-graphite',
      )}
    >
      {whenText(value, today)}
    </button>
  )
}

/**
 * Who was in the room: the chips and the search in one field. A chip is the
 * name and its ×; the suggestions open under the field in a dithered sheet,
 * each with its kind. ↑↓ walk them, ↵ adds one, ⌫ in an empty search takes
 * the last chip back.
 */
function AttendeeField({
  attendees,
  onChange,
}: {
  attendees: Array<Attendee>
  onChange: (a: Array<Attendee>) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<Attendee>>([])
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!query.trim()) return setResults([])
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const r = await searchEntities({
          data: { q: query, kinds: ['person', 'company', 'deal'] },
        })
        if (!alive) return
        setResults(r.filter((x) => !attendees.some((a) => a.id === x.id)))
        setActive(0)
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, attendees])

  function add(r: Attendee) {
    onChange([...attendees, r])
    setQuery('')
    setResults([])
    input.current?.focus()
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="int-attendees">Who was involved</Label>
      <div className="relative">
        <div
          data-attendee-field
          onClick={() => input.current?.focus()}
          className="focus-ring-within flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-rule bg-paper p-1"
        >
          {attendees.map((a) => (
            <span
              key={a.id}
              data-attendee={a.id}
              className="flex h-6 items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2 text-label"
            >
              {a.name}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(attendees.filter((x) => x.id !== a.id))
                }}
                className="focus-ring text-graphite hover:text-foreground"
              >
                <icon.close className="size-4" />
              </button>
            </span>
          ))}
          <input
            ref={input}
            id="int-attendees"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && query === '') {
                onChange(attendees.slice(0, -1))
                return
              }
              if (results.length === 0) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => (i + 1) % results.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => (i - 1 + results.length) % results.length)
              } else if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
                // ↵ adds the highlighted suggestion, never submits the log.
                e.preventDefault()
                const r = results.at(active)
                if (r) add(r)
              } else if (e.key === 'Escape') {
                // The sheet closes first; a second Esc closes the window.
                e.preventDefault()
                e.stopPropagation()
                setResults([])
              }
            }}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="int-attendee-results"
            autoComplete="off"
            placeholder={
              attendees.length === 0 ? 'Add people, companies, deals…' : ''
            }
            className="h-6 min-w-32 flex-1 bg-transparent px-1.5 text-ui outline-none placeholder:text-graphite"
          />
        </div>
        {results.length > 0 ? (
          <ul
            id="int-attendee-results"
            role="listbox"
            aria-label="Suggestions"
            className="absolute inset-x-0 top-full z-dropdown mt-1 max-h-40 overflow-y-auto border border-hairline bg-paper shadow-dither"
          >
            {results.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => add(r)}
                  className={cn(
                    'flex h-7 w-full items-center gap-2.5 px-2.5 text-left text-ui',
                    i === active && 'bg-bone',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="shrink-0 label-caps text-graphite">
                    {r.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
