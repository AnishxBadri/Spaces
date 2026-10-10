import { manifestSchema } from '@spaces/sdk'
import {
  ENRICHMENT_VOCABULARY,
  VOCABULARY_KEYS,
  isVocabularyKey,
} from '@spaces/sdk/vocabulary'
import type { VocabularyKey } from '@spaces/sdk/vocabulary'
import type { Json } from '@spaces/db/json'

/**
 * The Enrichment page and the where-from popover, pure (D76):
 * - what each source can answer, from its enrich action's `answers`;
 * - What fills what: per linked attribute, which source answers it;
 * - a filled value's source, date and earlier figures.
 */

/**
 * The keys a source's enrich action on `kind` answers: its declared
 * `answers`, else every key of that kind — the run asks it for all of them.
 * Empty when it has no enrich action for the kind.
 */
export const answersOf = (
  manifest: unknown,
  kind: 'company' | 'person',
): ReadonlySet<VocabularyKey> => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return new Set()
  const action = (parsed.data.actions ?? []).find(
    (a) => a.on === kind && a.id.startsWith('enrich'),
  )
  if (action === undefined) return new Set()
  const declared = action.answers?.filter(isVocabularyKey)
  return new Set(
    declared ??
      VOCABULARY_KEYS.filter((k) => ENRICHMENT_VOCABULARY[k].kind === kind),
  )
}

/** A source as the grid reads it, in the owner's order. */
export type GridSource = {
  readonly id: string
  readonly name: string
  /** Runnable now; an off source could answer but is not asked. */
  readonly on: boolean
  readonly answers: ReadonlySet<string>
}

/**
 * One source against one attribute:
 * - `fills`: the first source on, in order, that answers the key;
 * - `next`: a later source on that answers it — asked only if the first has nothing;
 * - `could`: a source that answers it but is off;
 * - `none`: it does not answer the key, or the attribute is not linked.
 */
export type GridCell = 'fills' | 'next' | 'could' | 'none'

export type GridRow<TAttr> = TAttr & {
  readonly cells: ReadonlyArray<GridCell>
  /** The name of the source that fills it; null when none does. */
  readonly filledBy: string | null
}

export const fillsWhat = <TAttr extends { readonly key: string | null }>(
  attributes: ReadonlyArray<TAttr>,
  sources: ReadonlyArray<GridSource>,
): Array<GridRow<TAttr>> =>
  attributes.map((attr) => {
    const { key } = attr
    let filledBy: string | null = null
    const cells = sources.map((s): GridCell => {
      if (key === null || !s.answers.has(key)) return 'none'
      if (!s.on) return 'could'
      if (filledBy !== null) return 'next'
      filledBy = s.name
      return 'fills'
    })
    return { ...attr, cells, filledBy }
  })

/** How many of the linked keys a source answers: its "can fill n fields". */
export const fillableCount = (
  linkedKeys: ReadonlyArray<string>,
  answers: ReadonlySet<string>,
): number => new Set(linkedKeys.filter((k) => answers.has(k))).size

/** One attribute event, as the where-from reads it. */
export type ValueEvent = {
  readonly slug: string
  readonly to: Json | null
  readonly from: Json | null
  /** ISO instant. */
  readonly at: string
  readonly actorType: 'user' | 'integration' | 'system'
  readonly actorRef: string | null
}

/** An earlier figure: its words and the day it was set, when known. */
export type EarlierValue = {
  readonly value: string
  readonly at: string | null
}

export type WhereFrom = {
  readonly source: string
  /** ISO instant of the write. */
  readonly at: string
  /** For a changing figure, newest first; empty otherwise. */
  readonly earlier: ReadonlyArray<EarlierValue>
}

/** How many earlier figures the popover shows. */
export const EARLIER_SHOWN = 3

/** A value in words: a number as written, a list joined. */
export const valueWords = (value: Json): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value)) return value.map(valueWords).join(', ')
  return value === null ? '' : JSON.stringify(value)
}

const blank = (value: Json | null) =>
  value === null || (typeof value === 'string' && value.trim() === '')

/**
 * Each slug whose latest write is an integration's: that source by name, the
 * write's date and — for a slug in `changing` — the earlier values with the
 * days they were set. `events` may come in any order.
 */
export const whereFromOf = (
  events: ReadonlyArray<ValueEvent>,
  names: ReadonlyMap<string, string>,
  changing: ReadonlySet<string>,
): Map<string, WhereFrom> => {
  const bySlug = new Map<string, Array<ValueEvent>>()
  for (const e of events) bySlug.set(e.slug, [...(bySlug.get(e.slug) ?? []), e])
  const out = new Map<string, WhereFrom>()
  for (const [slug, list] of bySlug) {
    const newest = [...list].sort((a, b) => (a.at < b.at ? 1 : -1))
    const latest = newest.at(0)
    if (
      latest === undefined ||
      latest.actorType !== 'integration' ||
      latest.actorRef === null ||
      blank(latest.to)
    )
      continue
    const earlier: Array<EarlierValue> = []
    if (changing.has(slug)) {
      const now = valueWords(latest.to)
      for (const e of newest.slice(1)) {
        if (e.to === null || blank(e.to) || valueWords(e.to) === now) continue
        earlier.push({ value: valueWords(e.to), at: e.at })
      }
      if (earlier.length === 0 && latest.from !== null && !blank(latest.from))
        earlier.push({ value: valueWords(latest.from), at: null })
    }
    out.set(slug, {
      source: names.get(latest.actorRef) ?? 'a removed source',
      at: latest.at,
      earlier: earlier.slice(0, EARLIER_SHOWN),
    })
  }
  return out
}
