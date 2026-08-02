import { useRouter } from '@tanstack/react-router'
import { BookOpen, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { createTerm, deleteTerm, listTerms, updateTerm } from '#/lib/server-fns'

/**
 * A space's glossary. Terms are scoped here because "stage" means something
 * different in aerospace and in bio; terms with no space are global and show
 * as inherited, editable from wherever they were defined.
 *
 * Definitions auto-link in any note filed into this space — that is the whole
 * payoff, and it is why this sits on the space page rather than in settings.
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
    <section className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted-foreground">
          Glossary · {terms.length}
        </h2>
        {!adding ? (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3" strokeWidth={2} />
            Define a term
          </Button>
        ) : null}
      </div>

      {adding ? (
        <TermForm
          spaceId={spaceId}
          onDone={() => {
            setAdding(false)
            router.invalidate()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      {terms.length === 0 && !adding ? (
        <p className="mt-2 text-ui leading-relaxed text-muted-foreground">
          No terms yet. Define one and it auto-links in every note filed into{' '}
          {spaceName} — worth its weight when you are learning a space.
        </p>
      ) : (
        <dl className="mt-2 divide-y divide-border border-y border-border">
          {terms.map((t) => (
            <TermRow key={t.id} term={t} />
          ))}
        </dl>
      )}
    </section>
  )
}

function TermRow({ term }: { term: Term }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className="py-2">
        <TermForm
          spaceId={term.spaceId}
          existing={term}
          onDone={() => {
            setEditing(false)
            router.invalidate()
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  return (
    <div className="group flex items-start gap-3 py-2.5">
      <BookOpen
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
      />
      <div className="min-w-0 flex-1">
        <dt className="flex flex-wrap items-baseline gap-2">
          <button
            onClick={() => setEditing(true)}
            className="rounded text-ui font-medium hover:underline focus-ring"
          >
            {term.name}
          </button>
          {term.aliases.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              also {term.aliases.join(', ')}
            </span>
          ) : null}
          {/* Global terms appear in every space; say so, or editing one from
              here looks like it only changed this space. */}
          {term.spaceId === null ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              global
            </span>
          ) : null}
        </dt>
        <dd className="mt-0.5 font-serif text-body leading-relaxed text-muted-foreground">
          {term.definitionMd || 'No definition yet.'}
        </dd>
      </div>
      <button
        aria-label={`Delete ${term.name}`}
        onClick={async () => {
          if (!window.confirm(`Delete the term “${term.name}”?`)) return
          try {
            await deleteTerm({ data: { id: term.id } })
            router.invalidate()
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not delete')
          }
        }}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex focus-visible:flex focus-ring"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </div>
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
    <form
      onSubmit={submit}
      className="mt-2 space-y-2 rounded-md border border-border p-3"
    >
      <div className="flex gap-2">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Term, e.g. Stage"
          className="h-7 text-xs"
        />
        <Input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="Aliases, comma separated"
          className="h-7 text-xs"
        />
      </div>
      <textarea
        rows={2}
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        placeholder="What it means here — the definition someone new to this space needs."
        className="border-input w-full rounded-md border bg-transparent px-2.5 py-1.5 font-serif text-body leading-relaxed outline-none placeholder:text-muted-foreground focus-ring"
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" type="submit" disabled={pending || !name.trim()}>
          {pending ? 'Saving…' : existing ? 'Save' : 'Define'}
        </Button>
      </div>
    </form>
  )
}
