import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { PanelLeftClose } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  AskComposer,
  AskTurns,
  SaveAsNote,
  useAskThread,
} from '#/components/ask/ask-thread'
import { ScopeChips } from '#/components/ask/ask-dock'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { openAsk } from '#/lib/ask/dock-store'
import { scopeWords } from '#/lib/ask/types'
import { byDay, outcomeWords } from '#/lib/ask/thread-list'
import {
  deleteAskThread,
  getAskThreadCounts,
  listAskThreads,
  renameAskThread,
} from '#/lib/server-fns'
import type { AskScopeChip, AskThreadRow } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * `/ask`: every thread of yours by day, and one thread read full width —
 * a 760px column whose tables break out to the content width. (D70)
 */
export const Route = createFileRoute('/_app/ask')({
  validateSearch: z.object({
    thread: z.uuid().optional().catch(undefined),
  }),
  loader: () => listAskThreads(),
  component: AskPage,
})

function ThreadRow({
  row,
  current,
  onChanged,
  onDelete,
}: {
  row: AskThreadRow
  current: boolean
  onChanged: () => void
  onDelete: (row: AskThreadRow) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(row.title)
  const outcome = outcomeWords(row)
  async function rename() {
    setRenaming(false)
    const next = title.trim()
    if (next === '' || next === row.title) return setTitle(row.title)
    try {
      await renameAskThread({ data: { threadId: row.id, title: next } })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename it')
      setTitle(row.title)
    }
  }
  return (
    <li
      className={cn(
        'group flex min-h-ledger-row items-center gap-2 border-b border-rule px-3',
        current && 'bg-selected',
      )}
    >
      {renaming ? (
        <input
          aria-label="Thread title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void rename()
            if (e.key === 'Escape') {
              setTitle(row.title)
              setRenaming(false)
            }
          }}
          className="focus-ring h-7 min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 text-ui"
        />
      ) : (
        <Link
          to="/ask"
          search={{ thread: row.id }}
          className="focus-ring-inset flex min-w-0 flex-1 flex-col py-1.5"
        >
          <span className="truncate text-body">{row.title}</span>
          <span className="truncate text-label text-graphite">
            {[scopeWords(row.scope), outcome]
              .filter((p) => p !== '')
              .join(' · ')}
          </span>
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More for ${row.title}`}
            className="focus-ring shrink-0 rounded-md px-1 mono text-ui text-graphite opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            ···
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDelete(row)}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** The delete confirm: the counts in the foot's note, Cancel, Delete. */
function DeleteThread({
  row,
  onClose,
  onDeleted,
}: {
  row: AskThreadRow | null
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [counts, setCounts] = useState<{
    questions: number
    saved: number
  } | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setCounts(null)
    if (row === null) return
    void getAskThreadCounts({ data: { threadId: row.id } }).then(setCounts)
  }, [row])
  const note =
    counts === null
      ? null
      : `${counts.questions} ${counts.questions === 1 ? 'question' : 'questions'} and answers go${
          counts.saved > 0
            ? ` · ${counts.saved} saved ${counts.saved === 1 ? 'note stays' : 'notes stay'}`
            : ''
        }`
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Delete “{row?.title}”?</DialogTitle>
        </DialogHeader>
        <DialogFooter note={note}>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={pending}
            disabled={pending || row === null}
            onClick={async () => {
              if (row === null) return
              setPending(true)
              try {
                await deleteAskThread({ data: { threadId: row.id } })
                onDeleted(row.id)
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : 'Could not delete it',
                )
              } finally {
                setPending(false)
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AskPage() {
  const rows = Route.useLoaderData()
  const { thread: threadParam } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const [listOpen, setListOpen] = useState(true)
  const [deleting, setDeleting] = useState<AskThreadRow | null>(null)
  const [draft, setDraft] = useState('')
  const [scopeCleared, setScopeCleared] = useState(false)
  const threadId = threadParam ?? null
  const onThread = useCallback(
    (id: string) => {
      void navigate({ to: '/ask', search: { thread: id }, replace: true })
      void router.invalidate()
    },
    [navigate, router],
  )
  const { thread, live, error, ask, stop } = useAskThread(threadId, onThread)

  // A thread that is not yours, or is gone, gives way to a new one.
  useEffect(() => {
    if (error === null || threadId === null) return
    toast.error(error)
    void navigate({ to: '/ask', search: {}, replace: true })
  }, [error, threadId, navigate])

  useEffect(() => setScopeCleared(false), [threadId])

  // A question here keeps the scope the thread was last asked in.
  const lastScope: ReadonlyArray<AskScopeChip> =
    [...(thread?.turns ?? [])].reverse().find((t) => t.role === 'user')
      ?.scope ?? []
  const scope = scopeCleared ? [] : lastScope
  const record = lastScope.find((c) => c.id !== null && c.href !== null)

  const send = (question: string) => {
    setDraft('')
    void ask(question, scope)
  }

  return (
    <div className="flex h-dvh min-h-0">
      {listOpen ? (
        <nav
          aria-label="Threads"
          className="flex w-72 shrink-0 flex-col border-r border-hairline bg-paper"
        >
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-rule bg-bone px-3">
            <h1 className="text-title font-medium">Threads</h1>
            <div className="flex items-center gap-1">
              <Link
                to="/ask"
                search={{}}
                className="focus-ring rounded-md px-1.5 text-label text-graphite hover:text-foreground"
              >
                New
              </Link>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Collapse threads"
                onClick={() => setListOpen(false)}
              >
                <PanelLeftClose strokeWidth={1.75} />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="px-3 py-3 text-ui text-graphite">No threads.</p>
            ) : (
              byDay(rows).map((g) => (
                <section key={g.day} aria-label={g.day}>
                  <h2 className="flex h-7 items-center border-b border-hairline px-3 mono text-micro text-graphite">
                    {g.day}
                  </h2>
                  <ul>
                    {g.rows.map((r) => (
                      <ThreadRow
                        key={r.id}
                        row={r}
                        current={r.id === threadId}
                        onChanged={() => void router.invalidate()}
                        onDelete={setDeleting}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </nav>
      ) : null}

      <section className="@container flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-rule bg-bone px-4">
          {listOpen ? null : (
            <Button variant="ghost" size="sm" onClick={() => setListOpen(true)}>
              Threads
            </Button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-title font-medium">
            {thread?.title ?? 'New thread'}
          </h2>
          <div className="flex items-center gap-1.5">
            <ScopeChips
              scope={scope}
              onClear={
                scope.length === 0 ? undefined : () => setScopeCleared(true)
              }
            />
          </div>
          {record === undefined ||
          thread === null ||
          record.href === null ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                openAsk({ threadId: thread.id })
                if (record.href !== null) void router.history.push(record.href)
              }}
            >
              Open beside {record.name}
            </Button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-6">
          <div className="mx-auto w-full max-w-[47.5rem]">
            <AskTurns
              turns={thread?.turns ?? []}
              live={live}
              variant="page"
              threadId={thread?.id ?? null}
              onRetry={send}
            />
          </div>
        </div>
        <footer className="shrink-0 border-t border-rule px-8 py-3">
          <div className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-2">
            <AskComposer
              value={draft}
              onChange={setDraft}
              onSend={() => send(draft.trim())}
              onStop={stop}
              streaming={live?.phase === 'streaming'}
              focus={0}
            />
            <div className="flex items-center">
              <SaveAsNote thread={thread} />
            </div>
          </div>
        </footer>
      </section>

      <DeleteThread
        row={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setDeleting(null)
          if (id === threadId) void navigate({ to: '/ask', search: {} })
          void router.invalidate()
        }}
      />
    </div>
  )
}
