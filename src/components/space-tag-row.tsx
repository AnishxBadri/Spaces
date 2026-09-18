import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LedgerRow } from './ledger-section'
import { DitherMark } from './record/record-parts'
import { searchEntities, tagIntoSpace } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

type Hit = { id: string; name: string }

/**
 * The composer row of a space's Companies ledger: tagging happens where the
 * list is, not on each company's record. Type a name, ↵ tags the
 * highlighted match, the row stays open for the next one (a market map is
 * built in runs, not one at a time), esc or an empty blur closes it.
 */
export function TagCompanyRow({
  spaceId,
  spaceName,
  taggedIds,
}: {
  spaceId: string
  spaceName: string
  taggedIds: ReadonlySet<string>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Array<Hit>>([])
  const [active, setActive] = useState(0)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const term = q.trim()
    if (!term) {
      setHits([])
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      searchEntities({ data: { q: term, kinds: ['company'] } })
        .then((rows) => {
          if (!alive) return
          setHits(rows.filter((r) => !taggedIds.has(r.id)))
          setActive(0)
        })
        .catch(() => {
          if (alive) setHits([])
        })
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [q, taggedIds])

  async function tag(hit: Hit) {
    setPending(true)
    try {
      await tagIntoSpace({ data: { entityId: hit.id, spaceId } })
      setQ('')
      setHits([])
      void router.invalidate()
      inputRef.current?.focus()
    } catch {
      toast.error(`Could not tag ${hit.name} into ${spaceName}`)
    } finally {
      setPending(false)
    }
  }

  function close() {
    setOpen(false)
    setQ('')
    setHits([])
  }

  if (!open) {
    return (
      <LedgerRow last>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-bone"
        >
          <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
            +
          </span>
          <span className="min-w-0 flex-1 truncate text-ui text-graphite">
            {taggedIds.size === 0
              ? `Tag a company into ${spaceName} — by name, as many as belong here`
              : 'Tag another company… by name'}
          </span>
          <kbd className="shrink-0 mono text-micro text-graphite">↵</kbd>
        </button>
      </LedgerRow>
    )
  }

  const term = q.trim()

  return (
    <li className="flex flex-col">
      <div className="flex h-row items-center gap-3">
        <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
          +
        </span>
        <input
          ref={inputRef}
          autoFocus
          value={q}
          disabled={pending}
          placeholder="Company name…"
          aria-label={`Tag a company into ${spaceName}`}
          aria-autocomplete="list"
          aria-expanded={hits.length > 0}
          onChange={(e) => setQ(e.target.value)}
          onBlur={() => {
            if (!term) close()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(hits.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = hits.at(active)
              if (hit) void tag(hit)
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
        />
        <span className="shrink-0 mono text-micro text-graphite">
          {hits.length > 0 ? '↑↓ · ↵ tag · esc' : 'esc'}
        </span>
      </div>
      {term ? (
        <ol
          role="listbox"
          aria-label="Matching companies"
          className="mb-2 ml-6.5 border border-rule bg-paper"
        >
          {hits.length === 0 ? (
            <li className="flex h-8 items-center px-3 text-label text-graphite">
              No company named “{term}” — create it from Companies first.
            </li>
          ) : (
            hits.map((h, i) => (
              <li
                key={h.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  // Before the input blurs, so the row survives to tag.
                  e.preventDefault()
                  void tag(h)
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-3 border-b border-rule px-3 text-ui last:border-b-0',
                  i === active && 'bg-bone',
                )}
              >
                <DitherMark size={14} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {h.name}
                </span>
                {i === active ? (
                  <kbd className="shrink-0 mono text-micro text-graphite">
                    ↵
                  </kbd>
                ) : null}
              </li>
            ))
          )}
        </ol>
      ) : null}
    </li>
  )
}
