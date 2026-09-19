import { useRouter } from '@tanstack/react-router'
import { Phone, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyHint } from '#/components/page-header'
import { DitherMark, InitialsMark } from '#/components/record/record-parts'
import { Button } from '#/components/ui/button'
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
import { logInteraction, searchEntities } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { useHotkey } from '#/lib/use-hotkey'

/**
 * Manual interaction logging — the calendar primitive, hand-fed. Twenty
 * seconds after a founder call: kind, title, when, who was in the room.
 * Google Calendar later automates rows into exactly this shape.
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
  onLogged,
  trigger,
  hotkey,
}: {
  /** the record the dialog was opened from — pre-added as an attendee */
  seed: Attendee
  onLogged?: () => void
  /** custom trigger element — must forward props (plain DOM elements do) */
  trigger?: React.ReactNode
  /** bare key that opens the dialog from the page — printed in the trigger */
  hotkey?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  useHotkey(hotkey, () => setOpen(true))
  const [kind, setKind] = useState<'meeting' | 'call'>('meeting')
  const [subject, setSubject] = useState('')
  const [occurredAt, setOccurredAt] = useState(localNow)
  const [attendees, setAttendees] = useState<Array<Attendee>>([seed])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!subject.trim()) return setError('What was it about?')
    setPending(true)
    try {
      await logInteraction({
        data: {
          kind,
          subject: subject.trim(),
          occurredAt,
          attendeeIds: attendees.map((a) => a.id),
        },
      })
      setOpen(false)
      setSubject('')
      setOccurredAt(localNow())
      setAttendees([seed])
      toast(`${kind === 'meeting' ? 'Meeting' : 'Call'} logged`)
      onLogged?.()
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log it')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="xs" variant="outline">
            <Phone className="size-3" strokeWidth={1.75} />
            Log meeting
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[35rem]">
        <DialogHeader>
          <DialogTitle>Log interaction</DialogTitle>
          <DialogDescription>{seed.name}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          className="space-y-4"
          noValidate
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.requestSubmit()
            }
          }}
        >
          {/* Segmented type: ink for the chosen one, a digit in each. */}
          <div className="flex w-fit border border-hairline">
            {(['call', 'meeting'] as const).map((k, i) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  'focus-ring-inset flex h-7 items-center gap-2 px-3 text-label font-medium capitalize transition-colors',
                  i > 0 && 'border-l border-hairline',
                  kind === k
                    ? 'bg-hairline text-paper'
                    : 'text-foreground hover:bg-bone',
                )}
              >
                {k}
                <span className="mono text-micro font-normal opacity-70">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_12rem] gap-4">
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

          <AttendeePicker attendees={attendees} onChange={setAttendees} />

          {error ? (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter
            note={`lands in ${attendees.length} ledger${attendees.length === 1 ? '' : 's'}`}
          >
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" pending={pending}>
              {pending ? 'Logging…' : `Log ${kind}`}
              <KeyHint>⌘↵</KeyHint>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AttendeePicker({
  attendees,
  onChange,
}: {
  attendees: Array<Attendee>
  onChange: (a: Array<Attendee>) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<Attendee>>([])

  useEffect(() => {
    if (!query.trim()) return setResults([])
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const r = await searchEntities({
          data: { q: query, kinds: ['person', 'company', 'deal'] },
        })
        if (alive)
          setResults(r.filter((x) => !attendees.some((a) => a.id === x.id)))
      })()
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, attendees])

  return (
    <div className="space-y-1.5">
      <Label htmlFor="int-attendees">Who was involved</Label>
      <div className="flex flex-wrap gap-1.5">
        {attendees.map((a) => (
          <span
            key={a.id}
            className="flex h-6 items-center gap-1.5 border border-rule bg-paper px-2 text-label"
          >
            {a.kind === 'person' ? (
              <InitialsMark name={a.name} size="xs" />
            ) : (
              <DitherMark size={12} />
            )}
            {a.name}
            {attendees.length > 1 ? (
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onChange(attendees.filter((x) => x.id !== a.id))}
                className="focus-ring text-graphite hover:text-foreground"
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      <Input
        id="int-attendees"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add people, companies, deals…"
        className="h-8 text-ui"
      />
      {results.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto border border-hairline bg-paper shadow-[2px_2px_0_0_var(--hairline)]">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...attendees, r])
                  setQuery('')
                }}
                className="focus-ring-inset flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-ui hover:bg-bone"
              >
                {r.kind === 'person' ? (
                  <InitialsMark name={r.name} size="xs" outline />
                ) : (
                  <DitherMark size={14} />
                )}
                {r.name}
                <span className="ml-auto mono text-micro text-graphite">
                  {r.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-label text-graphite">
        <Plus className="mr-0.5 inline size-3" strokeWidth={2} />
        You're included automatically via the log entry.
      </p>
    </div>
  )
}
