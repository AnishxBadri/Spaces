import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { FileText, Plus } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '#/components/empty-state'
import {
  FoldRow,
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import { PageHeader } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { createNote, createNoteFromTemplate, listNotes } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'

export const Route = createFileRoute('/_app/notes')({
  loader: () => listNotes(),
  component: NotesPage,
})

type NoteRow = Awaited<ReturnType<typeof listNotes>>[number]

/** ISO Monday 00:00 local, as an ISO string for lexical comparison. */
function startOfWeekIso(now: Date) {
  const d = new Date(now)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** How many rows `Earlier` shows before its fold. */
const EARLIER_SHOWN = 20

/**
 * Notes are a ledger split by recency: what moved this week, then the rest,
 * folded past `EARLIER_SHOWN`. Every row ends on a mono day lane; the
 * snippet takes what is left.
 */
function NotesPage() {
  const notes = Route.useLoaderData()
  const navigate = useNavigate()
  const { now } = useClock()
  const [unfolded, setUnfolded] = useState(false)

  async function newNote() {
    const { id } = await createNote()
    void navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }
  useHotkey('n', () => void newNote())

  const weekStart = startOfWeekIso(new Date(now))
  const thisWeek = notes.filter((n) => n.updatedAt >= weekStart)
  const earlier = notes.filter((n) => n.updatedAt < weekStart)
  const last = notes.at(0)

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Notes"
        description={
          notes.length > 0 ? (
            <span>
              {notes.length} note{notes.length === 1 ? '' : 's'}
              {last ? ` · last edit ${formatDay(last.updatedAt, now)}` : ''}
            </span>
          ) : undefined
        }
        action={
          notes.length > 0 ? (
            <>
              <TemplatePicker
                kind="note"
                trigger={<Button variant="outline">From template</Button>}
                onPick={async (t) => {
                  const { id } = await createNoteFromTemplate({
                    data: { templateId: t.id },
                  })
                  void navigate({
                    to: '/notes/$noteId',
                    params: { noteId: id },
                  })
                }}
              />
              <Button shortcut="N" onClick={newNote}>
                <Plus className="size-4" strokeWidth={2} />
                New note
              </Button>
            </>
          ) : null
        }
      />

      {notes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No notes yet"
          body="Write in blocks, @mention any company or space, and the graph builds itself — backlinks land on every mentioned record."
          action={
            <Button shortcut="N" onClick={newNote}>
              <Plus className="size-4" strokeWidth={2} />
              New note
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8 px-8 pt-6 pb-8">
          {thisWeek.length > 0 ? (
            <LedgerSection label="This week" count={thisWeek.length}>
              {thisWeek.map((n) => (
                <NoteLedgerRow key={n.id} note={n} now={now} />
              ))}
            </LedgerSection>
          ) : null}
          {earlier.length > 0 ? (
            <LedgerSection label="Earlier" count={earlier.length}>
              {(unfolded ? earlier : earlier.slice(0, EARLIER_SHOWN)).map(
                (n) => (
                  <NoteLedgerRow key={n.id} note={n} now={now} />
                ),
              )}
              {!unfolded && earlier.length > EARLIER_SHOWN ? (
                <li>
                  <FoldRow
                    hidden={earlier.length - EARLIER_SHOWN}
                    onShow={() => setUnfolded(true)}
                    className="border-t-0"
                  />
                </li>
              ) : null}
            </LedgerSection>
          ) : null}
        </div>
      )}
    </div>
  )
}

function NoteLedgerRow({ note, now }: { note: NoteRow; now: string }) {
  return (
    <LedgerRow>
      <Link
        to="/notes/$noteId"
        params={{ noteId: note.id }}
        className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 transition-colors hover:bg-bone"
      >
        <span aria-hidden className="w-3.5 shrink-0 text-center text-ui">
          ¶
        </span>
        <span className="max-w-[40%] shrink-0 truncate text-body font-medium">
          {note.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          {note.snippet || 'Empty so far'}
        </span>
        {/* The kind lane, blank for the default: a ledger says MEMO or
            SCRATCH because those are the exceptions. */}
        <span data-kind-lane className="w-16 shrink-0 label-caps text-graphite">
          {note.kind === 'note' ? '' : note.kind.toUpperCase()}
        </span>
        <LedgerFigure tone="muted">
          {formatDay(note.updatedAt, now)}
        </LedgerFigure>
      </Link>
    </LedgerRow>
  )
}
