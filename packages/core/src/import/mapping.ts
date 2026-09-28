import { deriveOptionIds } from '../attributes/options'
import {
  CORE_IDENTITY_KEYS,
  slugifyAttributeName,
} from '../attributes/registry'
import type {
  AttributeOptions,
  AttributeType,
  CoreIdentityKey,
} from '../attributes/registry'
import { normalizeCin } from '../entities/normalize'
import { coerce, summarizeColumn } from './coerce'
import type { CoerceOptions, ColumnSummary, Coercion } from './coerce'
import type {
  ColumnTarget,
  ImportDateOrder,
  Mapping,
} from '@spaces/db/schema/import'

/**
 * The mapping step's rules (SPA-165, project 14 `import-3`). Pure: the caller
 * hands over the target object's registry, and everything the mapping table
 * offers, guesses and refuses is computed from it — which is why a custom
 * object maps with no importer code. The shape itself is declared at the
 * `import_batch.mapping` column and re-exported here.
 */
export type { ColumnTarget, ImportDateOrder, Mapping }

/** What the mapping needs of one attribute row. */
export type MappingAttribute = {
  id: string
  slug: string
  name: string
  type: AttributeType
  options: AttributeOptions
  archived: boolean
}

/**
 * The target object as the mapping sees it: its attributes (archived ones
 * included — the registry is passed whole and filtered here) and its
 * identity keys, which the caller reads through `identityKeysOf`.
 */
export type MappingRegistry = {
  attributes: ReadonlyArray<MappingAttribute>
  identityKeys: ReadonlyArray<CoreIdentityKey>
}

/** How an identity key reads in a picker. */
export const IDENTITY_KEY_LABELS: Record<CoreIdentityKey, string> = {
  domain: 'Domain',
  email: 'Email',
  linkedin: 'LinkedIn',
  cin: 'CIN',
}

// ---------------------------------------------------------------------------
// What is offered
// ---------------------------------------------------------------------------

/**
 * A reference is matched to a record, not read from its cell — `coerce`
 * refuses every cell of these two types — so no column maps onto one here.
 */
export function cellCarries(type: AttributeType): boolean {
  return type !== 'record_reference' && type !== 'actor_reference'
}

/**
 * The attributes a column may map onto: live, of a type a cell can carry,
 * and not the backing attribute of an identity key — a custom object's
 * declared `domain` is offered once, as the identity target it is.
 */
export function mappableAttributes(
  registry: MappingRegistry,
): Array<MappingAttribute> {
  return registry.attributes.filter(
    (a) =>
      !a.archived && cellCarries(a.type) && a.options.identityKey === undefined,
  )
}

/**
 * The attribute types a `+ New attribute` may be born as — the type menu in
 * the attribute dialog's order, less the two references. The operator picks
 * one; nothing here infers it from the column.
 */
export const NEW_ATTRIBUTE_TYPES: ReadonlyArray<AttributeType> = [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'rating',
  'url',
  'email',
  'phone',
  'domain',
]

export function isNewAttributeType(value: string): value is AttributeType {
  return NEW_ATTRIBUTE_TYPES.some((t) => t === value)
}

export function isCoreIdentityKey(value: string): value is CoreIdentityKey {
  return CORE_IDENTITY_KEYS.some((k) => k === value)
}

// ---------------------------------------------------------------------------
// Column names
// ---------------------------------------------------------------------------

/** A, B, … Z, AA — a sheet column's letter. */
export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** `A · Company`, or `A` when the sheet has no header row. */
export function columnName(
  index: number,
  headers: ReadonlyArray<string> | null,
): string {
  const h = headers?.at(index)?.trim() ?? ''
  return h === '' ? columnLetter(index) : `${columnLetter(index)} · ${h}`
}

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

/**
 * What a target claims: the name, one attribute, one identity key. Two
 * columns never hold one claim. Ignored and not-yet-created columns claim
 * nothing.
 */
function claimOf(t: ColumnTarget): string | null {
  switch (t.target) {
    case 'name':
      return 'name'
    case 'attribute':
      return `attribute:${t.attributeId}`
    case 'identity':
      return `identity:${t.key}`
    case 'ignore':
    case 'new':
      return null
  }
}

export type Replaced = { column: number; previous: ColumnTarget }

