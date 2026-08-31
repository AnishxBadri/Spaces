import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { FileText, Plus } from 'lucide-react'
import { EmptyState } from '#/components/empty-state'
import { TemplatePicker } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { createNote, createNoteFromTemplate, listNotes } from '#/lib/server-fns'

export const Route = createFileRoute('/_app/notes')({
  loader: () => listNotes(),
  component: NotesPage,
})

const dateFmt = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
})

function NotesPage() {
  const notes = Route.useLoaderData()
  const navigate = useNavigate()

  async function newNote() {
    const { id } = await createNote()
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-page font-semibold tracking-tight">Notes</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            Research lives here — @mention companies, people, and spaces to
            weave the graph.
          </p>
        </div>
        {notes.length > 0 ? (
          <div className="flex items-center gap-2">
            <TemplatePicker
              kind="note"
              onPick={async (t) => {
                const { id } = await createNoteFromTemplate({
                  data: { templateId: t.id },
                })
                navigate({ to: '/notes/$noteId', params: { noteId: id } })
              }}
            />
            <Button size="sm" onClick={newNote}>
              <Plus className="size-4" strokeWidth={2} />
              New note
            </Button>
          </div>
        ) : null}
      </header>

      {notes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No notes yet"
          body="Write in blocks, @mention any company or space, and the graph builds itself — backlinks land on every mentioned record."
          action={
            <Button onClick={newNote}>
              <Plus className="size-4" strokeWidth={2} />
              New note
            </Button>
          }
        />
      ) : (
        <ul className="-mx-2 mt-6">
          {notes.map((n) => (
            <li key={n.id}>
              <Link
                to="/notes/$noteId"
                params={{ noteId: n.id }}
                className="group flex h-11 items-center gap-3 rounded-md px-2 text-ui focus-ring hover:bg-accent"
              >
                <FileText
                  className="size-4 shrink-0 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{n.title}</span>
                  {n.snippet ? (
                    <span className="ml-2 text-muted-foreground">
                      {n.snippet}
                    </span>
                  ) : null}
                </span>
                <span className="tabular w-16 text-right text-xs text-muted-foreground">
                  {dateFmt.format(new Date(n.updatedAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
