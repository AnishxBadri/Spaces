import { Link } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/** One chip: what it is, where it goes, how it is spelled. */
export type FilingChip = {
  id: string
  name: string
  /** null = this kind has no page; the chip reads as text, not a dead link. */
  href: string | null
  Icon: LucideIcon | undefined
  /** An archived space: the filing stays, drawn graphite and marked. (D73) */
  archived?: boolean | undefined
}

/**
 * The note page's chip row. Both filing lanes draw it — spaces through
 * `entity_space`, records through `link(tagged_in)` — because the two are
 * different *writes*, not different shapes: a square chip, its kind icon,
 * its link, and an × that removes exactly that one edge.
 * - The lane owns the write, the picker and the refresh; this takes the
 *   chips it is given and an adder node.
 */
export function FilingRow({
  label,
  chips,
  busy,
  removeLabel,
  onRemove,
  adder,
}: {
  label: string
  chips: Array<FilingChip>
  busy: boolean
  removeLabel: (name: string) => string
  onRemove: (chip: FilingChip) => void
  adder: ReactNode
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="w-24 shrink-0 field-label text-graphite">{label}</span>
      {/* Square chips, like the subspace chips on a space page. */}
      {chips.map((chip) => (
        <span
          key={chip.id}
          data-chip={chip.archived ? 'archived' : 'live'}
          className={cn(
            'flex h-6 items-center gap-1.5 border border-rule bg-paper pr-1.5 pl-2 text-label',
            chip.archived ? 'text-graphite' : 'font-medium',
          )}
        >
          {chip.Icon ? (
            <chip.Icon className="size-2.5 shrink-0" strokeWidth={1.75} />
          ) : null}
          {chip.href ? (
            <Link to={chip.href} className="focus-ring hover:underline">
              {chip.name}
            </Link>
          ) : (
            chip.name
          )}
          {chip.archived ? (
            <span className="mono text-micro text-graphite">archived</span>
          ) : null}
          <button
            type="button"
            aria-label={removeLabel(chip.name)}
            disabled={busy}
            onClick={() => onRemove(chip)}
            className="focus-ring mono text-micro text-graphite hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      {adder}
    </div>
  )
}
