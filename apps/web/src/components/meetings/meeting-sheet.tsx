import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useClock } from '#/components/clock'
import type { PickHit } from '#/components/record/details-add'
import { useNow } from '#/components/today/day-strip'
import { Twinkle } from '#/components/twinkle'
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { WindowControls } from '#/components/ui/window-controls'
import { addMention, openAsk } from '#/lib/ask/dock-store'
import { googleDayUrl } from '#/lib/meetings/day'
import { isOver } from '#/lib/meetings/sheet'
import {
  askAboutBrief,
  getMeetingSheet,
  pinMeetingRecord,
  prepMeeting,
  savePrepAsNote,
  searchEntities,
  writeUpInteraction,
} from '#/lib/server-fns'
import type { MeetingSheetData, PrepEvent } from '#/lib/server-fns'
import { ActionItemsCard } from './action-items-card'
import { applyPrepEvent, BriefCard } from './brief-card'
import type { PrepState } from './brief-card'
import { CarriedCard, CarriedList } from './carried'
import { NoWriteUpCard } from './no-write-up-card'
import { RecentCard } from './recent-card'
import { SheetHead } from './sheet-head'
import type { SheetFrame } from './sheet-head'
import { PeopleGroup, RecordsGroup, WhereGroup } from './sheet-rail'
import { WriteUpCard } from './write-up-card'

export { applyPrepEvent }
export type { PrepState, SheetFrame }

/** The head while the meeting is read: its window still needs a title. */
function LoadingHead({ frame }: { frame: SheetFrame }) {
  const className =
    'mx-0 mt-0 mb-0 flex h-23 shrink-0 flex-row flex-nowrap items-center gap-4 border-b border-rule bg-paper px-5 py-0'
  if (frame === 'pane')
    return (
      <div data-pane-head className={className}>
        <h2 className="font-serif text-page font-semibold">Meeting</h2>
      </div>
    )
  return (
    <DialogHeader className={className}>
      <DialogTitle className="flex-1 font-serif text-page font-semibold">
        Meeting
      </DialogTitle>
      <DialogDescription className="sr-only">
        The meeting is being read
      </DialogDescription>
      <WindowControls />
    </DialogHeader>
  )
}

/**
 * One meeting as one sheet, in the Meetings page's pane and in the window a
 * record or Today opens: the head, a bone rail of where, who and what it is
 * filed on, and a body of cards. Before it ends the body is the brief and
 * `Recent`; after, the write-up and its action items, or `No write-up`.
 * - `frame` is what holds it. A `window` closes from its head; a `pane`
 *   stands in the page.
 * - Over a record (`onOpenNote`), the write-up and the meeting's notes open
 *   in the note window; elsewhere they open their page.
 * - `next` is the list's word on whether this is the next meeting today.
 */
