import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { dayKey, formatDay, formatTime } from '@spaces/core/format'
import { DocumentPreview } from '#/components/document-preview'
import { EmptyRow, LabelHead, LedgerRow } from '#/components/ledger-section'
import { OpenIn } from '#/components/open-in'
import { DetailsPickRow } from '#/components/record/details-add'
import type { PickHit } from '#/components/record/details-add'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  acceptSuggestion,
  getDocumentPreview,
  getMeeting,
  pinMeetingRecord,
  prepMeeting,
  rejectSuggestion,
  savePrepAsNote,
  searchEntities,
  writeUpInteraction,
} from '#/lib/server-fns'
import type {
  MeetingArtifact,
  MeetingCarriedNote,
  MeetingDetail,
  MeetingSuggestion,
  PrepEvent,
} from '#/lib/server-fns'
import {
  googleDayUrl,
  participantName,
  RSVP_MARK,
  timeSpan,
} from '#/lib/meetings/day'
import type { NoteVia } from '#/lib/notes/via-mark'
import { recordPath } from '#/lib/record-path'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/** Prep's state in the window: nothing until asked, and never stored. */
export type PrepState =
  | { phase: 'idle' }
  | { phase: 'running'; line: string | null; sensitive: boolean; text: string }
  | { phase: 'done'; line: string; sensitive: boolean; markdown: string }
  | { phase: 'refused'; line: string }
  | { phase: 'failed'; message: string }

/** One Prep event applied to the window's state. */
export function applyPrepEvent(state: PrepState, event: PrepEvent): PrepState {
  switch (event.type) {
    case 'route':
      return {
        phase: 'running',
        line: event.line,
        sensitive: event.sensitive,
        text: '',
      }
    case 'text':
      return state.phase === 'running'
        ? { ...state, text: state.text + event.text }
        : state
    case 'done':
      return state.phase === 'running'
        ? {
            phase: 'done',
            line: state.line ?? '',
            sensitive: state.sensitive,
            markdown: event.markdown,
          }
        : state
    case 'refused':
      return { phase: 'refused', line: event.line }
    case 'failed':
      return { phase: 'failed', message: event.message }
  }
}

/** An answer as the participants lane prints it: `✓ Accepted`. */
const RSVP_LABEL: Record<
  MeetingDetail['participants'][number]['rsvp'],
  string
> = {
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Maybe',
  needs_action: 'No answer',
}

const ROLE_WORD: Record<MeetingArtifact['role'], string> = {
  transcript: 'Transcript',
  recording_link: 'Recording',
  attachment: 'Attachment',
}

/** `16:02` on the reader's day, else `13 Oct`. */
const stamp = (iso: string, today: string) =>
  dayKey(iso) === today ? formatTime(iso) : formatDay(iso, today)

