import { useState } from 'react'
import type { ReactNode } from 'react'
import { splitByFilled } from '#/lib/records/property-fold'

/**
 * The property grid's rows with the empty attributes folded: the
 * filled ones in order, then one `Show all · n empty` row that expands the
 * rest in place, each reading `—`.
 * - The fold is per mount; a value written while open moves up on reload.
 */
export function PropertyFold<TDef>({
  defs,
  valueOf,
  render,
}: {
  defs: ReadonlyArray<TDef>
  valueOf: (def: TDef) => unknown
  render: (def: TDef) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const { filled, empty } = splitByFilled(defs, valueOf)
  return (
    <>
      {filled.map(render)}
      {open ? empty.map(render) : null}
      {empty.length > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="focus-ring-inset flex h-7 w-full items-center border-b border-rule px-6 text-left mono text-micro text-primary hover:underline"
        >
          {open
            ? `Hide · ${empty.length} empty`
            : `Show all · ${empty.length} empty`}
        </button>
      ) : null}
    </>
  )
}
