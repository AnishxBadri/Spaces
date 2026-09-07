/**
 * Pure helpers for reading a select/status/multi_select option list. Shared
 * by the editors, the filters, and the board; no React here so the contract
 * is testable on its own.
 */

export type OptionLike = {
  id: string
  label: string
  group?: string
  color?: string
  archived?: boolean
}

/**
 * How one stored option id renders (spec §3): its label, its palette
 * position, and whether the option has been retired. An archived option
 * still resolves — a value never silently vanishes from a chip, a cell, or
 * the timeline — it just wears the greyed treatment.
 */
export function optionState(
  def: { options?: { options?: Array<OptionLike> } | null },
  id: unknown,
) {
  const opts = def.options?.options ?? []
  const index = opts.findIndex((o) => o.id === id)
  const option = index >= 0 ? opts[index] : undefined
  return {
    option,
    index: Math.max(index, 0),
    label: option?.label ?? String(id ?? ''),
    archived: option?.archived === true,
  }
}

/** Options a write may assert — archived ones are never offered. */
export function liveOptions<T extends OptionLike>(def: {
  options?: { options?: Array<T> } | null
}): Array<T> {
  return (def.options?.options ?? []).filter((o) => !o.archived)
}
