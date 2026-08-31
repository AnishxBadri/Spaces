import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '#/db'
import {
  company,
  duplicateCandidate,
  entity,
  entityAlias,
  person,
} from '#/db/schema'
import {
  isRoleEmail,
  normalizeCin,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
} from './normalize'

/**
 * THE choke point. Every entity creator — manual, deck, mention, clip,
 * Apollo, Gmail — goes through resolveEntity(). No exceptions; bypassing
 * it is how the database rots.
 *
 * Doctrine: deterministic auto, probabilistic suggest.
 * - Exact identity-key match (domain/email/linkedin/cin) → attach.
 * - No match → create, then fuzzy-sweep names into duplicate_candidate.
 * - Fuzzy NEVER merges or attaches.
 */

export type EntityKindResolvable = 'company' | 'person' | 'organization'

export type ResolveInput = {
  kind: EntityKindResolvable
  name?: string
  keys?: {
    domain?: string
    email?: string
    linkedin?: string
    cin?: string
  }
  source: 'manual' | 'gmail' | 'apollo' | 'import' | 'clip'
  createdBy?: string
}

export type ResolveResult = {
  entityId: string
  action: 'attached' | 'created'
  /** Which key matched, when attached. */
  matchedOn?: 'domain' | 'email' | 'linkedin' | 'cin'
}

type NormalizedKey = {
  kind: 'domain' | 'email' | 'linkedin' | 'cin'
  value: string
  valueNorm: string
}

function normalizeKeys(input: ResolveInput): Array<NormalizedKey> {
  const out: Array<NormalizedKey> = []
  const k = input.keys ?? {}
  if (k.domain) {
    const norm = normalizeDomain(k.domain)
    if (norm)
      out.push({ kind: 'domain', value: k.domain.trim(), valueNorm: norm })
  }
  if (k.email) {
    const norm = normalizeEmail(k.email)
    // Role emails (info@, careers@…) never identify a person — anyone can
    // send from them, so matching on one would weld strangers together.
    if (norm && !(input.kind === 'person' && isRoleEmail(norm))) {
      out.push({ kind: 'email', value: k.email.trim(), valueNorm: norm })
    }
  }
  if (k.linkedin) {
    const norm = normalizeLinkedin(k.linkedin)
    if (norm)
      out.push({ kind: 'linkedin', value: k.linkedin.trim(), valueNorm: norm })
  }
  if (k.cin) {
    const norm = normalizeCin(k.cin)
    if (norm) out.push({ kind: 'cin', value: k.cin.trim(), valueNorm: norm })
  }
  return out
}

