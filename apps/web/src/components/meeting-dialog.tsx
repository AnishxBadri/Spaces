import { Link, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '#/components/document-preview'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { OpenIn, ViaMark } from '#/components/open-in'
import { DensityRamp } from '#/components/dither'
import { DetailsPickRow } from '#/components/record/details-add'
import type { PickHit } from '#/components/record/details-add'
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
  MeetingDetail,
  MeetingSuggestion,
  PrepEvent,
} from '#/lib/server-fns'
import {
  googleDayUrl,
  meetingWhen,
  participantName,
  RSVP_MARK,
  RSVP_WORD,
} from '#/lib/meetings/day'
import { recordPath } from '#/lib/record-path'
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

const ROLE_WORD: Record<MeetingArtifact['role'], string> = {
  transcript: 'transcript',
  recording_link: 'recording',
  attachment: 'attachment',
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

function Empty({ children }: { children: ReactNode }) {
  return (
    <LedgerRow last>
      <span className="text-ui text-graphite">{children}</span>
    </LedgerRow>
  )
}

const rowLink =
  'focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone'

function SuggestionRow({
  s,
  onDecided,
}: {
  s: MeetingSuggestion
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
      <span className="w-20 shrink-0 mono text-micro text-graphite">
        {s.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-body">{s.summary}</span>
      <Button
        variant="ghost"
        size="sm"
        pending={pending === 'reject'}
        disabled={pending !== null}
        onClick={() => void decide('reject')}
      >
        Reject
      </Button>
      <Button
        variant="outline"
        size="sm"
        pending={pending === 'accept'}
        disabled={pending !== null}
        onClick={() => void decide('accept')}
      >
        Accept
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
            <DensityRamp width={120} />
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

/**
 * The meeting window: time and the conference link in the head;
 * participants with their RSVP, shown and never edited; linked records with
 * a pin to add one; the write-up; artifacts by role; open suggestions that
 * cite the meeting; and Prep, streamed on demand and never stored.
 * - Opens from a Meetings row and from `?modal=meeting&id=`.
 * - Cancel is the one close; Prep, then Save as note, is the one commit.
 */
export function MeetingDialog({
  id,
  prepOnOpen = false,
  onOpenChange,
  onChanged,
}: {
  id: string | null
  /** Start Prep once the meeting is read: the row's Prep. */
  prepOnOpen?: boolean
  onOpenChange: (open: boolean) => void
  /** A write landed: the caller re-reads what it shows. */
  onChanged?: () => void
}) {
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[42rem]">
        {id === null ? null : (
          <MeetingWindow
            key={id}
            id={id}
            prepOnOpen={prepOnOpen}
            onClose={() => onOpenChange(false)}
            {...(onChanged === undefined ? {} : { onChanged })}
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
}: {
  id: string
  prepOnOpen: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const router = useRouter()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prep, setPrep] = useState<PrepState>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
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

  const changed = () => {
    void load()
    onChanged?.()
  }

  const runPrep = useCallback(async () => {
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

  useEffect(() => {
    if (prepOnOpen && meeting !== null && !started.current) {
      started.current = true
      void runPrep()
    }
  }, [prepOnOpen, meeting, runPrep])

  async function saveAsNote(markdown: string) {
    setSaving(true)
    try {
      const { noteId } = await savePrepAsNote({
        data: { interactionId: id, markdown },
      })
      toast('Saved as a note')
      onClose()
      await router.navigate({ to: '/notes/$noteId', params: { noteId } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save it')
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
          <DensityRamp width={160} />
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

  const asked = prep.phase !== 'idle'
  return (
    <>
      <DialogHeader>
        <DialogTitle
          className={cn(meeting.cancelled && 'text-graphite line-through')}
        >
          {meeting.title ?? 'Meeting'}
        </DialogTitle>
        <DialogDescription>
          {meetingWhen(meeting.startsAt, meeting.endsAt)}
          {meeting.cancelled ? ' · cancelled' : ''}
        </DialogDescription>
        {meeting.conferenceUrl === null || meeting.cancelled ? null : (
          <a
            href={meeting.conferenceUrl}
            target="_blank"
            rel="noreferrer"
            title="Opens the call in a new tab"
            className="focus-ring ml-auto mono text-micro text-primary hover:underline"
          >
            join call ›
          </a>
        )}
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
              className="focus-ring shrink-0 mono text-micro text-foreground hover:underline"
            >
              Open in Google ›
            </a>
          }
        >
          {meeting.participants.length === 0 ? (
            <Empty>No participants.</Empty>
          ) : (
            meeting.participants.map((p) => (
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
                  {RSVP_MARK[p.rsvp]} {RSVP_WORD[p.rsvp]}
                </span>
              </LedgerRow>
            ))
          )}
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
                <span className="w-16 shrink-0 text-right mono text-micro text-graphite">
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

        <Group label="Write-up">
          {meeting.note === null ? (
            <LedgerRow last={meeting.notes.length === 0}>
              <span className="min-w-0 flex-1 text-ui text-graphite">
                Not written up.
              </span>
              <Button
                variant="outline"
                size="sm"
                pending={writing}
                disabled={writing}
                onClick={() => void writeUp()}
              >
                Write up
              </Button>
            </LedgerRow>
          ) : (
            <LedgerRow last={meeting.notes.length === 0}>
              <Link
                to="/notes/$noteId"
                params={{ noteId: meeting.note.id }}
                className={rowLink}
              >
                <span className="min-w-0 truncate text-body">
                  {meeting.note.title ?? 'Open note'}
                </span>
              </Link>
              <ViaMark via={meeting.note.via} />
              <OpenIn link={meeting.note.openIn} />
            </LedgerRow>
          )}
          {meeting.notes.map((n, i) => (
            <LedgerRow key={n.id} last={i === meeting.notes.length - 1}>
              <Link
                to="/notes/$noteId"
                params={{ noteId: n.id }}
                className={rowLink}
              >
                <span className="min-w-0 truncate text-body">{n.title}</span>
              </Link>
              {n.private ? (
                <span className="shrink-0 mono text-micro text-graphite">
                  private
                </span>
              ) : null}
              <ViaMark via={n.via} />
              <OpenIn link={n.openIn} />
            </LedgerRow>
          ))}
        </Group>

        <Group label="Artifacts">
          {meeting.artifacts.length === 0 ? (
            <Empty>No transcript or recording.</Empty>
          ) : (
            meeting.artifacts.map((a) => (
              <LedgerRow key={a.documentId}>
                <span className="w-20 shrink-0 mono text-micro text-graphite">
                  {ROLE_WORD[a.role]}
                </span>
                {a.role === 'recording_link' ? (
                  a.url === null ? (
                    <span className="min-w-0 flex-1 truncate text-body">
                      {a.name}
                    </span>
                  ) : (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Opens the recording where it is kept"
                      className={rowLink}
                    >
                      <span className="min-w-0 truncate text-body">
                        {a.name}
                      </span>
                    </a>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => void openArtifact(a)}
                    className={rowLink}
                  >
                    <span className="min-w-0 truncate text-body">{a.name}</span>
                  </button>
                )}
              </LedgerRow>
            ))
          )}
        </Group>

        {meeting.suggestions.length === 0 ? null : (
          <Group label="Suggestions">
            {meeting.suggestions.map((s) => (
              <SuggestionRow key={s.id} s={s} onDecided={changed} />
            ))}
          </Group>
        )}

        {asked ? (
          <Group label="Prep">
            <PrepBody prep={prep} />
          </Group>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {prep.phase === 'done' && prep.markdown !== '' ? (
          <Button
            pending={saving}
            disabled={saving}
            onClick={() => void saveAsNote(prep.markdown)}
          >
            Save as note
          </Button>
        ) : meeting.records.length === 0 ? null : (
          <Button
            title="Brief me on the linked records; nothing is kept unless saved"
            pending={prep.phase === 'running'}
            disabled={prep.phase === 'running'}
            onClick={() => void runPrep()}
          >
            {prep.phase === 'running' ? 'Prepping…' : 'Prep'}
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