/**
 * One column takes one target. A target another column already held is
 * taken from it — that column falls back to ignored — and the caller is told
 * which, so it can name what the choice replaced.
 */
export function assignColumn(
  mapping: Mapping,
  column: number,
  target: ColumnTarget,
): { mapping: Mapping; replaced: Array<Replaced> } {
  const claim = claimOf(target)
  const replaced: Array<Replaced> = []
  const next = mapping.map((t, i): ColumnTarget => {
    if (i === column) return target
    if (claim !== null && claimOf(t) === claim) {
      replaced.push({ column: i, previous: t })
      return { target: 'ignore' }
    }
    return t
  })
  return { mapping: next, replaced }
}

/** A stored mapping fitted to the sheet's width: extra columns ignored, missing ones dropped. */
export function fitMapping(mapping: Mapping, columnCount: number): Mapping {
  return Array.from(
    { length: columnCount },
    (_, i): ColumnTarget => mapping.at(i) ?? { target: 'ignore' },
  )
}

// ---------------------------------------------------------------------------
// The guess
// ---------------------------------------------------------------------------

/**
 * The alias table: a header that means a field without spelling it. Each
 * entry names a slug, which is then matched exactly as a header would be —
 * so `Website` finds the domain key only where the object has one, and
 * `Round` finds a `stage` only on an object that carries it.
 */
const ALIASES: Record<string, string> = {
  website: 'domain',
  company: 'name',
  company_name: 'name',
  round: 'stage',
  email_address: 'email',
  linkedin_url: 'linkedin',
}

/** The header's slug, or null when it has no letters or digits to match on. */
function headerSlug(header: string): string | null {
  return /[a-z0-9]/i.test(header) ? slugifyAttributeName(header) : null
}

function bySlug(
  slug: string,
  registry: MappingRegistry,
  attributes: ReadonlyArray<MappingAttribute>,
): ColumnTarget | null {
  if (slug === 'name') return { target: 'name' }
  const key = registry.identityKeys.find((k) => k === slug)
  if (key) return { target: 'identity', key }
  const attr = attributes.find((a) => a.slug === slug)
  return attr ? { target: 'attribute', attributeId: attr.id } : null
}

function byName(
  header: string,
  attributes: ReadonlyArray<MappingAttribute>,
): ColumnTarget | null {
  const want = header.trim().toLowerCase()
  const attr = attributes.find((a) => a.name.trim().toLowerCase() === want)
  return attr ? { target: 'attribute', attributeId: attr.id } : null
}

/**
 * The deterministic first guess. Three passes over the headers, each
 * filling only columns still unmapped and never a target already taken:
 * the slugified header against the name, the identity keys and the
 * attribute slugs; then the header against attribute names; then the alias
 * table. Running the passes across all columns before the next one is what
 * lets an exact `Name` column win over a `Company` alias. Anything left is
 * ignored — never a guess.
 */
export function autoMap(
  headers: ReadonlyArray<string>,
  registry: MappingRegistry,
): Mapping {
  const attributes = mappableAttributes(registry)
  const mapping: Mapping = headers.map(() => ({ target: 'ignore' }))
  const taken = new Set<string>()
  const pass = (guess: (header: string) => ColumnTarget | null) => {
    headers.forEach((header, i) => {
      if (mapping[i].target !== 'ignore') return
      const target = guess(header)
      if (!target) return
      const claim = claimOf(target)
      if (claim === null || taken.has(claim)) return
      taken.add(claim)
      mapping[i] = target
    })
  }
  pass((h) => {
    const slug = headerSlug(h)
    return slug ? bySlug(slug, registry, attributes) : null
  })
  pass((h) => (headerSlug(h) ? byName(h, attributes) : null))
  pass((h) => {
    const slug = headerSlug(h)
    const alias = slug ? ALIASES[slug] : undefined
    return alias ? bySlug(alias, registry, attributes) : null
  })
  return mapping
}

// ---------------------------------------------------------------------------
// Reading a column
// ---------------------------------------------------------------------------

/**
 * How a mapped column's cells are read: a registry type with its options
 * (the name reads as text), or a CIN, which is an identity key with no
 * attribute type behind it and reads through its own normalizer.
 */
export type ColumnSpec =
  | { kind: 'typed'; type: AttributeType; options: CoerceOptions }
  | { kind: 'cin' }

