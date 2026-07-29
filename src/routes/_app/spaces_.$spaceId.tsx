import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  FileText,
  Layers,
  PenLine,
  Plus,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { createNote, createSpace, getSpace } from '#/lib/server-fns'

/**
 * A space is something you read, not something you administer: one
 * scrollable page — memo up top, then what's tracked and what's written.
 */
export const Route = createFileRoute('/_app/spaces_/$spaceId')({
  loader: ({ params }) => getSpace({ data: { id: params.spaceId } }),
  component: SpacePage,
})

const dateFmt = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short' })

function SpacePage() {
  const spc = Route.useLoaderData()
  const navigate = useNavigate()

  async function writeMemo() {
    const { id } = await createNote({
      data: {
        about: { entityId: spc.id, label: spc.name, kind: 'space' },
        noteKind: 'memo',
      },
    })
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  async function newNoteHere() {
    const { id } = await createNote({
      data: { about: { entityId: spc.id, label: spc.name, kind: 'space' } },
    })
    navigate({ to: '/notes/$noteId', params: { noteId: id } })
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-[13px] text-muted-foreground"
      >
        <Link
          to="/spaces"
          className="flex items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          Spaces
        </Link>
        {spc.ancestors.map((a) => (
          <span key={a.id} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground/50" strokeWidth={2} />
            <Link
              to="/spaces/$spaceId"
              params={{ spaceId: a.id }}
              className="rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {a.name}
            </Link>
          </span>
        ))}
      </nav>

      <header className="mt-5 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-muted">
            <Layers className="size-4.5 text-muted-foreground" strokeWidth={1.75} />
          </span>
          <h1 className="text-[22px] font-semibold tracking-tight">
            {spc.name}
          </h1>
        </div>
        <Button size="xs" variant="outline" onClick={newNoteHere}>
          <Plus className="size-3" strokeWidth={2} />
          Note here
        </Button>
      </header>

      {/* Subspaces */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {spc.children.map((c) => (
          <Link
            key={c.id}
            to="/spaces/$spaceId"
            params={{ spaceId: c.id }}
            className="flex h-6 items-center gap-1 rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Layers className="size-3" strokeWidth={1.75} />
            {c.name}
          </Link>
        ))}
        <NewSubspace parentId={spc.id} />
      </div>

      {/* Memo */}
      <section className="mt-8">
        {spc.memo ? (
          <Link
            to="/notes/$noteId"
            params={{ noteId: spc.memo.id }}
            className="block rounded-lg border border-border p-4 hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">
                {spc.memo.title || `${spc.name} memo`}
              </h2>
              <span className="text-xs text-muted-foreground">
                updated {dateFmt.format(new Date(spc.memo.updatedAt))}
              </span>
            </div>
            {spc.memo.snippet ? (
              <p className="mt-2 font-serif text-[15px] leading-relaxed text-muted-foreground">
                {spc.memo.snippet}
                {spc.memo.snippet.length >= 280 ? '…' : ''}
              </p>
            ) : (
              <p className="mt-2 text-[13px] text-muted-foreground">
                The memo is empty — open it and set down the thesis of this
                map.
              </p>
            )}
          </Link>
        ) : (
          <button
            onClick={writeMemo}
            className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border p-4 text-left hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <PenLine className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <span>
              <span className="block text-[13px] font-medium">
                Write the memo
              </span>
              <span className="block text-xs text-muted-foreground">
                What this space is, why it matters, what would make it
                investible.
              </span>
            </span>
          </button>
        )}
      </section>

      {/* Tracked companies */}
      <section className="mt-10">
        <h2 className="text-xs font-medium text-muted-foreground">
          Companies · {spc.companies.length}
        </h2>
        {spc.companies.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            Nothing tracked here yet — tag companies into this space from
            their record page.
          </p>
        ) : (
          <ul className="mt-2 -mx-2">
            {spc.companies.map((c) => (
              <li key={c.id}>
                <Link
                  to="/companies/$companyId"
                  params={{ companyId: c.id }}
                  className="flex h-9 items-center gap-3 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Building2
                    className="size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {c.name}
                  </span>
                  {c.stage ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {c.stage}
                    </span>
                  ) : null}
                  {c.geo ? (
                    <span className="text-xs text-muted-foreground">
                      {c.geo}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Research */}
      <section className="mt-10">
        <h2 className="text-xs font-medium text-muted-foreground">
          Notes · {spc.notes.length}
        </h2>
        {spc.notes.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            No research yet. Notes that @mention {spc.name} collect here.
          </p>
        ) : (
          <ul className="mt-2 -mx-2">
            {spc.notes.map((n) => (
              <li key={n.id}>
                <Link
                  to="/notes/$noteId"
                  params={{ noteId: n.id }}
                  className="flex h-9 items-center gap-3 rounded-md px-2 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <FileText
                    className="size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {n.title}
                  </span>
                  <span className="tabular text-xs text-muted-foreground/80">
                    {dateFmt.format(new Date(n.updatedAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function NewSubspace({ parentId }: { parentId: string }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  async function create() {
    const name = draft.trim()
    if (!name) return setEditing(false)
    await createSpace({ data: { name, parentId } })
    setDraft('')
    setEditing(false)
    router.invalidate()
  }

  return editing ? (
    <Input
      autoFocus
      value={draft}
      placeholder="Subspace name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={create}
      onKeyDown={(e) => e.key === 'Enter' && create()}
      className="h-6 w-44 rounded-full px-2.5 text-xs"
    />
  ) : (
    <button
      onClick={() => setEditing(true)}
      className="flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Plus className="size-3" strokeWidth={2} />
      Subspace
    </button>
  )
}
