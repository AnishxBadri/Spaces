import type { AttributeDef } from '../attributes/registry'
import { FIRST_NAME_SLUG, LAST_NAME_SLUG } from '../attributes/person-name'
import { renderValue } from '../context/render'
import type { NameLookup } from '../context/render'
import { formatDate } from '../format'

/**
 * Variables as paths (D67): one grammar for an email and an AI prompt.
 * - A variable is `{{path}}`, the path dotted lowercase segments with no
 *   spaces: `{{name.first}}`, `{{company.name}}`, `{{stage}}`.
 * - The families are the person's name parts, their current company, the
 *   interaction stats; anything else is an attribute slug on the record.
 * - A path nothing matches is refused by name (`UnknownVariable`), never
 *   sent as literal braces. A path that matches but holds nothing is a blank.
 * - Pure: the caller reads the record and hands it in as a `VariableContext`.
 */

export type VariablePath = string

/** A path no family and no attribute slug matches. */
export class UnknownVariable {
  readonly _tag = 'UnknownVariable'
  readonly message: string
  constructor(readonly path: VariablePath) {
    this.message = `No attribute matches {{${path}}}`
  }
}

/** The interaction stats a path can read, as ISO instants. */
export type VariableStats = {
  last_interaction: string | null
  last_email: string | null
  next_meeting: string | null
}

/** The record one recipient is: what every path resolves against. */
export type VariableRecord = {
  canonicalName: string
  values: { readonly [slug: string]: unknown }
  /** The current company's name: the first of the person's `companies`. */
  company: string | null
  stats: VariableStats
}

export type VariableContext = {
  /** The object's live attributes: the slugs a path may name. */
  attributes: ReadonlyArray<AttributeDef>
  /** Null for an address no record holds: every known path is blank. */
  record: VariableRecord | null
  /** Names for the record and actor references a value holds. */
  names: NameLookup
}

const TOKEN = /\{\{([^{}]*)\}\}/g
const PATH = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/

/** Every `{{…}}` in `text`, distinct, in the order first written. */
export function parseVariables(text: string): Array<VariablePath> {
  const seen = new Set<VariablePath>()
  for (const m of text.matchAll(TOKEN)) seen.add(m[1])
  return [...seen]
}

const STAT_PATHS = new Map<VariablePath, keyof VariableStats>([
  ['last_interaction.when', 'last_interaction'],
  ['last_email.when', 'last_email'],
  ['next_meeting.when', 'next_meeting'],
])

const blank = (s: string | null | undefined): string | null =>
  typeof s === 'string' && s.trim() !== '' ? s.trim() : null

type Reader = (record: VariableRecord, names: NameLookup) => string | null

/** The reader for one path, or null when nothing matches it. */
function readerOf(
  path: VariablePath,
  attributes: ReadonlyArray<AttributeDef>,
): Reader | null {
  if (!PATH.test(path)) return null
  const part =
    (slug: string): Reader =>
    (r) => {
      const v = r.values[slug]
      return typeof v === 'string' ? blank(v) : null
    }
  if (path === 'name.first') return part(FIRST_NAME_SLUG)
  if (path === 'name.last') return part(LAST_NAME_SLUG)
  if (path === 'name.full') return (r) => blank(r.canonicalName)
  if (path === 'company.name') return (r) => blank(r.company)
  const stat = STAT_PATHS.get(path)
  if (stat !== undefined) return (r) => blank(formatDate(r.stats[stat]))
  if (path.includes('.')) return null
  const def = attributes.find((d) => d.slug === path && !d.archived)
  if (def === undefined) return null
  return (r, names) => blank(renderValue(def, r.values[path], names))
}

/** The first path in `paths` nothing matches, or null when all are known. */
export function checkVariables(
  paths: ReadonlyArray<VariablePath>,
  attributes: ReadonlyArray<AttributeDef>,
): UnknownVariable | null {
  const unknown = paths.find((p) => readerOf(p, attributes) === null)
  return unknown === undefined ? null : new UnknownVariable(unknown)
}

export type Resolved = {
  /** `text` with each variable replaced; a blank reads as its fill or ''. */
  text: string
  /** Each path's value for this record; null is a blank. */
  values: { [path: VariablePath]: string | null }
  /** The paths that resolved to nothing, in the order first written. */
  blanks: Array<VariablePath>
}

/**
 * Resolves every variable in `text` against one record.
 * - `fills` stand in for blanks only; a resolved value is never overridden.
 */
export function resolveVariables(
  text: string,
  ctx: VariableContext,
  fills: Readonly<Partial<Record<VariablePath, string>>> = {},
): Resolved | UnknownVariable {
  const values: { [path: VariablePath]: string | null } = {}
  for (const path of parseVariables(text)) {
    const read = readerOf(path, ctx.attributes)
    if (read === null) return new UnknownVariable(path)
    values[path] = ctx.record === null ? null : read(ctx.record, ctx.names)
  }
  const blanks = Object.keys(values).filter((p) => values[p] === null)
  return {
    text: text.replace(
      TOKEN,
      (_, path: string) => values[path] ?? fills[path] ?? '',
    ),
    values,
    blanks,
  }
}
