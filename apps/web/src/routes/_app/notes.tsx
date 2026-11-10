import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { EmptyState } from '#/components/empty-state'
import { FileText } from '#/components/icons'
import {
  Band,
  FoldRow,
  LedgerFigure,
  LedgerRow,
} from '#/components/ledger-section'
import { NewButton, SplitNewButton } from '#/components/new-button'
import { NOTE_KIND_LABEL, NoteKindIcon } from '#/components/note-kind-icon'
import { Card, PageBody, PageHeader } from '#/components/page-header'
import { TemplatePicker } from '#/components/templates'
import { FolderBody, Tabs } from '#/components/ui/tabs'
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

type NotesTab = 'all' | 'memos'

/** How many rows `Earlier` shows before its fold. */
const EARLIER_SHOWN = 20

/**
 * Notes are one card split by recency: what moved this week, then the rest,
 * folded past `EARLIER_SHOWN`, under two date bands that carry no count.
 * Every row leads on its kind's glyph and ends on a mono day lane; the
 * snippet takes what is left. A Memos tab joins All once a memo exists.
 */
function NotesPage() {
  const notes = Route.useLoaderData()
  const navigate = useNavigate()
  const { now } = useClock()
  const [unfolded, setUnfolded] = useState(false)
  const [tab, setTab] = useState<NotesTab>('all')

  async function newNote() {
    const { id } = await createNote()
    void navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }
  useHotkey('n', () => void newNote())

  const memos = notes.filter((n) => n.kind === 'memo')
  const shown = tab === 'memos' && memos.length > 0 ? memos : notes
  const weekStart = startOfWeekIso(new Date(now))
  const thisWeek = shown.filter((n) => n.updatedAt >= weekStart)
  const earlier = shown.filter((n) => n.updatedAt < weekStart)
  const tabs =
    memos.length > 0 ? (
      <Tabs
        label="Notes"
        items={[
          { id: 'all', label: 'All', count: notes.length },
          { id: 'memos', label: 'Memos', count: memos.length },
        ]}
        value={tab}
        onValueChange={setTab}
      />
    ) : null

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Notes"
        action={
          notes.length > 0 ? (
            <SplitNewButton
              noun="note"
              shortcut="N"
              onNew={() => void newNote()}
              templates={(trigger) => (
                <TemplatePicker
                  kind="note"
                  trigger={trigger}
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
              )}
            />
          ) : null
        }
        tabs={tabs ?? undefined}
      />

      {notes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No notes yet"
          body="Write in blocks, @mention any company or space, and the graph builds itself — backlinks land on every mentioned record."
          action={<NewButton noun="note" shortcut="N" onClick={newNote} />}
        />
      ) : (
        <PageBody className={tabs === null ? undefined : 'pt-0'}>
          <NotesBox folder={tabs !== null}>
            {thisWeek.length > 0 ? (
              <section aria-label="This week">
                <Band label="This week" />
                <ol>
                  {thisWeek.map((n) => (
                    <NoteLedgerRow key={n.id} note={n} now={now} />
                  ))}
                </ol>
              </section>
            ) : null}
            {earlier.length > 0 ? (
              <section aria-label="Earlier">
                <Band label="Earlier" />
                <ol>
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
                </ol>
              </section>
            ) : null}
          </NotesBox>
        </PageBody>
      )}
    </div>
  )
}

/** The ledger's sheet: the folder's body under the tabs, else a card. */
function NotesBox({
  folder,
  children,
}: {
  folder: boolean
  children: ReactNode
}) {
  return folder ? (
    <FolderBody label="Notes">{children}</FolderBody>
  ) : (
    <Card label="Notes">{children}</Card>
  )
}

function NoteLedgerRow({ note, now }: { note: NoteRow; now: string }) {
  return (
    <LedgerRow>
      <Link
        to="/notes/$noteId"
        params={{ noteId: note.id }}
        className="focus-ring-inset -mx-(--inset) flex h-full min-w-0 flex-1 items-center gap-3 px-(--inset) transition-colors hover:bg-bone"
      >
        <span title={NOTE_KIND_LABEL[note.kind]} className="flex shrink-0">
          <NoteKindIcon
            kind={note.kind}
            className={
              note.kind === 'note'
                ? 'size-3.5 text-graphite'
                : 'size-3.5 text-foreground'
            }
          />
        </span>
        <span className="max-w-[40%] shrink-0 truncate text-body font-medium">
          {note.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-graphite">
          {note.snippet || 'Empty so far'}
        </span>
        <LedgerFigure tone="muted">
          {formatDay(note.updatedAt, now)}
        </LedgerFigure>
      </Link>
    </LedgerRow>
  )
}
