import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { FileText, Plus } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'
import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import { KeyHint, PageHeader } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { createNote, createNoteFromTemplate, listNotes } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'

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

/**
 * Notes are a ledger split by recency: what moved this week, then the rest.
 * Every row ends on a mono date lane; the snippet takes what is left.
 */
function NotesPage() {
  const notes = Route.useLoaderData()
  const navigate = useNavigate()

  async function newNote() {
    const { id } = await createNote()
    void navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }
  useHotkey('n', () => void newNote())

  const weekStart = startOfWeekIso(new Date())
  const thisWeek = notes.filter((n) => n.updatedAt >= weekStart)
  const earlier = notes.filter((n) => n.updatedAt < weekStart)
  const last = notes.at(0)

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Notes"
        description={
          <>
            <span>
              {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
            <span>{thisWeek.length} this week</span>
            {last ? (
              <span>
                last edit {last.updatedAt.slice(5, 10)}{' '}
                {last.updatedAt.slice(11, 16)}
              </span>
            ) : null}
          </>
        }
        action={
          notes.length > 0 ? (
            <>
              <TemplatePicker
                kind="note"
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
              <Button onClick={newNote}>
                <Plus className="size-4" strokeWidth={2} />
                New note
                <KeyHint>N</KeyHint>
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
            <Button onClick={newNote}>
              <Plus className="size-4" strokeWidth={2} />
              New note
              <KeyHint>N</KeyHint>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6 px-8 pt-6 pb-8">
          {thisWeek.length > 0 ? (
            <LedgerSection
              label="This week"
              count={thisWeek.length}
              link={`W${isoWeek(new Date())}`}
            >
              {thisWeek.map((n) => (
                <NoteLedgerRow key={n.id} note={n} />
              ))}
            </LedgerSection>
          ) : null}
          {earlier.length > 0 ? (
            <LedgerSection label="Earlier" count={earlier.length}>
              {earlier.map((n) => (
                <NoteLedgerRow key={n.id} note={n} />
              ))}
            </LedgerSection>
          ) : null}
        </div>
      )}
    </div>
  )
}

function NoteLedgerRow({ note }: { note: NoteRow }) {
  return (
    <LedgerRow>
      <Link
        to="/notes/$noteId"
        params={{ noteId: note.id }}
        className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone"
      >
        <FileText
          className="size-3.5 shrink-0 text-foreground"
          strokeWidth={1.75}
        />
        <span className="max-w-[40%] shrink-0 truncate text-ui font-medium">
          {note.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          {note.snippet || 'Empty so far'}
        </span>
        {/* The kind lane: quiet, lowercase, and blank for the default — a
            ledger says "memo" or "scratch" because those are the exceptions,
            and prints nothing where there is nothing to say. */}
        <span className="w-14 shrink-0 mono text-micro text-graphite">
          {note.kind === 'note' ? '' : note.kind}
        </span>
        <LedgerFigure tone="muted">{note.updatedAt.slice(5, 10)}</LedgerFigure>
      </Link>
    </LedgerRow>
  )
}

/** ISO-8601 week number — the mono `W37` on the section head. */
function isoWeek(date: Date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  )
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7)
}
