import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { toast } from 'sonner'
import { DetailsAddRow } from '#/components/record/record-parts'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { cn } from '#/lib/utils'

/** One match the composer can add: a record, a space. */
export type PickHit = { id: string; name: string }

/**
 * A details section's `+ Add …` row that searches in place: type a name, ↵
 * adds the highlighted match, the row stays open for the next one, esc or an
 * empty blur closes it. The section owns the write; this owns the typing.
 * - `search` answers the matches not already in the section.
 */
export function DetailsPickRow({
  label,
  placeholder,
  search,
  onPick,
}: {
  /** The closed row's words — `Add a person…`. */
  label: string
  /** The open field's hint — `Person name…`. */
  placeholder: string
  search: (q: string) => Promise<ReadonlyArray<PickHit>>
  /** Write the pick; a throw reads as a toast and keeps the row open. */
  onPick: (hit: PickHit) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<ReadonlyArray<PickHit>>([])
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
      search(term)
        .then((rows) => {
          if (!alive) return
          setHits(rows)
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
  }, [q, search])

  function close() {
    setOpen(false)
    setQ('')
    setHits([])
  }

  async function pick(hit: PickHit) {
    setPending(true)
    try {
      await onPick(hit)
      setQ('')
      setHits([])
      inputRef.current?.focus()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not add ${hit.name}`,
      )
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return <DetailsAddRow onClick={() => setOpen(true)}>{label}</DetailsAddRow>
  }

  const term = q.trim()
  return (
    <div className="flex flex-col border-t border-rule">
      <div className="flex h-row items-center gap-2.5">
        <span className="w-3.5 shrink-0 text-center mono text-ui text-primary">
          +
        </span>
        <input
          ref={inputRef}
          autoFocus
          value={q}
          disabled={pending}
          placeholder={placeholder}
          aria-label={label.replace(/…$/, '')}
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
              if (hit) void pick(hit)
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-graphite"
        />
      </div>
      {term ? (
        <ol
          role="listbox"
          aria-label="Matches"
          className="mb-2 border border-rule bg-paper"
        >
          {hits.length === 0 ? (
            <li className="flex h-8 items-center px-3 text-label text-graphite">
              No match.
            </li>
          ) : (
            hits.map((h, i) => (
              <li
                key={h.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  // Before the input blurs, so the row survives to add.
                  e.preventDefault()
                  void pick(h)
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-3 border-b border-rule px-3 text-ui last:border-b-0',
                  i === active && 'bg-bone',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
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
    </div>
  )
}

/**
 * A rail group's `+` as a popover: a search field (`Add a person…`), the
 * matches under it with an optional mono lane, ↵ or a click adds the
 * highlighted one and closes, and `foot` rows after the matches.
 * - `eager` lists matches for an empty field too (a short list, like spaces).
 * - `open` and `onOpenChange` hand the open state to a caller whose own
 *   control opens it (a row's `···` item), the trigger then only an anchor.
 */
export function PickPopover<THit extends PickHit>({
  trigger,
  placeholder,
  search,
  onPick,
  lane,
  foot,
  eager = false,
  open: held,
  onOpenChange,
}: {
  trigger: ReactElement
  placeholder: string
  search: (q: string) => Promise<ReadonlyArray<THit>>
  /** Write the pick; a throw reads as a toast and keeps the popover open. */
  onPick: (hit: THit) => Promise<void>
  lane?: ((hit: THit) => ReactNode) | undefined
  foot?: ((close: () => void) => ReactNode) | undefined
  eager?: boolean | undefined
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const [own, setOwn] = useState(false)
  const open = held ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<ReadonlyArray<THit>>([])
  const [active, setActive] = useState(0)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    const term = q.trim()
    if (!term && !eager) {
      setHits([])
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      search(term)
        .then((rows) => {
          if (!alive) return
          setHits(rows)
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
  }, [open, q, search, eager])

  function close() {
    setOpen(false)
    setQ('')
    setHits([])
  }

  async function pick(hit: THit) {
    setPending(true)
    try {
      await onPick(hit)
      close()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not add ${hit.name}`,
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col p-0">
        <input
          autoFocus
          value={q}
          disabled={pending}
          placeholder={placeholder}
          aria-label={placeholder.replace(/…$/, '')}
          aria-autocomplete="list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(hits.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = hits.at(active)
              if (hit) void pick(hit)
            }
          }}
          className="h-9 border-b border-rule bg-transparent px-3 text-ui outline-none placeholder:text-graphite"
        />
        {hits.length > 0 ? (
          <ul
            role="listbox"
            aria-label="Matches"
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            {hits.map((h, i) => (
              <li
                key={h.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  void pick(h)
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-3 border-b border-rule px-3 text-ui',
                  i === active && 'bg-bone',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                {lane ? (
                  <span className="shrink-0 mono text-micro text-graphite">
                    {lane(h)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {foot ? foot(close) : null}
      </PopoverContent>
    </Popover>
  )
}
