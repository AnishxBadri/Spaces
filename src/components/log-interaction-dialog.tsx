import { useRouter } from '@tanstack/react-router'
import { Building2, Kanban, Phone, Plus, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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

/**
 * Manual interaction logging — the calendar primitive, hand-fed. Twenty
 * seconds after a founder call: kind, title, when, who was in the room.
 * Google Calendar later automates rows into exactly this shape.
 */

type Attendee = { id: string; name: string; kind: string }

const KIND_ICONS: Record<string, typeof Users> = {
  person: Users,
  company: Building2,
  deal: Kanban,
}

function localNow(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function LogInteractionDialog({
  seed,
  onLogged,
}: {
  /** the record the dialog was opened from — pre-added as an attendee */
  seed: Attendee
  onLogged?: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
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
      router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log it')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="xs" variant="outline">
          <Phone className="size-3" strokeWidth={1.75} />
          Log meeting
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Log an interaction</DialogTitle>
          <DialogDescription>
            It lands on the timeline of everyone involved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="flex rounded-md border border-border p-0.5">
            {(['meeting', 'call'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  kind === k
                    ? 'bg-selected text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {k}
              </button>
            ))}
          </div>

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
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </div>

          <AttendeePicker attendees={attendees} onChange={setAttendees} />

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Logging…' : 'Log it'}
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
    const t = setTimeout(async () => {
      const r = await searchEntities({
        data: { q: query, kinds: ['person', 'company', 'deal'] },
      })
      if (alive)
        setResults(r.filter((x) => !attendees.some((a) => a.id === x.id)))
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, attendees])

  return (
    <div className="space-y-1.5">
      <Label htmlFor="int-attendees">Who was involved</Label>
      <div className="flex flex-wrap gap-1">
        {attendees.map((a) => {
          const Icon = KIND_ICONS[a.kind] ?? Users
          return (
            <span
              key={a.id}
              className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
            >
              <Icon className="size-2.5" strokeWidth={1.75} />
              {a.name}
              {attendees.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    onChange(attendees.filter((x) => x.id !== a.id))
                  }
                  className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <X className="size-2.5" strokeWidth={2} />
                </button>
              ) : null}
            </span>
          )
        })}
      </div>
      <Input
        id="int-attendees"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add people, companies, deals…"
        className="h-8 text-[13px]"
      />
      {results.length > 0 ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border">
          {results.map((r) => {
            const Icon = KIND_ICONS[r.kind] ?? Users
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange([...attendees, r])
                    setQuery('')
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Icon className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                  {r.name}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.kind}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <Plus className="mr-0.5 inline size-3" strokeWidth={2} />
        You're included automatically via the log entry.
      </p>
    </div>
  )
}
