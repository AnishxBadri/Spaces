import type { AttributeDef } from '@spaces/core/attributes/registry'
import { fmtMoney } from '@spaces/core/portfolio/format'

/**
 * Plain-text renderings for ContextItems. Pure: values in, one line out.
 * Text is the interchange (spec §1), so these lines are what a model sees
 * and what the "everything about this record" panel shows. Names for
 * record and actor references come in as a lookup so the renderer never
 * touches the database.
 */

export type NameLookup = (id: string) => string | undefined

const asArray = (v: unknown): Array<unknown> => (Array.isArray(v) ? v : [v])

export function renderValue(
  def: AttributeDef,
  value: unknown,
  names: NameLookup,
): string | null {
  if (value == null || value === '') return null
  if (Array.isArray(value) && value.length === 0) return null
  switch (def.type) {
    case 'select':
    case 'multi_select':
    case 'status': {
      const opts = def.options.options ?? []
      const labels = asArray(value).map(
        (id) => opts.find((o) => o.id === id)?.label ?? String(id),
      )
      return labels.join(', ')
    }
    case 'record_reference':
    case 'actor_reference':
      return asArray(value)
        .map((id) => names(String(id)) ?? String(id))
        .join(', ')
    case 'currency': {
      const n = Number(value)
      if (!Number.isFinite(n)) return String(value)
      return fmtMoney(n, def.options.code ?? 'USD')
    }
    case 'checkbox':
      return value === true ? 'yes' : 'no'
    case 'rating':
      return `${String(value)}/${def.options.max ?? 5}`
    case 'number':
    case 'text':
    case 'date':
    case 'domain':
    case 'email':
    case 'url':
    case 'phone':
      return String(value)
  }
}

/** `Name: value` — the attribute line. */
export function renderAttribute(
  def: AttributeDef,
  value: unknown,
  names: NameLookup,
): string | null {
  const v = renderValue(def, value, names)
  return v == null ? null : `${def.name}: ${v}`
}

/** One attribute change, as the timeline would say it. */
export function renderEvent(
  attrName: string,
  from: unknown,
  to: unknown,
  actor: string,
  at: string,
): string {
  const show = (v: unknown) =>
    v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v)
  return `${attrName}: ${show(from)} → ${show(to)} (${actor}, ${at.slice(0, 10)})`
}

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`
