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
 * An open transaction, whole. Wider than `Executor` because the two
 * identity helpers below need verbs an insert-only alias write does not:
 * `transaction` to open a savepoint, `delete` to retire a claim.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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

/** The alias kinds that carry `is_identity`, and their one normalizer each. */
const IDENTITY_NORMALIZERS = {
  domain: normalizeDomain,
  email: normalizeEmail,
  linkedin: normalizeLinkedin,
  cin: normalizeCin,
}

export type AliasIdentityKind = keyof typeof IDENTITY_NORMALIZERS

/**
 * What one identity-backed slug did on a write (spec §9). `released` is the
 * clear: the record stops asserting the key, so the alias is retired and the
 * domain is free for another record to claim (CONTEXT.md, 2026-09-19 —
 * name aliases are history and never retire, identity aliases are claims and
 * do).
 */
export type IdentityOutcome =
  'added' | 'already_own' | 'suggested_duplicate' | 'released'

/**
 * Add an identity alias to an existing entity. The unique index is the
 * dedupe tripwire: a collision means another entity already owns this key,
 * and that's a duplicate_candidate, not an error. Enrichment finds your
 * duplicates as a side effect.
 *
 * `on` is the executor, the same fourth-parameter shape `recordNameAlias`
 * carries: `db` by default, a transaction (or a savepoint inside one) when
 * the caller needs the alias to land or fail with the write it belongs to —
 * which is exactly the attribute write path, where the value and the claim
 * it makes are one transaction (`claimIdentityAlias` below).
 */
export async function addIdentityAlias(
  entityId: string,
  kind: AliasIdentityKind,
  rawValue: string,
  source: ResolveSource,
  on: Executor = db,
): Promise<{ outcome: 'added' | 'already_own' | 'suggested_duplicate' }> {
  // Callers may hold a stale (merged-away) id — follow the redirect.
  entityId = await canonicalId(entityId, on)
  const norm = IDENTITY_NORMALIZERS[kind](rawValue)
  if (!norm) throw new Error(`Invalid ${kind}: ${rawValue}`)

  const holder = (
    await on
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
    const holderId = await canonicalId(holder.entityId, on)
    if (holderId === entityId) return { outcome: 'already_own' }
    await suggestDuplicate(
      entityId,
      holderId,
      1.0,
      { shared: kind, value: norm },
      on,
    )
    return { outcome: 'suggested_duplicate' }
  }

  await on.insert(entityAlias).values({
    entityId,
    kind,
    value: rawValue.trim(),
    valueNorm: norm,
    isIdentity: true,
    ...sourceColumns(source),
  })
  return { outcome: 'added' }
}

/**
 * A `23505` anywhere in the cause chain. drizzle wraps a driver error, so
 * the pg code is not always on the thing that was thrown; the chain is
 * walked rather than the top frame inspected.
 */
function isUniqueViolation(cause: unknown): boolean {
  let e: unknown = cause
  for (let depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    if (typeof e !== 'object') return false
    if ('code' in e && e.code === '23505') return true
    e = 'cause' in e ? e.cause : null
  }
  return false
}

/**
 * Claim an identity key from inside a caller's transaction, without letting
 * a losing race take the transaction down with it.
 *
 * `addIdentityAlias` checks for a holder first, which settles the ordinary
 * case; the race it cannot settle is a concurrent writer that commits its
 * alias between that check and this insert. Postgres answers that with
 * `23505`, and a `23505` poisons the transaction it was raised in — the
 * value write, its `attribute_event`, everything. So the alias work runs in
 * a **savepoint**: the violation rolls back the nested transaction alone,
 * the outer one is still live, and the loser of the race gets what the
 * doctrine says it gets — a `duplicate_candidate`, not an error. The
 * savepoint holds nothing but the alias work, so a `23505` inside it can
 * only be `alias_identity_unique` (the candidate insert is
 * `onConflictDoNothing`).
 */
export async function claimIdentityAlias(
  tx: Tx,
  entityId: string,
  kind: AliasIdentityKind,
  rawValue: string,
  source: ResolveSource,
): Promise<'added' | 'already_own' | 'suggested_duplicate'> {
  try {
    const { outcome } = await tx.transaction((sp) =>
      addIdentityAlias(entityId, kind, rawValue, source, sp),
    )
    return outcome
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause
    // The savepoint is gone; the outer transaction reads again and finds the
    // winner, which is committed by now or the insert would still be waiting
    // on its lock.
    const norm = IDENTITY_NORMALIZERS[kind](rawValue)
    if (!norm) throw cause
    const holder = (
      await tx
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
    if (!holder) throw cause
    const holderId = await canonicalId(holder.entityId, tx)
    const mine = await canonicalId(entityId, tx)
    if (holderId === mine) return 'already_own'
    await suggestDuplicate(
      mine,
      holderId,
      1.0,
      { shared: kind, value: norm },
      tx,
    )
    return 'suggested_duplicate'
  }
}

/**
 * Retire the claim a record made with one identity key. Scoped to the
 * normalized value the record held, so a record that lost the race — and
 * therefore owns no alias — cannot delete the winner's row on its way out.
 * Returns whether a claim was actually standing.
 */
export async function releaseIdentityAlias(
  tx: Tx,
  entityId: string,
  kind: AliasIdentityKind,
  heldValue: string,
): Promise<boolean> {
  const norm = IDENTITY_NORMALIZERS[kind](heldValue)
  if (!norm) return false
  const gone = await tx
    .delete(entityAlias)
    .where(
      and(
        eq(entityAlias.entityId, await canonicalId(entityId, tx)),
        eq(entityAlias.kind, kind),
        eq(entityAlias.valueNorm, norm),
        eq(entityAlias.isIdentity, true),
      ),
    )
    .returning({ id: entityAlias.id })
  return gone.length > 0
}
