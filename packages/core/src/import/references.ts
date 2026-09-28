import {
  normalizeCin,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
} from '../entities/normalize'
import type { CoreIdentityKey, ObjectKind } from '../attributes/registry'
import type {
  ImportCellIssue,
  ImportCellValue,
  ImportCreator,
  ImportReference,
} from '@spaces/db/schema/import'

/**
 * **Reference cells** (SPA-168, project 14 `import-6`) — the pure half of
 * matching a `record_reference` or `actor_reference` cell to what it names.
 * The lookups are the database half's (`apps/web/src/lib/import/references.ts`);
 * what a cell reads as, what an outcome is called in the why lane, and what
 * an outcome does to the row are decided here.
 *
 * **Exact only, on purpose.** A cell finds a record by an identity key it
 * normalises as, or by a name alias that equals it once trimmed, collapsed
 * and lowercased — never by similarity. A near-match is a skipped cell the
 * operator fixes in the sheet: silently attaching a deal to the wrong
 * company is worse than a row that lands without one, and the fuzzy lane
 * already exists where it belongs — as a suggestion, never an attach
 * (CONTEXT.md, "deterministic auto, probabilistic suggest").
 */
export type { ImportReference }

/** A mapped reference column, as the plan reads it. */
export type ReferenceColumn =
  | {
      type: 'record'
      column: number
      attributeId: string
      multi: boolean
      /** The registry marks it required: an unresolved cell stops the row. */
      required: boolean
      createMissing: boolean
      /** The referenced object; null when it is archived or gone. */
      target: {
        objectId: string
        kind: ObjectKind | null
        singular: string
        plural: string
        identityKeys: ReadonlyArray<CoreIdentityKey>
        creator: ImportCreator
      } | null
    }
  | {
      type: 'member'
      column: number
      attributeId: string
      required: boolean
    }

/** What one reference cell found. */
export type ReferenceOutcome =
  | { status: 'found'; entityId: string; name: string }
  | { status: 'member'; userId: string; name: string }
  /** Two or more records answer to the name; their names, sorted. */
  | { status: 'ambiguous'; names: Array<string> }
  /** Nothing answers; the identity the cell read as, when it read as one. */
  | {
      status: 'missing'
      identity: { kind: CoreIdentityKey; value: string } | null
    }
  /** A member column holding something that is not an address. */
  | { status: 'not-email' }
  | { status: 'no-target' }

/** Column → the cell's `referenceKey` → its outcome. */
export type ReferenceLookup = ReadonlyMap<
  number,
  ReadonlyMap<string, ReferenceOutcome>
>

/**
 * The one form a reference cell is compared in: whitespace collapsed,
 * trimmed, lowercased — and nothing else. Not `normalizeName`, which drops
 * legal suffixes and punctuation for the fuzzy sweep: under it `Acme Inc`
 * and `Acme Labs` are one name, which is exactly the coin flip this refuses.
 */
export function referenceKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The identity key a reference cell reads as, if any — one, chosen by the
 * cell's shape and offered only when the referenced object carries that
 * key: a LinkedIn URL, else an address (anything with an `@`), else a CIN,
 * else a domain (a single token that has a registrable domain). A company
 * name has spaces or no public suffix, so it reads as none of them.
 */
export function cellIdentityKind(
  raw: string,
  keys: ReadonlyArray<CoreIdentityKey>,
): CoreIdentityKey | null {
  const s = raw.trim()
  const has = (k: CoreIdentityKey) => keys.includes(k)
  if (has('linkedin') && normalizeLinkedin(s) !== null) return 'linkedin'
  if (s.includes('@'))
    return has('email') && normalizeEmail(s) !== null ? 'email' : null
  if (has('cin') && normalizeCin(s) !== null) return 'cin'
  if (has('domain') && !/\s/.test(s) && normalizeDomain(s) !== null)
    return 'domain'
  return null
}

/** Names shown in an ambiguous cell's reason before `+N`. */
const NAMES_SHOWN = 3

/**
 * The why lane's words for an outcome: `no such company`, `2 matches: Acme
 * Inc, Acme Labs`, `use the member's email`. Null when the cell resolved.
 */
export function referenceReason(
  column: ReferenceColumn,
  outcome: ReferenceOutcome,
): string | null {
  switch (outcome.status) {
    case 'found':
    case 'member':
      return null
    case 'ambiguous': {
      const shown = outcome.names.slice(0, NAMES_SHOWN).join(', ')
      const more =
        outcome.names.length > NAMES_SHOWN
          ? ` +${outcome.names.length - NAMES_SHOWN}`
          : ''
      return `${outcome.names.length} matches: ${shown}${more}`
    }
    case 'missing':
      return column.type === 'member'
        ? 'no such member'
        : `no such ${(column.target?.singular ?? 'record').toLowerCase()}`
    case 'not-email':
      return "use the member's email"
    case 'no-target':
      return 'its object is archived'
  }
}

