import type { Condition } from '@spaces/core/views/filter'
import type { AskScopeChip } from './types'

/**
 * What a turn's scope chips narrow, and how. (D70, D71)
 * - A record, person, space or file chip is an entity: the turn's seed for
 *   `get_context`, and the first thing the egress gate reads.
 * - A space chip is also `query_records`' default condition: filed in it or
 *   any space below it, unless the call names its own space.
 * - A view chip adds the saved view's conditions to `query_records` calls on
 *   the view's object.
 * - A chip narrows; with none the turn reads the whole workspace.
 */

/** The chips that name an entity. */
export const entityChips = (
  scope: ReadonlyArray<AskScopeChip>,
): ReadonlyArray<AskScopeChip & { id: string }> =>
  scope.flatMap((c) =>
    c.id !== null && c.kind !== 'view' && c.kind !== 'web' && c.kind !== 'page'
      ? [{ ...c, id: c.id }]
      : [],
  )

/** The turn's narrowing, resolved on the server. */
export type TurnScope = {
  space: { id: string; name: string } | null
  view: {
    name: string
    /** The view's object: its slug, singular and plural, as a call may name it. */
    object: { slug: string; singular: string; plural: string }
    conditions: ReadonlyArray<Condition>
  } | null
}

export const NO_SCOPE: TurnScope = { space: null, view: null }

type OpCondition = { op: string; value?: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A keyed condition as its list of `{op, value}`. */
const asOps = (raw: unknown): Array<unknown> =>
  Array.isArray(raw) && raw.some((x) => typeof x === 'object')
    ? raw
    : isRecord(raw) && 'op' in raw
      ? [raw]
      : [{ op: 'is', value: raw }]

const opOf = (c: Condition): OpCondition =>
  c.value === undefined ? { op: c.op } : { op: c.op, value: c.value }

/**
 * A `query_records` input with the scope's conditions added. Anything that
 * is not an object is handed back as it came, for the tool to refuse.
 */
export function scopeQueryInput(raw: unknown, scope: TurnScope): unknown {
  if (!isRecord(raw)) return raw
  if (scope.space === null && scope.view === null) return raw
  const given = raw.conditions
  // Malformed conditions go through untouched, for the tool to refuse.
  if (given !== undefined && !isRecord(given)) return raw
  const conditions: Record<string, unknown> = isRecord(given)
    ? { ...given }
    : {}
  if (scope.space !== null && conditions.space === undefined)
    conditions.space = { id: scope.space.id, includeDescendants: true }
  const object =
    typeof raw.object === 'string' ? raw.object.trim().toLowerCase() : ''
  const view = scope.view
  if (
    view !== null &&
    [view.object.slug, view.object.singular, view.object.plural].some(
      (n) => n.toLowerCase() === object,
    )
  )
    for (const c of view.conditions) {
      if (c.slug === 'space') continue
      const had = conditions[c.slug]
      conditions[c.slug] =
        had === undefined ? [opOf(c)] : [...asOps(had), opOf(c)]
    }
  return { ...raw, conditions }
}

/** The call-strip tool name a chip the turn could not resolve is stored under. */
export const SCOPE_DROPPED = 'scope'

/** The line a dropped chip prints in the thread. */
export function droppedLine(
  chip: AskScopeChip,
  why: 'gone' | 'unread',
): string {
  return `${chip.name} dropped — ${why === 'gone' ? 'no longer there' : 'could not be read'}`
}

/** The scope as the model is told it, one sentence per chip. */
export function scopeSentences(
  scope: ReadonlyArray<AskScopeChip>,
  turn: TurnScope,
): ReadonlyArray<string> {
  const entities = entityChips(scope)
  const out: Array<string> = []
  if (entities.length > 0)
    out.push(
      `The reader is asking about ${entities.map((c) => `${c.name} (${c.kind}, id ${c.id})`).join(' and ')}; start with get_context on it.`,
    )
  if (turn.space !== null)
    out.push(
      `query_records keeps to records filed in ${turn.space.name} or a space below it.`,
    )
  if (turn.view !== null)
    out.push(
      `The reader is looking at the saved view “${turn.view.name}” of ${turn.view.object.plural}: query_records on ${turn.view.object.slug} keeps to its rows.`,
    )
  return out.length === 0
    ? ['The reader is asking about the whole workspace.']
    : out
}