const withOrder = (
  options: AttributeOptions,
  dateOrder: ImportDateOrder | undefined,
): CoerceOptions => (dateOrder ? { ...options, dateOrder } : options)

/** The options a not-yet-created select would carry, for reading its column. */
function draftOptions(labels: ReadonlyArray<string>): AttributeOptions {
  const ids = deriveOptionIds([...labels])
  return { options: labels.map((label, i) => ({ id: ids[i], label })) }
}

/**
 * An identity key read the way its write path will read it: `domain` and
 * `linkedin` through the identity-backed validators (free mail refused),
 * `email` as an address, `cin` through its normalizer.
 */
function identitySpec(key: CoreIdentityKey): ColumnSpec {
  switch (key) {
    case 'domain':
      return { kind: 'typed', type: 'domain', options: { identityKey: key } }
    case 'linkedin':
      return { kind: 'typed', type: 'url', options: { identityKey: key } }
    case 'email':
      return { kind: 'typed', type: 'email', options: {} }
    case 'cin':
      return { kind: 'cin' }
  }
}

export function specFor(
  target: ColumnTarget,
  registry: MappingRegistry,
): ColumnSpec | null {
  switch (target.target) {
    case 'ignore':
      return null
    case 'name':
      return { kind: 'typed', type: 'text', options: {} }
    case 'attribute': {
      const attr = registry.attributes.find((a) => a.id === target.attributeId)
      return attr
        ? {
            kind: 'typed',
            type: attr.type,
            options: withOrder(attr.options, target.dateOrder),
          }
        : null
    }
    case 'identity':
      return identitySpec(target.key)
    case 'new':
      return {
        kind: 'typed',
        type: target.type,
        options: withOrder(
          draftOptions(target.options ?? []),
          target.dateOrder,
        ),
      }
  }
}

/**
 * The short word for a cell a column will not read, by type — what a sample
 * cell prints in the mapping grid and what a skipped cell says in the
 * preview's why lane (`Raise "TBD" skipped · not money`).
 */
const SHORT_REFUSAL: Partial<Record<AttributeType, string>> = {
  number: 'not a number',
  currency: 'not money',
  date: 'not a date',
  checkbox: 'not yes/no',
  rating: 'not a rating',
  domain: 'not a domain',
  email: 'not an email',
  url: 'not a url',
  phone: 'not a phone',
  text: 'too long',
}

export function shortRefusal(spec: ColumnSpec): string {
  if (spec.kind === 'cin') return 'not a cin'
  return SHORT_REFUSAL[spec.type] ?? 'not read'
}

/**
 * A refusal with the cell taken off the front — the cell travels beside it
 * as `raw`, so `"TBD" is not a number` on a currency column reads `not
 * money`, while a refusal that says more than "is not" (`has a two-digit
 * year — write it in full`, `an archived option — pick a current one`)
 * keeps its words.
 */
export function cellReason(spec: ColumnSpec, reason: string): string {
  const rest = reason.replace(/^"[^"]*"\s*:?\s*/, '')
  if (rest.startsWith('is not ')) return shortRefusal(spec)
  const said = rest.replace(/^is /, '')
  return said === '' ? shortRefusal(spec) : said
}

/** One cell through a column's spec. */
export function readCell(spec: ColumnSpec, raw: string | null): Coercion {
  if (spec.kind === 'typed') return coerce(spec.type, spec.options, raw)
  if (raw === null || raw.trim() === '') return { ok: true, value: null }
  const s = raw.trim()
  return normalizeCin(s)
    ? { ok: true, value: s }
    : { ok: false, reason: `"${s}" is not a CIN` }
}

/** `summarizeColumn` for a mapped column — the count its head shows. */
export function summarizeSpec(
  spec: ColumnSpec,
  rawValues: ReadonlyArray<string | null>,
): ColumnSummary {
  if (spec.kind === 'typed')
    return summarizeColumn(spec.type, spec.options, rawValues)
  const summary: ColumnSummary = { parsed: 0, total: 0, failures: [] }
  rawValues.forEach((raw, row) => {
    if (raw === null || raw.trim() === '') return
    summary.total += 1
    const out = readCell(spec, raw)
    if (out.ok) summary.parsed += 1
    else summary.failures.push({ row, raw, reason: out.reason })
  })
  return summary
}

