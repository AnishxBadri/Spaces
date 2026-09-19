import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { company, entity, entityAlias, person } from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import type { Actor } from '../attributes/values'
import { canonicalId, suggestDuplicate, sweepNameSimilarity } from './sweep'
import {
  isRoleEmail,
  normalizeCin,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
} from '@spaces/core/entities/normalize'

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

export type EntityKindResolvable = 'company' | 'person'

/**
 * `db` or an open transaction — the two things a write helper can run on.
 * Narrowed to the verbs the helper uses so a transaction satisfies it
 * structurally, without a cast.
 */
export type Executor = Pick<typeof db, 'select' | 'insert'>

/**
 * Provenance as the pair the columns carry: a class, plus the integration
 * row when — and only when — the class is `integration`. The union is what
 * makes it a claim the compiler checked rather than one the caller asserted:
 * `{ class: 'integration' }` with no `ref` does not typecheck, which is the
 * same thing `entity_source_ref_invariant` says in Postgres, said earlier.
 *
 * This replaces `'manual' | 'gmail' | 'apollo' | 'import' | 'clip'`, a
 * vendor list that had also drifted off the enum it was writing into — it
 * omitted `seed`, which the seeds wrote straight through drizzle.
 */
export type ResolveSource =
  | { class: 'integration'; ref: string }
  | { class: Exclude<SourceClass, 'integration'>; ref?: undefined }

export type ResolveInput = {
  kind: EntityKindResolvable
  name?: string | undefined
  keys?:
    | {
        domain?: string | undefined
        email?: string | undefined
        linkedin?: string | undefined
        cin?: string | undefined
      }
    | undefined
  source: ResolveSource
  createdBy?: string | undefined
  /** attribute values asserted at birth — always win over defaults */
  values?: Record<string, unknown> | undefined
}

export type ResolveResult = {
  entityId: string
  action: 'attached' | 'created'
  /** Which key matched, when attached. */
  matchedOn?: 'domain' | 'email' | 'linkedin' | 'cin'
}

/**
 * The pair, shaped for the columns. One place builds it, so entity and
 * alias cannot disagree about who wrote a record — the alias is the row
 * that matters, since an unattributed identity alias is the one write that
 * can silently weld two companies together.
 */
function sourceColumns(source: ResolveSource): {
  sourceClass: SourceClass
  sourceRef: string | null
} {
  return { sourceClass: source.class, sourceRef: source.ref ?? null }
}

/**
 * Who the birth events name. The full mapping, all eight classes:
 *
 * | class                                        | actor                      |
 * | -------------------------------------------- | -------------------------- |
 * | `integration`                                | `{integration, id: ref}`   |
 * | `manual`                                     | the creator, else `system` |
 * | `ai` `import` `seed` `merge` `extracted` `inherited` | same            |
 *
 * Only `integration` is a different answer, which is the point of the
 * collapse: the other seven are "a person did this" or "the machine did
 * this", and `createdBy` already separates those two. An integration write
 * names its row even when a human's session carried it — a plugin cannot
 * launder its provenance through whoever clicked Sync — so the branch is
 * on the class first and `createdBy` second.
 */
function birthActor(
  source: ResolveSource,
  createdBy: string | undefined,
): Actor {
  if (source.class === 'integration') {
    return { type: 'integration', id: source.ref }
  }
  return createdBy ? { type: 'user', id: createdBy } : { type: 'system' }
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
  // Every resolvable kind is an object record now, so every one carries an
  // object row — the ghost kind that had none was deleted (clean-1).
  const objectId = await (
    await import('../attributes/objects')
  ).objectIdForKindAsync(input.kind)
  const created = await db.transaction(async (tx) => {
    const [ent] = await tx
      .insert(entity)
      .values({
        kind: input.kind,
        objectId,
        canonicalName,
        ...sourceColumns(input.source),
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
        ...sourceColumns(input.source),
      })
    }
    if (name) {
      await tx.insert(entityAlias).values({
        entityId: ent.id,
        kind: 'name',
        value: name,
        valueNorm: normalizeName(name),
        isIdentity: false,
        ...sourceColumns(input.source),
      })
    }

    // Side-table row travels with the entity — attributes live there.
    // The union is exactly company|person, so the else is the person case
    // and not a silent no-op for some third kind.
    if (input.kind === 'company') {
      await tx.insert(company).values({ entityId: ent.id })
    } else {
      await tx.insert(person).values({ entityId: ent.id })
    }
    return ent
  })

  // Birth values (spec §4): supplied first, then defaults for the blanks.
  // After the transaction, since setValues takes its own row lock.
  //
  // SPA-70 left this at `user`-or-`system`, because an integration actor
  // names an `integration` row and this call site had no way to be handed
  // one. The pair is that way: `{class:'integration', ref}` is exactly the
  // id the actor wants, so `birthActor` above can finally return it, and
  // the birth `attribute_event` rows carry `actor_ref` = the same row
  // `entity.source_ref` points at. The two provenance stories on a record
  // now come from one argument and cannot disagree.
  const { birthValues } = await import('../attributes/defaults')
  await birthValues({
    entityId: created.id,
    actor: birthActor(input.source, input.createdBy),
    supplied: input.values,
  })

  // 3. Probabilistic: fuzzy name sweep → suggestions only, never merges.
  if (name) {
    await sweepNameSimilarity(created.id, normalizeName(name)).catch((err) =>
      console.error('[resolve] fuzzy sweep failed', err),
    )
  }

  return { entityId: created.id, action: 'created' }
}

/**
 * Insert-if-absent for one `name` alias. Names are history: an earlier
 * alias is never replaced or deleted, so a record accumulates every label
 * it has worn and `searchEntities` keeps finding it by the old one.
 *
 * Three callers, one check — `resolveEntity` when a known entity arrives
 * under a new name, `renameRecordProgram` when a user renames a record
 * (SPA-63), and `createRecordProgram` for a custom record's birth alias
 * (SPA-60). Copying the check instead would be how the three drift.
 *
 * `on` is the executor: `db` by default, a transaction when the caller needs
 * the alias to land or fail with the row it names — which is exactly the
 * custom-record birth, where an entity without its name alias is a record
 * pg_trgm cannot see.
 */
export async function recordNameAlias(
  entityId: string,
  name: string,
  source: ResolveSource,
  on: Executor = db,
) {
  const valueNorm = normalizeName(name)
  const existing = await on
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
    await on.insert(entityAlias).values({
      entityId,
      kind: 'name',
      value: name,
      valueNorm,
      isIdentity: false,
      ...sourceColumns(source),
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
  source: ResolveSource,
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
    ...sourceColumns(source),
  })
  return { outcome: 'added' }
}
