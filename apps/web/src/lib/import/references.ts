import { Effect } from 'effect'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias, objectDef, user } from '@spaces/db/schema'
import {
  CORE_OBJECTS,
  coreKindOf,
  identityKeysOf,
} from '@spaces/core/attributes/registry'
import { creatorFor } from '@spaces/core/import/plan'
import { cellIdentityKind, referenceKey } from '@spaces/core/import/references'
import {
  matchIdentity,
  normalizeIdentityValue,
  normalizeKeys,
} from '@spaces/core/writes/entities/resolve'
import { canonicalId } from '@spaces/core/writes/entities/sweep'
import { ImportFailed } from './stage'
import type {
  CoreIdentityKey,
  ObjectKind,
} from '@spaces/core/attributes/registry'
import type { Mapping, MappingRegistry } from '@spaces/core/import/mapping'
import type {
  ReferenceColumn,
  ReferenceLookup,
  ReferenceOutcome,
} from '@spaces/core/import/references'

/**
 * **Reference cells find their record** (SPA-168, import-6) — the database
 * half. A `record_reference` cell is matched, in order and exactly:
 *
 * 1. by the referenced object's identity key, when the cell reads as one
 *    (a domain in a company column, an address in a person column) —
 *    through `matchIdentity`, the lookup `resolveEntity` and the preview
 *    already share, so a reference finds what a resolve would;
 * 2. by a `name` alias (or the record's own name) of the referenced object
 *    that equals the cell once whitespace is collapsed and case dropped;
 * 3. two or more records by that name → ambiguous, naming them;
 * 4. none → missing.
 *
 * **There is no fuzzy step, and there must not be one.** A near-match is a
 * skipped cell the operator fixes in the sheet; a guess that attaches a deal
 * to the wrong company is silent and far worse. Similarity belongs to the
 * nightly sweep, which only ever suggests (CONTEXT.md, "deterministic auto,
 * probabilistic suggest").
 *
 * An `actor_reference` cell is a workspace member's email, matched exactly
 * and case-insensitively against `user.email`. A name is not accepted, and an
 * unknown address never falls back to the importing user.
 *
 * Read-only throughout. Outside `lib/server/` for the barrel's reason
 * (CLAUDE.md → Traps).
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

type Target = NonNullable<
  Extract<ReferenceColumn, { type: 'record' }>['target']
>

/** Values per `in (…)` — well under Postgres' bind-parameter ceiling. */
const IN_CHUNK = 5000

function chunks<T>(items: ReadonlyArray<T>): Array<Array<T>> {
  const out: Array<Array<T>> = []
  for (let i = 0; i < items.length; i += IN_CHUNK)
    out.push(items.slice(i, i + IN_CHUNK))
  return out
}

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

