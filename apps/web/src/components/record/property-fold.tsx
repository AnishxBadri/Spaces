import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { splitByFilled } from '#/lib/records/property-fold'

/** What the fold reads of an attribute definition. */
type FoldDef = { slug: string; name: string; type: string }

/** The controlled open of the caller's create window. */
export type CreateOpener = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The property grid's rows with the empty attributes folded: the filled
 * ones in order, then one 32px bone row — `n empty +` — that opens a
 * popover to search the empty attributes by name (each with its mono
 * type), picking one into the grid, with `New attribute…` at its foot.
 * - What was picked stays shown for this mount; a value written moves it
 *   up on reload.
 * - `create` renders the caller's create window, held open by the fold.
 * - Nothing empty and nothing to create: no row, never a `0 empty`.
 */
export function PropertyFold<TDef extends FoldDef>({
  defs,
  valueOf,
  render,
  create,
}: {
  defs: ReadonlyArray<TDef>
  valueOf: (def: TDef) => unknown
  render: (def: TDef) => ReactNode
  create?: ((opener: CreateOpener) => ReactNode) | undefined
}) {
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState<ReadonlyArray<string>>([])
  const [q, setQ] = useState('')
  const { filled, empty } = splitByFilled(defs, valueOf)
  const shown = picked.flatMap((slug) => {
    const def = empty.find((d) => d.slug === slug)
    return def === undefined ? [] : [def]
  })
  const term = q.trim().toLowerCase()
  const offered = empty
    .filter((d) => !picked.includes(d.slug))
    .filter((d) => term === '' || d.name.toLowerCase().includes(term))

  function pick(def: TDef) {
    setPicked((now) => [...now, def.slug])
    setPicking(false)
    setQ('')
  }

  return (
    <>
      {filled.map(render)}
      {shown.map(render)}
      {empty.length > 0 || create ? (
        <Popover
          open={picking}
          onOpenChange={(open) => {
            setPicking(open)
            if (!open) setQ('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-property-foot
              aria-label="Add an attribute"
              className="focus-ring-inset flex h-8 w-full items-center justify-between gap-3 bg-bone px-2.5 text-left text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
            >
              <span>
                {empty.length > 0 ? `${String(empty.length)} empty` : ''}
              </span>
              <span aria-hidden className="text-title">
                +
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-72 flex-col p-0">
            <input
              autoFocus
              value={q}
              placeholder="Add an attribute…"
              aria-label="Add an attribute"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                const first = offered.at(0)
                if (e.key === 'Enter' && first !== undefined) {
                  e.preventDefault()
                  pick(first)
                }
              }}
              className="h-9 border-b border-rule bg-transparent px-3 text-ui outline-none placeholder:text-graphite"
            />
            {offered.length > 0 ? (
              <ul
                aria-label="Empty attributes"
                className="flex max-h-64 flex-col overflow-y-auto"
              >
                {offered.map((def) => (
                  <li key={def.slug}>
                    <button
                      type="button"
                      onClick={() => pick(def)}
                      className="focus-ring-inset flex h-8 w-full items-center justify-between gap-3 border-b border-rule px-3 text-left text-ui hover:bg-bone"
                    >
                      <span className="min-w-0 truncate">{def.name}</span>
                      <span className="shrink-0 mono text-micro text-graphite">
                        {def.type.replaceAll('_', ' ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {create ? (
              <button
                type="button"
                onClick={() => {
                  setPicking(false)
                  setCreating(true)
                }}
                className="focus-ring-inset flex h-8 items-center bg-bone px-3 text-left text-ui text-foreground hover:underline"
              >
                New attribute…
              </button>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
      {create ? create({ open: creating, onOpenChange: setCreating }) : null}
    </>
  )
}
