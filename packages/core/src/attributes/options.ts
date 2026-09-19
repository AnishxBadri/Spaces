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

/** Slug an option label the way the server does; empty labels become `option`. */
export function slugifyOption(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'option'
  )
}

/**
 * Ids for a fresh option list, deduped with the `_2` suffix rule. Shared by
 * the create program and the dialog, so a default picked before the
 * attribute exists points at the id the server will actually store.
 */
export function deriveOptionIds(
  labels: Array<string>,
  taken: Iterable<string> = [],
): Array<string> {
  const seen = new Set(taken)
  return labels.map((label) => {
    let id = slugifyOption(label)
    while (seen.has(id)) id = `${id}_2`
    seen.add(id)
    return id
  })
}
