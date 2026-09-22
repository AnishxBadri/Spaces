import { parseRef } from './ref'
import type { NameLookup } from './render'

/**
 * Citation labels — a `ContextItem.ref` turned into the words a person reads
 * beside the item ("deck.pdf · chunk 4", "Stage on Acme", "the mandate").
 * Pure, exactly as `render.ts` is: every name comes in through a lookup, so
 * this file never touches the database and its test needs no DATABASE_URL.
 * `names.ts` is the program that fills the lookup.
 *
 * Ids inside refs may be merged losers (`ref.ts`, decided 2026-09-09), so
 * every entity id is walked along `mergedInto` to the survivor before its
 * name is read. The walk is here, not in the lookup, so the rule lives in
 * one place whoever supplies the names.
 */

export type CiteLookup = {
  /**
   * Display name for an id: an entity's name (a document's filename, a
   * term's name, a note's title), or — keyed by the mandate row's id — the
   * name of the mandate's note entity.
   */
  name: NameLookup
  /** The entity an id was merged into, if it was. */
  mergedInto: NameLookup
  /** An attribute's display name on a record's object. */
  attribute: (entityId: string, slug: string) => string | undefined
}

/** Longer than any real merge chain; guards a cycle in bad data. */
const MAX_MERGE_HOPS = 8

/** Follow `merged_into_id` to the surviving record. */
export function survivor(id: string, mergedInto: NameLookup): string {
  let at = id
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const next = mergedInto(at)
    if (next === undefined || next === at) return at
    at = next
  }
  return at
}

/** `funding_stage` → `Funding stage`; `alias.domain` → `Domain`. */
export function humanizeSlug(slug: string): string {
  const tail = slug.startsWith('alias.') ? slug.slice('alias.'.length) : slug
  const words = tail.replace(/[_.]+/g, ' ').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : slug
}

export function cite(refString: string, lookup: CiteLookup): string {
  const p = parseRef(refString)
  if (p === null) return refString
  const nameOf = (id: string) => lookup.name(survivor(id, lookup.mergedInto))
  switch (p.kind) {
    case 'attr': {
      const id = survivor(p.entityId, lookup.mergedInto)
      const attr = lookup.attribute(id, p.slug) ?? humanizeSlug(p.slug)
      return `${attr} on ${lookup.name(id) ?? 'this record'}`
    }
    case 'doc':
      return `${nameOf(p.entityId) ?? 'a document'} · chunk ${String(p.idx)}`
    case 'note':
      return nameOf(p.entityId) ?? 'a note'
    case 'memo':
      return nameOf(p.entityId) ?? 'a memo'
    case 'term':
      return nameOf(p.entityId) ?? 'a glossary term'
    case 'mandate': {
      // The mandate's note entity is named "Mandate" by the one writer that
      // creates it; any other name is the owner's and is worth showing.
      const n = lookup.name(p.id)
      return n === undefined || n.trim().toLowerCase() === 'mandate'
        ? 'the mandate'
        : `the mandate · ${n}`
    }
    case 'event':
      return 'record history'
    case 'interaction':
      return 'interaction'
    case 'task':
      return 'task'
  }
}