async function targetObject(
  options: { targetKind?: ObjectKind; targetObjectId?: string },
  cache: Map<string, Target | null>,
): Promise<Target | null> {
  const cacheKey = options.targetObjectId ?? `kind:${options.targetKind}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const where = options.targetObjectId
    ? eq(objectDef.id, options.targetObjectId)
    : and(
        eq(objectDef.slug, CORE_OBJECTS[options.targetKind ?? 'company'].slug),
        eq(objectDef.isSystem, true),
      )
  const row = (
    await db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
        identityKeys: objectDef.identityKeys,
      })
      .from(objectDef)
      .where(where)
  ).at(0)
  const kind = row ? coreKindOf(row) : null
  const target: Target | null =
    !row || row.archived
      ? null
      : {
          objectId: row.id,
          kind,
          singular: row.singular,
          plural: row.plural,
          identityKeys: identityKeysOf(row),
          creator: creatorFor(kind),
        }
  cache.set(cacheKey, target)
  return target
}

/** The mapped reference columns, each with the object it points at. */
export const referenceColumnsOf = Effect.fn('referenceColumnsOf')(function* (
  mapping: Mapping,
  registry: MappingRegistry,
): Effect.fn.Return<Map<number, ReferenceColumn>, ImportFailed> {
  const out = new Map<number, ReferenceColumn>()
  const cache = new Map<string, Target | null>()
  for (const [column, target] of mapping.entries()) {
    if (target.target !== 'attribute') continue
    const attr = registry.attributes.find((a) => a.id === target.attributeId)
    if (!attr) continue
    const required = attr.options.required === true
    if (attr.type === 'actor_reference') {
      out.set(column, {
        type: 'member',
        column,
        attributeId: attr.id,
        required,
      })
      continue
    }
    if (attr.type !== 'record_reference') continue
    const options = attr.options
    out.set(column, {
      type: 'record',
      column,
      attributeId: attr.id,
      multi: options.multi === true,
      required,
      createMissing: target.createMissing === true,
      target: yield* query(() => targetObject(options, cache)),
    })
  }
  return out
})

/**
 * What each reference attribute points at, for the picker: `record →
 * Companies` or `member`, and the plural a create-missing toggle names.
 */
export type ReferenceLabel = { type: string; plural: string | null }

export const referenceLabelsOf = Effect.fn('referenceLabelsOf')(function* (
  registry: MappingRegistry,
): Effect.fn.Return<Partial<Record<string, ReferenceLabel>>, ImportFailed> {
  const out: Partial<Record<string, ReferenceLabel>> = {}
  const cache = new Map<string, Target | null>()
  for (const attr of registry.attributes) {
    if (attr.type === 'actor_reference')
      out[attr.id] = { type: 'member', plural: null }
    if (attr.type !== 'record_reference') continue
    const options = attr.options
    const target = yield* query(() => targetObject(options, cache))
    out[attr.id] = target
      ? { type: `record → ${target.plural}`, plural: target.plural }
      : { type: 'record', plural: null }
  }
  return out
})

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The cell as the referenced object's creator would normalise the key. */
function identityNorm(
  target: Target,
  kind: CoreIdentityKey,
  raw: string,
): string | null {
  if (target.kind === 'company' || target.kind === 'person')
    return (
      normalizeKeys({ kind: target.kind, keys: { [kind]: raw } }).at(0)
        ?.valueNorm ?? null
    )
  return normalizeIdentityValue(kind, raw)
}

/** Step 1: the live record of the referenced object an identity key names. */
async function identityHit(
  target: Target,
  kind: CoreIdentityKey,
  raw: string,
  valueNorm: string,
): Promise<string | null> {
  if (target.kind === 'company' || target.kind === 'person') {
    const hit = await matchIdentity(target.kind, [
      { kind, value: raw.trim(), valueNorm },
    ])
    return hit?.entityId ?? null
  }
  // A custom object's declared key: the claim, followed through a merge,
  // held by a live record of that object.
  const alias = (
    await db
      .select({ entityId: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, kind),
          eq(entityAlias.valueNorm, valueNorm),
          eq(entityAlias.isIdentity, true),
        ),
      )
      .limit(1)
  ).at(0)
  if (!alias) return null
  const id = await canonicalId(alias.entityId)
  const live = (
    await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          eq(entity.id, id),
          eq(entity.objectId, target.objectId),
          isNull(entity.mergedIntoId),
        ),
      )
  ).at(0)
  return live?.id ?? null
}

/** `referenceKey` in SQL: whitespace collapsed, trimmed, lowercased. */
const exactKey = (
  column: typeof entityAlias.value | typeof entity.canonicalName,
) => sql<string>`lower(btrim(regexp_replace(${column}, ${'\\s+'}, ' ', 'g')))`

/**
 * Steps 2–3: every live record of the object whose name alias — or whose
 * own name, for a record born without one — equals a key, by key.
 */
async function nameCandidates(
  objectId: string,
  keys: ReadonlyArray<string>,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  const add = (rows: Array<{ id: string; name: string; key: string }>) => {
    for (const r of rows) {
      const held = out.get(r.key) ?? new Map<string, string>()
      held.set(r.id, r.name)
      out.set(r.key, held)
    }
  }
  for (const chunk of chunks(keys)) {
    const aliasKey = exactKey(entityAlias.value)
    add(
      await db
        .selectDistinct({
          id: entity.id,
          name: entity.canonicalName,
          key: aliasKey,
        })
        .from(entityAlias)
        .innerJoin(entity, eq(entity.id, entityAlias.entityId))
        .where(
          and(
            eq(entityAlias.kind, 'name'),
            eq(entity.objectId, objectId),
            isNull(entity.mergedIntoId),
            inArray(aliasKey, chunk),
          ),
        ),
    )
    const ownKey = exactKey(entity.canonicalName)
    add(
      await db
        .select({ id: entity.id, name: entity.canonicalName, key: ownKey })
        .from(entity)
        .where(
          and(
            eq(entity.objectId, objectId),
            isNull(entity.mergedIntoId),
            inArray(ownKey, chunk),
          ),
        ),
    )
  }
  return out
}

async function lookupRecords(
  target: Target,
  cells: ReadonlyMap<string, string>,
): Promise<Map<string, ReferenceOutcome>> {
  const out = new Map<string, ReferenceOutcome>()
  const hits = new Map<string, string>()
  const byName: Array<string> = []
  const readAs = new Map<string, { kind: CoreIdentityKey; value: string }>()
  for (const [key, raw] of cells) {
    const kind = cellIdentityKind(raw, target.identityKeys)
    const norm = kind ? identityNorm(target, kind, raw) : null
    if (kind && norm) {
      const id = await identityHit(target, kind, raw, norm)
      if (id) {
        hits.set(key, id)
        continue
      }
      readAs.set(key, { kind, value: norm })
    }
    byName.push(key)
  }
  const named = await nameCandidates(target.objectId, byName)
  for (const key of byName) {
    const found = [...(named.get(key) ?? new Map<string, string>()).entries()]
    const only = found.at(0)
    if (found.length === 1 && only) {
      out.set(key, { status: 'found', entityId: only[0], name: only[1] })
      continue
    }
    if (found.length > 1) {
      out.set(key, {
        status: 'ambiguous',
        names: found.map(([, name]) => name).sort((a, b) => a.localeCompare(b)),
      })
      continue
    }
    out.set(key, { status: 'missing', identity: readAs.get(key) ?? null })
  }
  const ids = [...new Set(hits.values())]
  const names = new Map<string, string>()
  for (const chunk of chunks(ids)) {
    const rows = await db
      .select({ id: entity.id, name: entity.canonicalName })
      .from(entity)
      .where(inArray(entity.id, chunk))
    for (const r of rows) names.set(r.id, r.name)
  }
  for (const [key, id] of hits)
    out.set(key, { status: 'found', entityId: id, name: names.get(id) ?? id })
  return out
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async function lookupMembers(
  cells: ReadonlyMap<string, string>,
): Promise<Map<string, ReferenceOutcome>> {
  const out = new Map<string, ReferenceOutcome>()
  const emails: Array<string> = []
  for (const [key, raw] of cells) {
    if (!raw.includes('@')) out.set(key, { status: 'not-email' })
    else emails.push(key)
  }
  const found = new Map<string, { id: string; name: string }>()
  for (const chunk of chunks(emails)) {
    const lower = sql<string>`lower(${user.email})`
    const rows = await db
      .select({ id: user.id, name: user.name, email: lower })
      .from(user)
      .where(inArray(lower, chunk))
    for (const r of rows) found.set(r.email, { id: r.id, name: r.name })
  }
  for (const key of emails) {
    const member = found.get(key)
    out.set(
      key,
      member
        ? { status: 'member', userId: member.id, name: member.name }
        : { status: 'missing', identity: null },
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

/**
 * Every distinct non-blank cell of every reference column, looked up once —
 * the plan and the mapping head's `n of m found` read the same answer.
 */
export const lookupReferences = Effect.fn('lookupReferences')(function* (
  columns: ReadonlyMap<number, ReferenceColumn>,
  rows: ReadonlyArray<{ cells: ReadonlyArray<string> }>,
): Effect.fn.Return<ReferenceLookup, ImportFailed> {
  const out = new Map<number, Map<string, ReferenceOutcome>>()
  for (const [column, spec] of columns) {
    const cells = new Map<string, string>()
    for (const row of rows) {
      const raw = row.cells.at(column) ?? ''
      if (raw.trim() === '') continue
      const key = referenceKey(raw)
      if (!cells.has(key)) cells.set(key, raw)
    }
    if (spec.type === 'member') {
      out.set(column, yield* query(() => lookupMembers(cells)))
      continue
    }
    const target = spec.target
    if (target === null) {
      out.set(
        column,
        new Map([...cells.keys()].map((k) => [k, { status: 'no-target' }])),
      )
      continue
    }
    out.set(column, yield* query(() => lookupRecords(target, cells)))
  }
  return out
})
