import { isDerived } from '@spaces/core/attributes/relationship'
import type { AttributeOptions } from '@spaces/core/attributes/registry'

/** What the rail reads of an attribute definition. */
type RailDef = {
  slug: string
  type: string
  options: AttributeOptions | null
}

/** The record kinds with a page of their own; `custom` is any object row. */
export type RecordPageKind = 'company' | 'person' | 'deal' | 'custom'

/**
 * The relationship groups each record page draws itself, before
 * `RelationSections` draws the rest.
 */
export const OWN_SECTIONS: Record<RecordPageKind, ReadonlyArray<string>> = {
  company: ['team', 'associated_deals'],
  person: ['companies', 'deals'],
  deal: ['company', 'people'],
  custom: [],
}

/**
 * What a record's head already says, so its rail leaves it out: a person's
 * name parts (the title; `Rename…` edits them) and a deal's stage (the
 * badge, the stepper and Move stage).
 */
export const HEAD_OWNED: Record<RecordPageKind, ReadonlyArray<string>> = {
  company: [],
  person: ['first_name', 'last_name'],
  deal: ['stage'],
  custom: [],
}

/**
 * A text attribute marked long: a paragraph in the record's Overview, never
 * a rail row.
 */
export function isLongText(def: RailDef): boolean {
  return def.type === 'text' && def.options?.longText === true
}

/**
 * The attributes the rail prints as rows, in registry order.
 * - A relationship whose section the rail draws (`sectioned`) shows there
 *   and only there; one with no section stays a row.
 * - `hidden`: what the head already says — a person's name parts, a deal's
 *   stage.
 */
export function railDefs<TDef extends RailDef>(
  defs: ReadonlyArray<TDef>,
  sectioned: ReadonlySet<string>,
  hidden: ReadonlyArray<string> = [],
): Array<TDef> {
  return defs.filter(
    (d) =>
      !(d.type === 'record_reference' && sectioned.has(d.slug)) &&
      !hidden.includes(d.slug),
  )
}

/** A registry row as the relationship groups read it. */
type PairDef = {
  slug: string
  type: string
  options: AttributeOptions
  pair: { archived: boolean } | null
}

/**
 * The relationship attributes `RelationSections` draws a group for: a paired
 * half, unless it is the derived half of an archived owner, and not one the
 * page draws itself (`skip`).
 */
export function pairSectionDefs<TDef extends PairDef>(
  defs: ReadonlyArray<TDef>,
  skip: ReadonlyArray<string>,
): Array<TDef> {
  return defs.filter(
    (d) =>
      d.type === 'record_reference' &&
      d.options.inverseOf !== undefined &&
      d.pair !== null &&
      !(isDerived(d) && d.pair.archived) &&
      !skip.includes(d.slug),
  )
}

/**
 * Every relationship the rail draws as a section: the page's own groups
 * and the generic ones. Such an attribute shows once, as its section, and
 * never as a rail row.
 */
export function sectionedSlugs(
  defs: ReadonlyArray<PairDef>,
  own: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set([...own, ...pairSectionDefs(defs, own).map((d) => d.slug)])
}

/** A record page's rail rows: its kind's sections and head taken out. */
export function recordRailDefs<TDef extends PairDef>(
  kind: RecordPageKind,
  defs: ReadonlyArray<TDef>,
): Array<TDef> {
  return railDefs(
    defs,
    sectionedSlugs(defs, OWN_SECTIONS[kind]),
    HEAD_OWNED[kind],
  )
}
