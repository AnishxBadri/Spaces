import { useRouter } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LedgerRow, LedgerSection } from './ledger-section'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
import { Input } from './ui/input'
import type { listTerms } from '#/lib/server-fns'
import { createTerm, deleteTerm, updateTerm } from '#/lib/server-fns'

/**
 * A space's glossary. Terms are scoped here because "stage" means something
 * different in aerospace and in bio; terms with no space are global and show
 * as inherited, editable from wherever they were defined.
 *
 * Definitions auto-link in any note filed into this space — that is the whole
 * payoff, and it is why this sits on the space page rather than in settings.
 * It is a ledger section: term rows on rules, the composer as the last row.
 */

type Term = Awaited<ReturnType<typeof listTerms>>[number]

export function SpaceGlossary({
  spaceId,
  spaceName,
  terms,
}: {
  spaceId: string
  spaceName: string
  terms: Array<Term>
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)

  return (
    <LedgerSection
      label="Glossary"
      count={`${terms.length} · auto-links in every note filed into ${spaceName}`}
    >
      {terms.map((t) => (
        <TermRow key={t.id} term={t} />
      ))}
      {adding ? (
        <li className="border-b border-rule py-3">
          <TermForm
            spaceId={spaceId}
            onDone={() => {
              setAdding(false)
              void router.invalidate()
            }}
            onCancel={() => setAdding(false)}
          />
        </li>
      ) : (
        <LedgerRow>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-bone"
          >
            <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
              +
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-graphite">
              {terms.length === 0
                ? 'Define a term — worth its weight when you are learning a space'
                : 'Define a term… name, aliases, what it means here'}
            </span>
            <kbd className="shrink-0 mono text-micro text-graphite">↵</kbd>
          </button>
        </LedgerRow>
      )}
    </LedgerSection>
  )
}

function TermRow({ term }: { term: Term }) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <li className="border-b border-rule py-3">
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
    <li className="group flex flex-col gap-1 border-b border-rule py-2.5">
      <div className="flex items-baseline gap-2.5">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="focus-ring text-ui font-medium hover:underline"
        >
          {term.name}
        </button>
        {term.aliases.length > 0 ? (
          <span className="mono text-label text-graphite">
            also {term.aliases.join(', ')}
          </span>
        ) : null}
        {/* Global terms appear in every space; say so, or editing one from
            here looks like it only changed this space. */}
        {term.spaceId === null ? (
          <span className="bg-bone px-1.5 label-caps text-[0.625rem] leading-[0.875rem] text-graphite">
            global
          </span>
        ) : null}
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
      </div>
      <p className="max-w-160 font-serif text-title leading-[1.375rem] text-graphite">
        {term.definitionMd || 'No definition yet.'}
      </p>
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
    <form onSubmit={submit} className="flex max-w-160 flex-col gap-2">
      <div className="flex gap-2">
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
      </div>
      <textarea
        rows={2}
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits — Enter alone stays a newline.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.currentTarget.form?.requestSubmit()
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="What it means here — the definition someone new to this space needs."
        aria-label="Definition"
        className="focus-ring w-full rounded-md border border-rule bg-transparent px-2.5 py-1.5 font-serif text-title leading-[1.375rem] outline-none placeholder:text-graphite"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto mono text-micro text-graphite">
          ⌘↵ saves · esc cancels
        </span>
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