const OPTION_TYPES: ReadonlySet<AttributeType> = new Set([
  'select',
  'status',
  'multi_select',
])

export type ColumnStatus = 'ok' | 'warn' | 'fail'

/**
 * The head's status mark. `fail` when cells will not parse; `warn` when the
 * only refusals are labels that are not options (a choice for the operator,
 * not a broken cell) or when an identity key has blanks (those rows match on
 * name alone); `ok` otherwise. Ignored columns carry none.
 */
export function columnStatus(
  target: ColumnTarget,
  spec: ColumnSpec | null,
  summary: ColumnSummary,
  blanks: number,
): ColumnStatus | null {
  if (spec === null || target.target === 'ignore') return null
  if (summary.failures.length > 0)
    return spec.kind === 'typed' && OPTION_TYPES.has(spec.type)
      ? 'warn'
      : 'fail'
  if (target.target === 'identity' && blanks > 0) return 'warn'
  return 'ok'
}

/**
 * The labels a `+ New attribute` select is offered, from the column's
 * values: distinct case-insensitively (first spelling kept), a multi-select
 * cell split on commas and semicolons as `coerce` splits it, in order of
 * first appearance, capped at what the create program takes.
 */
export const MAX_NEW_OPTIONS = 50

export function optionLabelsFrom(
  type: AttributeType,
  rawValues: ReadonlyArray<string | null>,
): Array<string> {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const raw of rawValues) {
    if (raw === null) continue
    const labels = type === 'multi_select' ? raw.split(/[,;]/) : [raw]
    for (const l of labels) {
      const label = l.trim().slice(0, 60)
      const key = label.toLowerCase()
      if (label === '' || seen.has(key)) continue
      seen.add(key)
      out.push(label)
      if (out.length >= MAX_NEW_OPTIONS) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type MappingProblem = { column: number | null; reason: string }

/**
 * What stops the step from advancing, each with its reason: no name column,
 * two columns on one claim, a column pointing at an attribute or key the
 * object does not offer, and a new attribute still waiting on its confirm.
 */
export function validateMapping(
  mapping: Mapping,
  registry: MappingRegistry,
  headers: ReadonlyArray<string> | null,
): Array<MappingProblem> {
  const problems: Array<MappingProblem> = []
  const offered = new Set(mappableAttributes(registry).map((a) => a.id))
  const name = (i: number) => columnName(i, headers)
  const byClaim = new Map<string, Array<number>>()
  mapping.forEach((t, i) => {
    const claim = claimOf(t)
    if (claim !== null) byClaim.set(claim, [...(byClaim.get(claim) ?? []), i])
    if (t.target === 'attribute' && !offered.has(t.attributeId))
      problems.push({
        column: i,
        reason: `${name(i)} maps to an attribute that is archived or gone`,
      })
    if (
      t.target === 'identity' &&
      !registry.identityKeys.some((k) => k === t.key)
    )
      problems.push({
        column: i,
        reason: `${name(i)} maps to ${t.key}, which does not identify these records`,
      })
    if (t.target === 'new')
      problems.push({
        column: i,
        reason: `${name(i)}: create the new attribute or skip the column`,
      })
  })
  const names = byClaim.get('name') ?? []
  if (names.length === 0)
    problems.unshift({ column: null, reason: 'Map one column to the name' })
  for (const [claim, columns] of byClaim) {
    if (columns.length < 2) continue
    const which = columns.map(name).join(' and ')
    problems.push({
      column: columns[1],
      reason:
        claim === 'name'
          ? `Only one column can be the name — ${which} both are`
          : `${which} map to the same field`,
    })
  }
  return problems
}

/** The mapped columns where nothing parses — called out before the step advances. */
export function unparsedColumns(
  mapping: Mapping,
  summaries: ReadonlyArray<ColumnSummary | null>,
  headers: ReadonlyArray<string> | null,
): Array<MappingProblem> {
  const problems: Array<MappingProblem> = []
  mapping.forEach((t, i) => {
    const s = summaries.at(i)
    if (t.target === 'ignore' || !s) return
    if (s.total > 0 && s.parsed === 0)
      problems.push({
        column: i,
        reason: `Nothing in ${columnName(i, headers)} parses — map it elsewhere or skip it`,
      })
  })
  return problems
}
