import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Boxes, FileText, Layers, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  LedgerFigure,
  LedgerRow,
  LedgerSection,
} from '#/components/ledger-section'
import { KeyHint } from '#/components/page-header'
import { DitherMark } from '#/components/record/record-parts'
import { SpaceGlossary } from '#/components/space-glossary'
import { SaveAsTemplateAction } from '#/components/templates'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  createNote,
  createSpace,
  getSpace,
  listTerms,
  saveSpaceAsTemplate,
} from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/**
 * A space is something you read, not something you administer: one page
 * in the record register — crumb, name, subspaces in the head; then what
 * is filed here, what is tracked, the glossary, and what refers to it.
 */
export const Route = createFileRoute('/_app/spaces_/$spaceId')({
  loader: async ({ params }) => {
    const [spc, terms] = await Promise.all([
      getSpace({ data: { id: params.spaceId } }),
      listTerms({ data: { spaceId: params.spaceId } }),
    ])
    return { spc, terms }
  },
  component: SpacePage,
})

function SpacePage() {
  const { spc, terms } = Route.useLoaderData()
  const navigate = useNavigate()

  async function writeMemo() {
    try {
      const { id } = await createNote({
        data: {
          about: { entityId: spc.id, label: spc.name, kind: 'space' },
          noteKind: 'memo',
        },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  async function newNoteHere() {
    try {
      const { id } = await createNote({
        data: { about: { entityId: spc.id, label: spc.name, kind: 'space' } },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }
  useHotkey('n', () => void newNoteHere())

  const rowLink =
    'focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone'

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex shrink-0 flex-col gap-3.5 border-b border-hairline px-8 pt-5 pb-4">
        <div className="flex items-center justify-between gap-4">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2 mono text-micro leading-[0.875rem] tracking-[0.08em] text-graphite uppercase"
          >
            <Link
              to="/spaces"
              className="focus-ring shrink-0 transition-colors hover:text-foreground"
            >
              Spaces
            </Link>
            {spc.ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-2">
                <span className="text-rule">/</span>
                <Link
                  to="/spaces/$spaceId"
                  params={{ spaceId: a.id }}
                  className="focus-ring truncate transition-colors hover:text-foreground"
                >
                  {a.name}
                </Link>
              </span>
            ))}
            <span className="text-rule">/</span>
            <span className="truncate font-medium text-foreground">
              {spc.name}
            </span>
            <span className="text-rule max-md:hidden">·</span>
            <span className="shrink-0 tracking-normal normal-case max-md:hidden">
              {spc.children.length} subspace
              {spc.children.length === 1 ? '' : 's'} · {spc.companies.length}{' '}
              compan
              {spc.companies.length === 1 ? 'y' : 'ies'} · {spc.filed.length}{' '}
              filed
            </span>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <SaveAsTemplateAction
              entityLabel="space"
              defaultName={`${spc.name} breakdown`}
              onSave={async (name) => {
                await saveSpaceAsTemplate({ data: { spaceId: spc.id, name } })
              }}
              trigger={<Button variant="outline">Save as template</Button>}
            />
            <Button variant="outline" onClick={newNoteHere}>
              Note here
              <KeyHint>N</KeyHint>
            </Button>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          {/* The space mark: a paper tile on a hairline, never a circle. */}
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center border border-hairline bg-paper"
          >
            <Layers className="size-3.5" strokeWidth={1.75} />
          </span>
          <h1 className="min-w-0 truncate title-serif">{spc.name}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {spc.children.map((c) => (
            <Link
              key={c.id}
              to="/spaces/$spaceId"
              params={{ spaceId: c.id }}
              className="focus-ring flex h-6 items-center gap-1.5 border border-rule bg-paper px-2 text-label font-medium transition-colors hover:border-hairline"
            >
              <Layers className="size-2.5" strokeWidth={1.75} />
              {c.name}
            </Link>
          ))}
          <NewSubspace parentId={spc.id} />
        </div>
      </header>

      <div className="flex flex-col gap-6 px-8 pt-6 pb-8">
        {/* What I think here — the prose filed against this space. */}
        <LedgerSection
          label="Filed here"
          count={`${spc.filed.length} memo${spc.filed.length === 1 ? '' : 's'}`}
          link={
            <Link to="/notes" className="focus-ring text-primary">
              all notes ›
            </Link>
          }
        >
          {spc.filed.map((f) => (
            <li key={f.id} className="border-b border-rule">
              <Link
                to="/notes/$noteId"
                params={{ noteId: f.id }}
                className="focus-ring-inset flex flex-col gap-2 py-4 transition-colors hover:bg-bone"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="min-w-0 truncate text-title font-medium">
                    {f.title || `${spc.name} ${f.kind}`}
                  </h3>
                  <span className="shrink-0 mono text-label text-graphite">
                    {f.kind} · updated {f.updatedAt.slice(5, 10)}
                  </span>
                </div>
                {f.snippet ? (
                  <p className="text-prose max-w-160 font-serif leading-[1.6875rem] text-graphite">
                    {f.snippet}
                    {f.snippet.length >= 400 ? '…' : ''}
                  </p>
                ) : (
                  <p className="text-ui text-graphite">
                    Empty so far — open it and set down what you know.
                  </p>
                )}
              </Link>
            </li>
          ))}
          <LedgerRow>
            <button
              type="button"
              onClick={writeMemo}
              className={cn(rowLink, 'text-left')}
            >
              <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
                +
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-graphite">
                {spc.filed.length === 0
                  ? 'Write the memo — what this space is, why it matters, what would make it investible'
                  : 'File another — a market map, a teardown, a second memo'}
              </span>
              <span className="shrink-0 text-graphite">
                <KeyHint>N</KeyHint>
              </span>
            </button>
          </LedgerRow>
        </LedgerSection>

        {/* Tracked companies */}
        <LedgerSection
          label="Companies"
          count={`${spc.companies.length} · tagged from their records`}
        >
          {spc.companies.length === 0 ? (
            <LedgerRow>
              <span className="text-ui text-graphite">
                Nothing tracked here yet — tag companies into this space from
                their record page.
              </span>
            </LedgerRow>
          ) : (
            spc.companies.map((c) => (
              <LedgerRow key={c.id}>
                <Link
                  to="/companies/$companyId"
                  params={{ companyId: c.id }}
                  className={rowLink}
                >
                  <DitherMark size={14} />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {c.name}
                  </span>
                  {c.stage ? (
                    <span className="flex h-5 shrink-0 items-center bg-bone px-1.5 mono text-micro font-medium">
                      {c.stage}
                    </span>
                  ) : null}
                  <span className="w-24 shrink-0 truncate text-right mono text-label text-graphite">
                    {c.geo ?? ''}
                  </span>
                </Link>
              </LedgerRow>
            ))
          )}
        </LedgerSection>

        {spc.records.length > 0 ? (
          <LedgerSection label="Records" count={spc.records.length}>
            {spc.records.map((r) => (
              <LedgerRow key={r.id}>
                <Link
                  to="/o/$objectSlug/$recordId"
                  params={{ objectSlug: r.objectSlug, recordId: r.id }}
                  className={rowLink}
                >
                  <Boxes
                    className="size-3.5 shrink-0 text-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {r.name}
                  </span>
                  <span className="shrink-0 mono text-label text-graphite">
                    {r.objectPlural}
                  </span>
                </Link>
              </LedgerRow>
            ))}
          </LedgerSection>
        ) : null}

        <SpaceGlossary spaceId={spc.id} spaceName={spc.name} terms={terms} />

        {/* Referenced: notes whose body mentions this space, but which live
            somewhere else. Filed notes are above and never repeat here. */}
        <LedgerSection
          label="Referenced"
          count={`${spc.notes.length} · @mention this space, filed elsewhere`}
        >
          {spc.notes.length === 0 ? (
            <LedgerRow>
              <span className="text-ui text-graphite">
                Nothing yet. Notes that @mention {spc.name} without being filed
                here collect in this list.
              </span>
            </LedgerRow>
          ) : (
            spc.notes.map((n) => (
              <LedgerRow key={n.id}>
                <Link
                  to="/notes/$noteId"
                  params={{ noteId: n.id }}
                  className={rowLink}
                >
                  <FileText
                    className="size-3.5 shrink-0 text-foreground"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium">
                    {n.title}
                  </span>
                  <LedgerFigure tone="muted">
                    {n.updatedAt.slice(5, 10)}
                  </LedgerFigure>
                </Link>
              </LedgerRow>
            ))
          )}
        </LedgerSection>
      </div>
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
    void router.invalidate()
  }

  return editing ? (
    <Input
      autoFocus
      value={draft}
      placeholder="Subspace name"
      aria-label="Subspace name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={create}
      onKeyDown={(e) => e.key === 'Enter' && create()}
      className="h-6 w-44 px-2 text-label"
    />
  ) : (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="focus-ring flex h-6 items-center gap-1.5 border border-dashed border-rule px-2 text-label text-graphite transition-colors hover:border-hairline hover:text-foreground"
    >
      <Plus className="size-2.5 text-primary" strokeWidth={2.5} />
      Subspace
    </button>
  )
}