/** `Via Granola · Anish · 16:02`; the time alone for a note typed here. */
export function writeUpLine(
  via: NoteVia | null,
  at: string,
  today: string,
): string {
  return [
    via === null ? null : `Via ${via.tool} · ${via.author}`,
    stamp(at, today),
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** A group inside the window: a mono caps label on a hairline. */
function Group({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <LabelHead label={label}>{action}</LabelHead>
      <ol>{children}</ol>
    </section>
  )
}

const rowLink =
  'focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone'

/** A task the meeting proposed: its due day, then Skip and Add task. */
function ActionItem({
  s,
  today,
  onDecided,
}: {
  s: MeetingSuggestion
  today: string
  onDecided: () => void
}) {
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null)
  async function decide(verb: 'accept' | 'reject') {
    setPending(verb)
    try {
      if (verb === 'accept') await acceptSuggestion({ data: { id: s.id } })
      else await rejectSuggestion({ data: { id: s.id } })
      onDecided()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not decide it')
      setPending(null)
    }
  }
  return (
    <LedgerRow>
      <span className="min-w-0 flex-1 truncate text-body">{s.summary}</span>
      {s.due === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">
          {formatDay(s.due, today)}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        pending={pending === 'reject'}
        disabled={pending !== null}
        onClick={() => void decide('reject')}
      >
        Skip
      </Button>
      <Button
        variant="outline"
        size="sm"
        pending={pending === 'accept'}
        disabled={pending !== null}
        onClick={() => void decide('accept')}
      >
        Add task
      </Button>
    </LedgerRow>
  )
}

function PrepBody({ prep }: { prep: PrepState }) {
  switch (prep.phase) {
    case 'idle':
      return null
    case 'refused':
      return (
        <LedgerRow last className="h-auto py-2.5">
          <span data-prep-refused className="text-ui text-warning">
            {prep.line}
          </span>
        </LedgerRow>
      )
    case 'failed':
      return (
        <LedgerRow last className="h-auto py-2.5">
          <span className="text-ui text-destructive">{prep.message}</span>
        </LedgerRow>
      )
    case 'running':
    case 'done': {
      const text = prep.phase === 'done' ? prep.markdown : prep.text
      return (
        <li className="flex flex-col gap-2 px-3 py-2.5">
          {prep.line === null ? (
            <Twinkle size={14} />
          ) : (
            <span
              data-prep-route
              className={cn(
                'mono text-micro',
                prep.sensitive ? 'text-warning' : 'text-graphite',
              )}
            >
              {prep.line}
            </span>
          )}
          {text === '' ? null : (
            <div className="text-ui whitespace-pre-wrap text-foreground">
              {text}
            </div>
          )}
        </li>
      )
    }
  }
}

/** A note beyond the write-up, or an artifact, as one bordered row. */
function CarriedRow({
  children,
  end,
}: {
  children: ReactNode
  end?: ReactNode
}) {
  return (
    <li className="flex min-h-10 items-center gap-3 border border-rule px-3">
      {children}
      {end}
    </li>
  )
}

function NoteRow({ n }: { n: MeetingCarriedNote }) {
  return (
    <CarriedRow end={<OpenIn link={n.openIn} />}>
      <Link
        to="/notes/$noteId"
        params={{ noteId: n.id }}
        className="focus-ring min-w-0 flex-1 truncate text-body hover:underline"
      >
        {n.title}
      </Link>
      {n.via === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">
          {`Via ${n.via.tool} · ${n.via.author}`}
        </span>
      )}
    </CarriedRow>
  )
}

function ArtifactRow({
  a,
  onOpen,
}: {
  a: MeetingArtifact
  onOpen: (a: MeetingArtifact) => void
}) {
  return (
    <CarriedRow>
      <span className="w-20 shrink-0 label-caps text-graphite">
        {ROLE_WORD[a.role]}
      </span>
      {a.role === 'recording_link' ? (
        a.url === null ? (
          <span className="min-w-0 flex-1 truncate text-body">{a.name}</span>
        ) : (
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            title="Opens the recording where it is kept"
            className="focus-ring min-w-0 flex-1 truncate text-body hover:underline"
          >
            {a.name}
          </a>
        )
      ) : (
        <button
          type="button"
          onClick={() => onOpen(a)}
          className="focus-ring min-w-0 flex-1 truncate text-left text-body hover:underline"
        >
          {a.name}
        </button>
      )}
    </CarriedRow>
  )
}

/**
 * The meeting window: when, and the call to join while it is ahead;
 * participants with their answers, shown and never edited; linked records
 * with a pin; the write-up read in place; the tasks it proposed; what is
 * private to the reader; and Prep, before the start only, streamed and
 * never stored unless saved.
 * - Opens from a Meetings row and from `?modal=meeting&id=`.
 * - Cancel is the one close; Prep, then Save as note, is the one commit,
 *   and Save as note stays put, reading `Saved as note` once it is.
 */
export function MeetingDialog({
  id,
  prepOnOpen = false,
  onOpenChange,
  onChanged,
  onPrepRunning,
}: {
  id: string | null
  /** Start Prep once the meeting is read: the row's Prep. */
  prepOnOpen?: boolean
  onOpenChange: (open: boolean) => void
  /** A write landed: the caller re-reads what it shows. */
  onChanged?: () => void
  /** Prep started or stopped, so the row behind can say it is running. */
  onPrepRunning?: (running: boolean) => void
}) {
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent size="l">
        {id === null ? null : (
          <MeetingWindow
            key={id}
            id={id}
            prepOnOpen={prepOnOpen}
            onClose={() => onOpenChange(false)}
            {...(onChanged === undefined ? {} : { onChanged })}
            {...(onPrepRunning === undefined ? {} : { onPrepRunning })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MeetingWindow({
  id,
  prepOnOpen,
  onClose,
  onChanged,
  onPrepRunning,
}: {
  id: string
  prepOnOpen: boolean
  onClose: () => void
  onChanged?: () => void
  onPrepRunning?: (running: boolean) => void
}) {
  const router = useRouter()
  const { now, today } = useClock()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prep, setPrep] = useState<PrepState>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [writing, setWriting] = useState(false)
  const [viewer, setViewer] = useState<Awaited<
    ReturnType<typeof getDocumentPreview>
  > | null>(null)
  const reader = useRef<ReadableStreamDefaultReader<PrepEvent> | null>(null)
  const started = useRef(false)

  const load = useCallback(async () => {
    try {
      setMeeting(await getMeeting({ data: { id } }))
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read the meeting',
      )
    }
  }, [id])

  // Whether the window is still open: a Prep whose stream arrives after it
  // closed is cancelled the moment it is obtained.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Closing the window stops a running Prep; nothing of it is kept.
      void reader.current?.cancel()
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Closing the window stops Prep, so it reports stopped as it unmounts.
  const running = prep.phase === 'running'
  useEffect(() => {
    if (!running) return
    onPrepRunning?.(true)
    return () => onPrepRunning?.(false)
  }, [running, onPrepRunning])

  const changed = () => {
    void load()
    onChanged?.()
  }

  const runPrep = useCallback(async () => {
    setSaved(false)
    setPrep({ phase: 'running', line: null, sensitive: false, text: '' })
    try {
      const stream = await prepMeeting({ data: { interactionId: id } })
      const r = stream.getReader()
      if (!alive.current) {
        await r.cancel()
        return
      }
      reader.current = r
      for (;;) {
        const next = await r.read()
        if (next.done) break
        const event = next.value
        setPrep((s) => applyPrepEvent(s, event))
      }
    } catch {
      if (alive.current)
        setPrep({ phase: 'failed', message: 'Prep stopped before it finished' })
    } finally {
      reader.current = null
    }
  }, [id])

  // Prep is for a meeting still ahead: once it has started there is none.
  const ahead = meeting !== null && now < meeting.startsAt
  useEffect(() => {
    if (prepOnOpen && ahead && !started.current) {
      started.current = true
      void runPrep()
    }
  }, [prepOnOpen, ahead, runPrep])

  async function saveAsNote(markdown: string) {
    setSaving(true)
    try {
      await savePrepAsNote({ data: { interactionId: id, markdown } })
      setSaved(true)
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save it')
    } finally {
      setSaving(false)
    }
  }

  async function writeUp() {
    setWriting(true)
    try {
      const { noteId } = await writeUpInteraction({
        data: { interactionId: id },
      })
      onChanged?.()
      onClose()
      await router.navigate({ to: '/notes/$noteId', params: { noteId } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not write it up')
      setWriting(false)
    }
  }

  const searchRecords = useCallback(
    async (q: string): Promise<ReadonlyArray<PickHit>> => {
      const on = new Set(meeting?.records.map((r) => r.id) ?? [])
      const rows = await searchEntities({
        data: { q, kinds: ['company', 'person', 'deal'] },
      })
      return rows.filter((r) => !on.has(r.id))
    },
    [meeting],
  )

  async function openArtifact(a: MeetingArtifact) {
    const doc = await getDocumentPreview({ data: { id: a.documentId } })
    if (doc) setViewer(doc)
  }

  if (meeting === null)
    return (
      <>
        <DialogHeader>
          <DialogTitle>Meeting</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          The meeting is being read
        </DialogDescription>
        {error === null ? (
          <div className="flex min-h-48 flex-1 items-center justify-center">
            <Twinkle size={29} />
          </div>
        ) : (
          <p className="text-ui text-destructive">{error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    )

  const joinable =
    meeting.conferenceUrl !== null && !meeting.cancelled && now < meeting.endsAt
  const tasks = meeting.suggestions.filter((s) => s.kind === 'task')
  const sharedNotes = meeting.notes.filter((n) => !n.private)
  const privateNotes = meeting.notes.filter((n) => n.private)
  const sharedArtifacts = meeting.artifacts.filter((a) => !a.private)
  const privateArtifacts = meeting.artifacts.filter((a) => a.private)
  const carried = sharedNotes.length + sharedArtifacts.length > 0
  const writeUpNote = meeting.note
  const done = prep.phase === 'done' && prep.markdown !== ''

  return (
    <>
      <DialogHeader>
        <DialogTitle
          className={cn(meeting.cancelled && 'text-graphite line-through')}
        >
          {meeting.title ?? 'Meeting'}
        </DialogTitle>
        <DialogDescription>
          {formatDay(meeting.startsAt, today)} ·{' '}
          {timeSpan(meeting.startsAt, meeting.endsAt)}
          {meeting.cancelled ? ' · Cancelled' : ''}
        </DialogDescription>
        {joinable && meeting.conferenceUrl !== null ? (
          <a
            href={meeting.conferenceUrl}
            target="_blank"
            rel="noreferrer"
            title="Opens the call in a new tab"
            className="focus-ring ml-auto text-ui text-primary hover:underline"
          >
            Join call ›
          </a>
        ) : null}
      </DialogHeader>

      <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5">
        <Group
          label="Participants"
          action={
            <a
              href={googleDayUrl(meeting.startsAt)}
              target="_blank"
              rel="noreferrer"
              title="Answers change in Google Calendar"
              className="focus-ring shrink-0 text-label text-foreground hover:underline"
            >
              Open in Google ›
            </a>
          }
        >
          {meeting.participants.map((p) => (
            <LedgerRow key={p.email}>
              <span className="min-w-0 flex-1 truncate text-body">
                {participantName(p)}
              </span>
              {p.name === null ? null : (
                <span className="min-w-0 truncate mono text-micro text-graphite">
                  {p.email}
                </span>
              )}
              <span
                data-rsvp={p.rsvp}
                className="w-24 shrink-0 text-right mono text-micro text-graphite"
              >
                {RSVP_MARK[p.rsvp]} {RSVP_LABEL[p.rsvp]}
              </span>
            </LedgerRow>
          ))}
        </Group>

        <Group label="Linked records">
          {meeting.records.map((r) => {
            const to = recordPath(r)
            return (
              <LedgerRow key={r.id}>
                {to === null ? (
                  <span className="min-w-0 flex-1 truncate text-body">
                    {r.name}
                  </span>
                ) : (
                  <Link to={to} className={rowLink}>
                    <span className="min-w-0 truncate text-body">{r.name}</span>
                  </Link>
                )}
                <span className="w-16 shrink-0 text-right label-caps text-graphite">
                  {r.kind}
                </span>
              </LedgerRow>
            )
          })}
          <li className="px-3">
            <DetailsPickRow
              label="Pin a record…"
              placeholder="Company, person or deal…"
              search={searchRecords}
              onPick={async (hit) => {
                await pinMeetingRecord({
                  data: { interactionId: id, entityId: hit.id },
                })
                changed()
              }}
            />
          </li>
        </Group>

        {writeUpNote === null ? (
          <section aria-label="Write-up" className="flex flex-col gap-2">
            <EmptyRow
              name="Write-up"
              disabled={writing}
              onAdd={() => void writeUp()}
            />
            {carried ? (
              <ul className="flex flex-col gap-1.5">
                {sharedNotes.map((n) => (
                  <NoteRow key={n.id} n={n} />
                ))}
                {sharedArtifacts.map((a) => (
                  <ArtifactRow
                    key={a.documentId}
                    a={a}
                    onOpen={(x) => void openArtifact(x)}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        ) : (
          <section aria-label="Write-up" className="flex flex-col">
            <LabelHead label="Write-up">
              <span
                data-write-up-line
                className="shrink-0 mono text-micro text-graphite"
              >
                {writeUpLine(writeUpNote.via, writeUpNote.at, today)}
              </span>
              <OpenIn link={writeUpNote.openIn} />
            </LabelHead>
            <div className="flex flex-col gap-3 px-3 py-3">
              {writeUpNote.title === null ? (
                <p className="text-ui text-graphite">Private to its author.</p>
              ) : (
                <>
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: writeUpNote.id }}
                    className="focus-ring self-start text-ui text-foreground hover:underline"
                  >
                    {writeUpNote.title}
                  </Link>
                  {writeUpNote.body === null ||
                  writeUpNote.body.trim() === '' ? null : (
                    <div
                      data-write-up-body
                      className="text-prose font-serif leading-6.75 whitespace-pre-wrap text-foreground"
                    >
                      {writeUpNote.body}
                    </div>
                  )}
                </>
              )}
              {carried ? (
                <ul className="flex flex-col gap-1.5">
                  {sharedNotes.map((n) => (
                    <NoteRow key={n.id} n={n} />
                  ))}
                  {sharedArtifacts.map((a) => (
                    <ArtifactRow
                      key={a.documentId}
                      a={a}
                      onOpen={(x) => void openArtifact(x)}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        )}

        {tasks.length === 0 ? null : (
          <Group
            label="Action items"
            action={
              <span className="shrink-0 mono text-micro text-graphite">
                {tasks.length} in Review
              </span>
            }
          >
            {tasks.map((s) => (
              <ActionItem key={s.id} s={s} today={today} onDecided={changed} />
            ))}
          </Group>
        )}

        {privateNotes.length + privateArtifacts.length === 0 ? null : (
          <section aria-label="Private to you" className="flex flex-col">
            <LabelHead label="Private to you" />
            <ul className="flex flex-col gap-1.5 pt-2">
              {privateArtifacts.map((a) => (
                <ArtifactRow
                  key={a.documentId}
                  a={a}
                  onOpen={(x) => void openArtifact(x)}
                />
              ))}
              {privateNotes.map((n) => (
                <NoteRow key={n.id} n={n} />
              ))}
            </ul>
          </section>
        )}

        {ahead && prep.phase !== 'idle' ? (
          <Group label="Prep">
            <PrepBody prep={prep} />
          </Group>
        ) : null}
      </div>

      <DialogFooter {...(done ? { note: 'Not kept unless saved' } : {})}>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {!ahead ? null : done ? (
          <Button
            pending={saving}
            disabled={saving || saved}
            onClick={() => void saveAsNote(prep.markdown)}
          >
            {saved ? 'Saved as note' : 'Save as note'}
          </Button>
        ) : meeting.records.length === 0 ? null : (
          <Button
            title="Brief me on the linked records; nothing is kept unless saved"
            pending={prep.phase === 'running'}
            disabled={prep.phase === 'running'}
            onClick={() => void runPrep()}
          >
            Prep
          </Button>
        )}
      </DialogFooter>

      <DocumentPreview
        doc={viewer}
        onOpenChange={(open) => {
          if (!open) setViewer(null)
        }}
      />
    </>
  )
}
