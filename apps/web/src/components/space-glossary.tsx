import { Link, useRouter } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { RailSection } from './record/record-parts'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
import { Input } from './ui/input'
import type { listTerms } from '#/lib/server-fns'
import { createTerm, deleteTerm, updateTerm } from '#/lib/server-fns'

/**
 * A space's glossary, in the details column. Terms are scoped here because
 * "stage" means something different in aerospace and in bio; a space reads
 * its own, its ancestors' (marked "from <ancestor>") and the global ones.
 * - Definitions auto-link in any note filed into this space, which is why
 *   the glossary sits on the space page rather than in settings.
 * - An inherited term is edited where it was defined; its mark links there.
 */

type Term = Awaited<ReturnType<typeof listTerms>>[number]

export function SpaceGlossary({
  spaceId,
  terms,
}: {
  spaceId: string
  terms: Array<Term>
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const own = terms.filter((t) => t.spaceId === spaceId).length

  return (
    <RailSection
      label="Glossary"
      meta={own === terms.length ? `${own}` : `${own} +${terms.length - own}`}
    >
      <ol>
        {terms.map((t) => (
          <TermRow key={t.id} term={t} spaceId={spaceId} />
        ))}
      </ol>
      {adding ? (
        <div className="border-t border-rule py-2.5">
          <TermForm
            spaceId={spaceId}
            onDone={() => {
              setAdding(false)
              void router.invalidate()
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="focus-ring flex h-row w-full min-w-0 items-center gap-2.5 border-t border-rule text-left text-ui text-graphite transition-colors hover:text-foreground"
        >
          <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
            +
          </span>
          <span className="min-w-0 flex-1 truncate">Term</span>
        </button>
      )}
    </RailSection>
  )
}

function TermRow({ term, spaceId }: { term: Term; spaceId: string }) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [editing, setEditing] = useState(false)
  const from =
    term.spaceId !== null && term.spaceId !== spaceId
      ? { id: term.spaceId, name: term.spaceName ?? 'a parent' }
      : null

  if (editing) {
    return (
      <li className="border-t border-rule py-2.5">
        <TermForm
          spaceId={term.spaceId}
          existing={term}
          onDone={() => {
            setEditing(false)
            void router.invalidate()
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  return (
    <li
      data-term={term.name}
      className="group flex flex-col gap-0.5 border-t border-rule py-1.5"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {from ? (
          <span className="min-w-0 truncate text-ui font-medium">
            {term.name}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="focus-ring min-w-0 truncate text-ui font-medium hover:underline"
          >
            {term.name}
          </button>
        )}
        {from ? (
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId: from.id }}
            className="focus-ring min-w-0 shrink truncate mono text-micro text-graphite hover:text-foreground"
          >
            from {from.name}
          </Link>
        ) : null}
        {/* Global terms appear in every space; say so, or editing one from
            here looks like it only changed this space. */}
        {term.spaceId === null ? (
          <span className="shrink-0 mono text-micro text-graphite">global</span>
        ) : null}
        {from ? null : (
          <button
            type="button"
            aria-label={`Delete ${term.name}`}
            onClick={async () => {
              const ok = await confirm({
                title: `Delete “${term.name}”?`,
                body: 'The term and its aliases leave the glossary. Notes that use it keep their text.',
                action: 'Delete',
              })
              if (!ok) return
              try {
                await deleteTerm({ data: { id: term.id } })
                void router.invalidate()
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : 'Could not delete',
                )
              }
            }}
            className="focus-ring ml-auto flex size-5 shrink-0 items-center justify-center self-center rounded-md text-graphite opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        )}
      </div>
      {term.definitionMd ? (
        <p className="truncate text-label text-graphite">{term.definitionMd}</p>
      ) : null}
      {confirmDialog}
    </li>
  )
}

function TermForm({
  spaceId,
  existing,
  onDone,
  onCancel,
}: {
  spaceId: string | null
  existing?: Term
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [aliases, setAliases] = useState(existing?.aliases.join(', ') ?? '')
  const [definition, setDefinition] = useState(existing?.definitionMd ?? '')
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setPending(true)
    const payload = {
      name: name.trim(),
      // Comma-separated because aliases are usually one or two and a tag
      // input is more chrome than the job needs.
      aliases: aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      definitionMd: definition.trim(),
    }
    try {
      if (existing) {
        await updateTerm({ data: { id: existing.id, ...payload } })
      } else {
        await createTerm({ data: { ...payload, spaceId } })
      }
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Term, e.g. Stage"
        aria-label="Term"
      />
      <Input
        value={aliases}
        onChange={(e) => setAliases(e.target.value)}
        placeholder="Aliases, comma separated"
        aria-label="Aliases"
        className="mono"
      />
      <textarea
        rows={3}
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits — Enter alone stays a newline.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.currentTarget.form?.requestSubmit()
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="What it means here."
        aria-label="Definition"
        className="focus-ring w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-serif text-ui outline-none placeholder:text-graphite"
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={pending || !name.trim()}>
          {pending ? 'Saving…' : existing ? 'Save' : 'Define'}
          <kbd className="mono text-micro opacity-85">⌘↵</kbd>
        </Button>
      </div>
    </form>
  )
}
