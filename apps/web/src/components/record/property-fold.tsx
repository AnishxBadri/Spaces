import { useState } from 'react'
import type { ReactNode } from 'react'
import { splitByFilled } from '#/lib/records/property-fold'

/**
 * The property grid's rows with the empty attributes folded: the filled
 * ones in order, then a 32px bone foot — `n empty`, which unfolds the rest
 * in place, each reading `—`, and a `+` that adds an attribute.
 * - The fold is per mount; a value written while open moves up on reload.
 * - `add` wraps the `+` in whatever opens the add (a dialog taking it as
 *   its trigger); without it the foot carries the count alone.
 * - Nothing empty and nothing to add: no foot, never a `0 empty`.
 */
export function PropertyFold<TDef>({
  defs,
  valueOf,
  render,
  add,
}: {
  defs: ReadonlyArray<TDef>
  valueOf: (def: TDef) => unknown
  render: (def: TDef) => ReactNode
  add?: ((trigger: ReactNode) => ReactNode) | undefined
}) {
  const [open, setOpen] = useState(false)
  const { filled, empty } = splitByFilled(defs, valueOf)
  return (
    <>
      {filled.map(render)}
      {open ? empty.map(render) : null}
      {empty.length > 0 || add ? (
        <div
          data-property-foot
          className="flex h-8 items-center justify-between gap-3 bg-bone pr-1 pl-2.5"
        >
          {empty.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="focus-ring text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
            >
              {empty.length} empty
            </button>
          ) : (
            <span />
          )}
          {add
            ? add(
                <button
                  type="button"
                  aria-label="Add attribute"
                  title="Add attribute"
                  className="focus-ring flex size-6 shrink-0 items-center justify-center text-title text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground"
                >
                  +
                </button>,
              )
            : null}
        </div>
      ) : null}
    </>
  )
}
