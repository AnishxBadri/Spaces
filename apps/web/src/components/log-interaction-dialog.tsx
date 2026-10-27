import { useRouter } from '@tanstack/react-router'
import { Phone, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
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
import { logInteraction, searchEntities } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * Manual interaction logging — the calendar primitive, hand-fed. Twenty
 * seconds after a founder call: kind, title, when, who was in the room.
 * Calendar sync (`Content.logMeeting`) writes the same kind of interaction row.
 */

type Attendee = { id: string; name: string; kind: string }

function localNow(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function LogInteractionDialog({
  seed,
  trigger,
  hotkey,
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
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [kind, setKind] = useState<'meeting' | 'call'>('meeting')
  const [subject, setSubject] = useState('')
  const [occurredAt, setOccurredAt] = useState(localNow)
  const [attendees, setAttendees] = useState<Array<Attendee>>(
    seed ? [seed] : [],
  )
  // The one variant of the one commit: the same log, plus its note, with
  // the editor as the landing.
  const [writeUp, setWriteUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

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
        },
      })
      setOpen(false)
      setSubject('')
      setOccurredAt(localNow())
      setAttendees(seed ? [seed] : [])
      setWriteUp(false)
      toast(`${kind === 'meeting' ? 'Meeting' : 'Call'} logged`)
      void router.invalidate()
      if (logged.noteId) {
        await router.navigate({
          to: '/notes/$noteId',
          params: { noteId: logged.noteId },
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log it')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === null ? null : (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="xs" variant="outline">
              <Phone className="size-3" strokeWidth={1.75} />
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

          <div className="grid grid-cols-[minmax(0,1fr)_11rem] gap-4">
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
              <Input
                id="int-when"
                type="datetime-local"
                className="mono"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </div>
          </div>

          <AttendeeField attendees={attendees} onChange={setAttendees} />

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
                <X className="size-2.5" strokeWidth={2} />
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