export function MeetingSheet({
  id,
  frame,
  next = null,
  onClose,
  onChanged,
  onOpenNote,
}: {
  id: string
  frame: SheetFrame
  next?: boolean | null | undefined
  /** The sheet asked to close: on the way to the write-up's page. */
  onClose: () => void
  /** A write landed: the caller re-reads what it shows. */
  onChanged?: (() => void) | undefined
  onOpenNote?: ((noteId: string) => void) | undefined
}) {
  const router = useRouter()
  const { now: loadedAt, today } = useClock()
  const ticking = useNow()
  const now = ticking ?? new Date(loadedAt)
  const [sheet, setSheet] = useState<MeetingSheetData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prep, setPrep] = useState<PrepState>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [writing, setWriting] = useState(false)
  const [asking, setAsking] = useState(false)
  const reader = useRef<ReadableStreamDefaultReader<PrepEvent> | null>(null)

  const load = useCallback(async () => {
    try {
      setSheet(await getMeetingSheet({ data: { id } }))
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read the meeting',
      )
    }
  }, [id])

  // Whether the sheet is still open: a brief whose stream arrives after it
  // closed is cancelled the moment it is obtained.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Closing the sheet stops a running brief; nothing of it is kept.
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
    setSaved(false)
    setPrep({
      phase: 'running',
      line: null,
      sensitive: false,
      sources: null,
      text: '',
    })
    try {
      const stream = await prepMeeting({ data: { interactionId: id } })
      const r = stream.getReader()
      if (!alive.current) {
        await r.cancel()
        return
      }
      reader.current = r
      for (;;) {
        const step = await r.read()
        if (step.done) break
        const event = step.value
        setPrep((s) => applyPrepEvent(s, event))
      }
    } catch {
      if (alive.current)
        setPrep({
          phase: 'failed',
          message: 'The brief stopped before it finished',
        })
    } finally {
      reader.current = null
    }
  }, [id])

  // The brief is for a meeting still ahead: once it has started there is none.
  const meeting = sheet?.meeting ?? null
  const ahead = meeting !== null && now.getTime() < Date.parse(meeting.startsAt)

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

  // Ask opens on the brief, its question already in the dock's scope.
  async function askAboutThis(body: string, route: string | null) {
    setAsking(true)
    try {
      const { threadId, scope } = await askAboutBrief({
        data: { interactionId: id, body, route },
      })
      for (const chip of scope) addMention(chip)
      openAsk({ threadId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open Ask')
    } finally {
      setAsking(false)
    }
  }

  async function writeUp() {
    setWriting(true)
    try {
      const { noteId } = await writeUpInteraction({
        data: { interactionId: id },
      })
      onChanged?.()
      // Over a record the note window takes this one's place; elsewhere
      // a window closes on the way to the note's page, and a pane is left
      // behind by the page change itself.
      if (onOpenNote !== undefined) {
        onOpenNote(noteId)
        return
      }
      if (frame === 'window') onClose()
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

  if (sheet === null || meeting === null)
    return (
      <>
        <LoadingHead frame={frame} />
        <div className="flex min-h-48 flex-1 items-center justify-center px-4">
          {error === null ? (
            <Twinkle size={29} />
          ) : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
      </>
    )

  const over = isOver(meeting, now)
  const tasks = meeting.suggestions.filter((s) => s.kind === 'task')
  const sharedNotes = meeting.notes.filter((n) => !n.private)
  const privateNotes = meeting.notes.filter((n) => n.private)
  const sharedArtifacts = meeting.artifacts.filter((a) => !a.private)
  const privateArtifacts = meeting.artifacts.filter((a) => a.private)
  const note = meeting.note
  const owesWriteUp = over && note === null && !meeting.cancelled

  return (
    <>
      <SheetHead
        m={{ ...meeting, kind: sheet.kind, firstMeeting: sheet.firstMeeting }}
        frame={frame}
        now={now}
        today={today}
        next={next}
      />

      {/* Two columns from about 900px, the cards then a bone rail of where,
          who and what it is filed on; stacked below that. */}
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div
          data-meeting-body
          className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bone @2xl:flex-row @2xl:overflow-hidden"
        >
          <div
            data-meeting-main
            className="flex min-w-0 shrink-0 flex-col gap-2 p-3 @2xl:flex-1 @2xl:shrink @2xl:overflow-y-auto"
          >
            {ahead ? (
              <BriefCard
                prep={prep}
                canPrep={meeting.records.length > 0}
                saving={saving}
                saved={saved}
                asking={asking}
                onPrep={() => void runPrep()}
                onSave={(markdown) => void saveAsNote(markdown)}
                onAsk={(body, route) => void askAboutThis(body, route)}
              />
            ) : null}
            {over ? null : (
              <RecentCard
                record={sheet.recent.record}
                rows={sheet.recent.rows}
                onOpenNote={onOpenNote}
              />
            )}
            {note === null ? null : (
              <WriteUpCard
                note={note}
                onOpenNote={onOpenNote}
                carried={
                  <CarriedList
                    notes={sharedNotes}
                    artifacts={sharedArtifacts}
                    onOpenNote={onOpenNote}
                  />
                }
              />
            )}
            {owesWriteUp ? (
              <NoWriteUpCard
                writing={writing}
                onWriteUp={() => void writeUp()}
              />
            ) : null}
            {note === null ? (
              <CarriedCard
                label="Notes and files"
                notes={sharedNotes}
                artifacts={sharedArtifacts}
                onOpenNote={onOpenNote}
              />
            ) : null}
            <ActionItemsCard items={tasks} today={today} onDecided={changed} />
            <CarriedCard
              label="Private to you"
              notes={privateNotes}
              artifacts={privateArtifacts}
              onOpenNote={onOpenNote}
            />
          </div>

          <aside
            data-meeting-rail
            aria-label="Where, people and records"
            className="flex shrink-0 flex-col gap-6 border-t border-rule bg-bone p-4 @2xl:w-74 @2xl:overflow-y-auto @2xl:border-t-0 @2xl:border-l"
          >
            <WhereGroup conferenceUrl={meeting.conferenceUrl} over={over} />
            <PeopleGroup
              people={sheet.people}
              over={over}
              calendarUrl={
                sheet.kind === 'meeting' ? googleDayUrl(meeting.startsAt) : null
              }
            />
            <RecordsGroup
              records={meeting.records}
              search={searchRecords}
              onPin={async (hit) => {
                await pinMeetingRecord({
                  data: { interactionId: id, entityId: hit.id },
                })
                changed()
              }}
            />
          </aside>
        </div>
      </div>
    </>
  )
}