/** Follow a merge redirect. Chains are flattened at merge time → one hop. */
async function canonicalId(id: string): Promise<string> {
  const row = (
    await db
      .select({ mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)
  return row?.mergedIntoId ?? id
}

export async function resolveEntity(
  input: ResolveInput,
): Promise<ResolveResult> {
  const keys = normalizeKeys(input)
  const name = input.name?.trim()
  if (!name && keys.length === 0) {
    throw new Error('resolveEntity needs a name or at least one identity key')
  }

  // 1. Deterministic: exact identity-key match → attach.
  for (const key of keys) {
    const hit = (
      await db
        .select({ entityId: entityAlias.entityId })
        .from(entityAlias)
        .where(
          and(
            eq(entityAlias.kind, key.kind),
            eq(entityAlias.valueNorm, key.valueNorm),
            eq(entityAlias.isIdentity, true),
          ),
        )
        .limit(1)
    ).at(0)
    if (hit) {
      const id = await canonicalId(hit.entityId)
      // New name for a known entity is still signal — record as alias.
      if (name) await recordNameAlias(id, name, input.source)
      return { entityId: id, action: 'attached', matchedOn: key.kind }
    }
  }

  // 2. No identity match → create.
  const canonicalName = name ?? keys[0].valueNorm
  const created = await db.transaction(async (tx) => {
    const [ent] = await tx
      .insert(entity)
      .values({
        kind: input.kind,
        canonicalName,
        source: input.source,
        createdBy: input.createdBy,
      })
      .returning({ id: entity.id })

    for (const key of keys) {
      await tx.insert(entityAlias).values({
        entityId: ent.id,
        kind: key.kind,
        value: key.value,
        valueNorm: key.valueNorm,
        isIdentity: true,
        source: input.source,
      })
    }
    if (name) {
      await tx.insert(entityAlias).values({
        entityId: ent.id,
        kind: 'name',
        value: name,
        valueNorm: normalizeName(name),
        isIdentity: false,
        source: input.source,
      })
    }

    // Side-table row travels with the entity — attributes live there.
    if (input.kind === 'company') {
      await tx.insert(company).values({ entityId: ent.id })
    } else if (input.kind === 'person') {
      await tx.insert(person).values({ entityId: ent.id })
    }
    return ent
  })

  // 3. Probabilistic: fuzzy name sweep → suggestions only, never merges.
  if (name) {
    await sweepNameSimilarity(created.id, normalizeName(name)).catch((err) =>
      console.error('[resolve] fuzzy sweep failed', err),
    )
  }

  return { entityId: created.id, action: 'created' }
}

async function recordNameAlias(
  entityId: string,
  name: string,
  source: ResolveInput['source'],
) {
  const valueNorm = normalizeName(name)
  const existing = await db
    .select({ id: entityAlias.id })
    .from(entityAlias)
    .where(
      and(
        eq(entityAlias.entityId, entityId),
        eq(entityAlias.kind, 'name'),
        eq(entityAlias.valueNorm, valueNorm),
      ),
    )
    .limit(1)
  if (existing.length === 0) {
    await db.insert(entityAlias).values({
      entityId,
      kind: 'name',
      value: name,
      valueNorm,
      isIdentity: false,
      source,
    })
  }
}

/**
 * Add an identity alias to an existing entity. The unique index is the
 * dedupe tripwire: a collision means another entity already owns this key,
 * and that's a duplicate_candidate, not an error. Enrichment finds your
 * duplicates as a side effect.
 */
export async function addIdentityAlias(
  entityId: string,
  kind: 'domain' | 'email' | 'linkedin' | 'cin',
  rawValue: string,
  source: ResolveInput['source'],
): Promise<{ outcome: 'added' | 'already_own' | 'suggested_duplicate' }> {
  // Callers may hold a stale (merged-away) id — follow the redirect.
  entityId = await canonicalId(entityId)
  const norm = {
    domain: normalizeDomain,
    email: normalizeEmail,
    linkedin: normalizeLinkedin,
    cin: normalizeCin,
  }[kind](rawValue)
  if (!norm) throw new Error(`Invalid ${kind}: ${rawValue}`)

  const holder = (
    await db
      .select({ entityId: entityAlias.entityId })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, kind),
          eq(entityAlias.valueNorm, norm),
          eq(entityAlias.isIdentity, true),
        ),
      )
      .limit(1)
  ).at(0)

  if (holder) {
    const holderId = await canonicalId(holder.entityId)
    if (holderId === entityId) return { outcome: 'already_own' }
    await suggestDuplicate(entityId, holderId, 1.0, {
      shared: kind,
      value: norm,
    })
    return { outcome: 'suggested_duplicate' }
  }

  await db.insert(entityAlias).values({
    entityId,
    kind,
    value: rawValue.trim(),
    valueNorm: norm,
    isIdentity: true,
    source,
  })
  return { outcome: 'added' }
}

/** Ordered pair + upsert-ignore: dismissed stays dismissed forever. */
async function suggestDuplicate(
  a: string,
  b: string,
  score: number,
  reason: Record<string, unknown>,
) {
  const [entityA, entityB] = a < b ? [a, b] : [b, a]
  await db
    .insert(duplicateCandidate)
    .values({ entityA, entityB, score, reason })
    .onConflictDoNothing()
}

/**
 * pg_trgm sweep for one freshly-created entity. Same-kind entities whose
 * name aliases are similar above threshold become open suggestions.
 */
const SIMILARITY_THRESHOLD = 0.5

async function sweepNameSimilarity(entityId: string, nameNorm: string) {
  if (!nameNorm) return
  const matches = await db
    .selectDistinct({
      otherId: entityAlias.entityId,
      score: sql<number>`similarity(${entityAlias.valueNorm}, ${nameNorm})`,
    })
    .from(entityAlias)
    .innerJoin(entity, eq(entity.id, entityAlias.entityId))
    .where(
      and(
        eq(entityAlias.kind, 'name'),
        ne(entityAlias.entityId, entityId),
        sql`${entityAlias.valueNorm} % ${nameNorm}`,
        sql`similarity(${entityAlias.valueNorm}, ${nameNorm}) >= ${SIMILARITY_THRESHOLD}`,
        eq(entity.kind, sql`(select kind from entity where id = ${entityId})`),
      ),
    )
    .limit(10)

  for (const m of matches) {
    await suggestDuplicate(entityId, await canonicalId(m.otherId), m.score, {
      name_similarity: nameNorm,
    })
  }
}