/** One non-blank reference cell of a row, waiting on its lookup. */
export type ReferenceCell = { column: number; attributeId: string; raw: string }

/** The batch-wide key of a secondary create: one per object and name (or key). */
export function createKey(
  objectId: string,
  raw: string,
  identity: { kind: CoreIdentityKey; value: string } | null,
): string {
  return identity
    ? `${objectId}|${identity.kind}:${identity.value}`
    : `${objectId}|name:${referenceKey(raw)}`
}

export type ReferenceResult = {
  patch: Record<string, ImportCellValue>
  references: Array<ImportReference>
  /** Unresolved cells of a required reference — the row does not land. */
  errors: Array<ImportCellIssue>
  skippedCells: Array<ImportCellIssue>
}

/**
 * A row's reference cells through their lookups. A hit writes the record's
 * id (in an array on a multi reference) or the member's id into the patch
 * and is named in `references`; a miss on a create-missing column plans a
 * create; anything else is a **skipped cell** and the row lands without it —
 * unless the registry marks the reference required, when it is the row's
 * error, naming the cell.
 */
export function resolveReferenceCells(
  cells: ReadonlyArray<ReferenceCell>,
  columns: ReadonlyMap<number, ReferenceColumn>,
  lookup: ReferenceLookup,
): ReferenceResult {
  const out: ReferenceResult = {
    patch: {},
    references: [],
    errors: [],
    skippedCells: [],
  }
  for (const cell of cells) {
    const column = columns.get(cell.column)
    if (!column) continue
    const outcome: ReferenceOutcome = lookup
      .get(cell.column)
      ?.get(referenceKey(cell.raw)) ?? { status: 'missing', identity: null }
    const base = { column: cell.column, attributeId: cell.attributeId }
    if (outcome.status === 'found') {
      out.patch[cell.attributeId] =
        column.type === 'record' && column.multi
          ? [outcome.entityId]
          : outcome.entityId
      out.references.push({
        ...base,
        to: 'record',
        entityId: outcome.entityId,
        name: outcome.name,
      })
      continue
    }
    if (outcome.status === 'member') {
      out.patch[cell.attributeId] = outcome.userId
      out.references.push({
        ...base,
        to: 'member',
        userId: outcome.userId,
        name: outcome.name,
      })
      continue
    }
    if (
      outcome.status === 'missing' &&
      column.type === 'record' &&
      column.createMissing &&
      column.target
    ) {
      const target = column.target
      const name = cell.raw.trim()
      const identity = outcome.identity
      out.references.push({
        ...base,
        to: 'create',
        key: createKey(target.objectId, cell.raw, identity),
        name,
        objectId: target.objectId,
        creator: target.creator,
        // The resolver births on a key alone; the other two need a name.
        createName:
          identity && target.creator === 'resolveEntity' ? null : name,
        identity: identity ? { [identity.kind]: identity.value } : {},
      })
      continue
    }
    const reason = referenceReason(column, outcome) ?? 'not found'
    if (column.required)
      out.errors.push({
        column: cell.column,
        raw: cell.raw,
        reason: `"${cell.raw.trim()}" · ${reason}`,
      })
    else out.skippedCells.push({ column: cell.column, raw: cell.raw, reason })
  }
  return out
}

/**
 * The count a mapping head shows for a reference column: cells found, of the
 * non-blank cells, and the ones that were not with their reasons. On a
 * create-missing column a miss is a planned create, not a failure.
 */
export type ReferenceSummary = {
  found: number
  total: number
  failures: Array<{ row: number; raw: string; reason: string }>
}

export function summarizeReferences(
  column: ReferenceColumn,
  values: ReadonlyArray<string>,
  outcomes: ReadonlyMap<string, ReferenceOutcome>,
): ReferenceSummary {
  const out: ReferenceSummary = { found: 0, total: 0, failures: [] }
  values.forEach((raw, row) => {
    if (raw.trim() === '') return
    out.total += 1
    const outcome: ReferenceOutcome = outcomes.get(referenceKey(raw)) ?? {
      status: 'missing',
      identity: null,
    }
    if (outcome.status === 'found' || outcome.status === 'member') {
      out.found += 1
      return
    }
    if (
      outcome.status === 'missing' &&
      column.type === 'record' &&
      column.createMissing &&
      column.target
    )
      return
    out.failures.push({
      row,
      raw,
      reason: `"${raw.trim()}" · ${referenceReason(column, outcome) ?? 'not found'}`,
    })
  })
  return out
}
