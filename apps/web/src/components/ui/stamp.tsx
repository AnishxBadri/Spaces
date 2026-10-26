import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

/**
 * The ink stamp: what the page is, in mono caps on an ink label with cut
 * ends — `COMPANY 3f2a9c1b`, `SPACE · depth 2`. One per page, beside the
 * crumb; `RecordHeader` takes exactly one.
 * - An archived thing's stamp is the same shape in outline, carrying the
 *   day it was archived.
 */
export type StampProps = {
  /** The kind of thing — `Company`, an object's singular, `Space`. */
  kind: string
  /** One identifying fact: the short id the head shows, or `· depth 2`. */
  fact?: string | undefined
  /** ISO date or timestamp the thing was archived; draws the outline. */
  archivedOn?: string | null | undefined
}

/** A space's stamp: its depth in the tree, a top-level space at 0. */
export function spaceStamp(
  depth: number,
  archivedOn: string | null = null,
): StampProps {
  return { kind: 'Space', fact: `· depth ${depth}`, archivedOn }
}

export function Stamp({ kind, fact, archivedOn }: StampProps) {
  const { today } = useClock()
  const archived = archivedOn !== undefined && archivedOn !== null
  return (
    <span
      data-stamp={archived ? 'archived' : 'live'}
      className={cn('stamp', archived && 'stamp-outline')}
    >
      {kind}
      {fact ? ` ${fact}` : ''}
      {archived ? ` · archived ${formatDay(archivedOn, today)}` : ''}
    </span>
  )
}
