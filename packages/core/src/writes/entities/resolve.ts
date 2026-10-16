import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  company,
  duplicateCandidate,
  entity,
  entityAlias,
  person,
} from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import { CORE_IDENTITY, storableIdentity } from '../../attributes/registry'
import type { CoreIdentityKey } from '../../attributes/registry'
import type { Actor, EventSource } from '../attributes/values'
import type { EmbedSource } from '../ai/chunk-sources'
import { entityCreated } from '../events/dispatch'
import type { DomainEvent } from '@spaces/sdk'
import {
  canonicalId,
  similarNames,
  suggestDuplicate,
  sweepNameSimilarity,
} from './sweep'
import {
  domainHost,
  isRoleEmail,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
  normalizeUrl,
} from '../../entities/normalize'

/**
 * THE choke point. Every creator of a person or a company — manual, deck,
 * mention, clip, Apollo, Gmail, import — goes through resolveEntity(). No
 * exceptions; bypassing it is how the database rots. (Scoped honestly since
 * SPA-167: `EntityKindResolvable` is those two kinds. A deal is born by
 * `createDeal`'s direct insert and a custom record by `createRecordProgram`,
 * neither through here — which is why the import plan names its creator per
 * row.)
 *
 * Doctrine: deterministic auto, probabilistic suggest.
 * - Exact identity-key match on a record of the kind asked for → attach: a
 *   company's domain, a person's email (`CORE_IDENTITY`, D75). A LinkedIn
 *   URL identifies neither; a birth keeps it as the `linkedin` value.
 * - No match → create, then fuzzy-sweep names into duplicate_candidate.
 * - Fuzzy NEVER merges or attaches.
 *
 * **One collision door** (SPA-86). A key already held by a record of
 * *another* kind — a custom Fund record that claimed `sequoia.com`, asked
 * for as a company — is not this record, so it is not an attach. The record
 * is created without that key and the claim goes through
 * `claimIdentityAlias`, which is what every identity write does on a
 * collision: a `duplicate_candidate` for the inbox, never an error and never
 * a second identity alias. The create path's race — a concurrent writer
 * committing the same key between the lookup and the insert — lands on the
 * same door, since the alias inserts run in `claimIdentityAlias`'s
 * savepoint. And the collision is recorded once: asked again for the same
 * key, the record that lost that claim before is the one returned
 * (`priorClaimant`), so an arrival lane re-reading a thread does not mint a
 * second loser each time.
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
        /** Never matched on; a birth keeps it as the `linkedin` value. */
        linkedin?: string | undefined
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
  matchedOn?: CoreIdentityKey
  /**
   * The embeddable values the birth set (SPA-132), for the caller to queue
   * once this has returned; empty on an attach. `setValuesEffect` used to
   * queue them itself; the enqueue reads the environment, which core may
   * not, so it is handed back (SPA-174/175).
   */
  reembed: Array<EmbedSource>
  /**
   * The `entity.created` this birth emits, for the caller to dispatch once
   * the birth has committed (`dispatchDomainEvent`). Null on an attach and
   * for a `seed` or `import` birth. (D65)
   */
  emit: DomainEvent | null
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

export type NormalizedKey = {
  kind: CoreIdentityKey
  value: string
  valueNorm: string
}

/**
 * The keys a resolve compares on — shared by `resolveEntity` and
 * `previewResolve`, so the preview matches on exactly what the write will.
 * Only the kind's own key counts (`CORE_IDENTITY`): a company's domain, a
 * person's email, with a role email dropped and a blank key skipped.
 */
export function normalizeKeys(
  input: Pick<ResolveInput, 'kind' | 'keys'>,
): Array<NormalizedKey> {
  const out: Array<NormalizedKey> = []
  const k = input.keys ?? {}
  const own = CORE_IDENTITY[input.kind].key
  if (k.domain && own === 'domain') {
    const norm = normalizeDomain(k.domain)
    // The alias a resolve writes shows the host it matches on — a sheet's
    // `https://www.Example.com/` is stored as `example.com` beside the
    // eTLD+1 in `value_norm` (SPA-173). Nothing compares on `value`.
    if (norm)
      out.push({
        kind: 'domain',
        value: domainHost(k.domain) ?? k.domain.trim(),
        valueNorm: norm,
      })
  }
  if (k.email && own === 'email') {
    const norm = normalizeEmail(k.email)
    // Role emails (info@, careers@…) never identify a person — anyone can
    // send from them, so matching on one would weld strangers together.
    if (norm && !(input.kind === 'person' && isRoleEmail(norm))) {
      out.push({ kind: 'email', value: k.email.trim(), valueNorm: norm })
    }
  }
  return out
}

/**
 * The values a birth writes: the caller's, with a LinkedIn key kept as the
 * `linkedin` attribute when the caller supplied none, it reads as a URL and
 * the kind's registry still carries a live `linkedin`.
 */
async function birthSupplied(
  input: Pick<ResolveInput, 'kind' | 'keys' | 'values'>,
): Promise<Record<string, unknown> | undefined> {
  const raw = input.keys?.linkedin
  const url = raw ? normalizeUrl(raw) : null
  if (url === null || input.values?.linkedin != null) return input.values
  // Imported here: values.ts imports this module.
  const { getRegistry } = await import('../attributes/values')
  const live = (await getRegistry(input.kind)).some(
    (d) => d.slug === 'linkedin' && d.type === 'url',
  )
  return live ? { ...input.values, linkedin: url } : input.values
}

/** The caller's values less the kind's identity slug, which the birth claims first. */
function withoutIdentity(
  kind: EntityKindResolvable,
  values: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (values === undefined) return undefined
  const { slug } = CORE_IDENTITY[kind]
  return Object.fromEntries(Object.entries(values).filter(([k]) => k !== slug))
}

/** The identity elements a birth claims: the keys first, then supplied values. */
function birthIdentity(
  input: Pick<ResolveInput, 'kind' | 'values'>,
  keys: Array<NormalizedKey>,
): Array<string> {
  const { key, slug } = CORE_IDENTITY[input.kind]
  const supplied = input.values?.[slug]
  const more = Array.isArray(supplied)
    ? supplied.filter((v): v is string => typeof v === 'string')
    : typeof supplied === 'string'
      ? [supplied]
      : []
  const out: Array<string> = []
  for (const raw of [
    ...keys.filter((k) => k.kind === key).map((k) => k.value),
    ...more,
  ]) {
    if (storableIdentity(input.kind, raw)) out.push(raw)
    else console.warn(`[resolve] ${key} ${raw} cannot be stored; not claimed`)
  }
  return out
}

/**
 * `resolveEntity`'s refusal, said once: a record with neither a name nor an
 * identity key is nothing a resolve can match or name. The preview reports
 * the same words for the row the write would refuse.
 */
export const RESOLVE_NEEDS_NAME_OR_KEY =
  'resolveEntity needs a name or at least one identity key'

/**
 * Step 1 and 1b, read-only: the live record of `kind` an identity key
 * already names, or null. Every key is tried in `normalizeKeys` order; a
 * key held by another kind of record falls through to the record that lost
 * that claim before (`priorClaimant`). Both `resolveEntity` and
 * `previewResolve` call this — one lookup, so the preview cannot say
 * *attach* where the write would create. The import's reference cells
 * (SPA-168, `lib/import/references.ts`) call it too, for a company or
 * person column holding a domain or an address; their name match is exact
 * and lives there, not here — this module gets no fuzzy attach path, since
 * a near-match that attaches is how a deal lands on the wrong company.
 */
export async function matchIdentity(
  kind: EntityKindResolvable,
  keys: Array<NormalizedKey>,
): Promise<{ entityId: string; key: NormalizedKey } | null> {
  // 1. Deterministic: exact identity-key match on this kind → attach.
  const heldElsewhere: Array<{ key: NormalizedKey; holderId: string }> = []
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
    if (!hit) continue
    const id = await canonicalId(hit.entityId)
    if ((await kindOf(id)) === kind) return { entityId: id, key }
    heldElsewhere.push({ key, holderId: id })
  }

  // 1b. A key another kind of record holds: the record that already lost
  // that claim, if there is one, is this record again.
  for (const { key, holderId } of heldElsewhere) {
    const prior = await priorClaimant(kind, key, holderId)
    if (prior !== null) return { entityId: prior, key }
  }
  return null
}

export type PreviewResolveInput = Pick<ResolveInput, 'kind' | 'name' | 'keys'>

export type PreviewResolveResult =
  | {
      verdict: 'attach'
      entityId: string
      matchedOn: { kind: CoreIdentityKey; value: string }
    }
  | { verdict: 'create' }
  | { verdict: 'refused'; reason: typeof RESOLVE_NEEDS_NAME_OR_KEY }

/**
 * **The read-only twin of step 1** (SPA-167). What `resolveEntity` would do
 * with this input, decided by the same `normalizeKeys`, the same identity
 * alias lookup and the same `canonicalId` redirect — and nothing written:
 * no name alias on an attach, no create (step 2), no fuzzy sweep (step 3).
 * `refused` is `resolveEntity`'s own throw, answered instead of thrown so a
 * batch of rows can report it and carry on.
 *
 * Two rows of one file claiming one key is not this function's business:
 * the second does not exist when the first resolves, so the importer
 * catches it (`@spaces/core/import/plan`).
 */
export async function previewResolve(
  input: PreviewResolveInput,
): Promise<PreviewResolveResult> {
  const keys = normalizeKeys(input)
  if (!input.name?.trim() && keys.length === 0)
    return { verdict: 'refused', reason: RESOLVE_NEEDS_NAME_OR_KEY }
  const match = await matchIdentity(input.kind, keys)
  if (!match) return { verdict: 'create' }
  return {
    verdict: 'attach',
    entityId: match.entityId,
    matchedOn: { kind: match.key.kind, value: match.key.valueNorm },
  }
}

/**
 * The name lane's cut: lower than the sweep's `SIMILARITY_THRESHOLD`
 * because nothing here writes — a candidate is shown to a person, never
 * merged or attached. One dropped letter in a short name ("Ohium" for
 * "Ohmium") scores 0.44.
 */
export const NAME_LANE_THRESHOLD = 0.4

export type NameCandidate = { entityId: string; name: string; score: number }

export type PreviewByNameResult =
  | {
      verdict: 'attach'
      entityId: string
      matchedOn: { kind: CoreIdentityKey | 'name'; value: string }
    }
  | { verdict: 'fuzzy'; candidates: Array<NameCandidate> }
  | { verdict: 'no_match' }
  | { verdict: 'refused'; reason: typeof RESOLVE_NEEDS_NAME_OR_KEY }

/**
 * **`previewResolve` with a name lane**: what a match-only caller (a bound
 * folder's name) may do with no identity key, and nothing written.
 * - An identity key match → `attach`, exactly as `previewResolve`.
 * - Else one live record of the kind holding the exact normalised name →
 *   `attach`; two or more → `fuzzy` with all of them, never a guess.
 * - Else names scoring `NAME_LANE_THRESHOLD` or more by the sweep's own
 *   similarity (`similarNames`) → `fuzzy`, best first; else `no_match`.
 */
export async function previewResolveByName(
  input: PreviewResolveInput,
): Promise<PreviewByNameResult> {
  const keyed = await previewResolve(input)
  if (keyed.verdict !== 'create') return keyed
  const nameNorm = normalizeName(input.name ?? '')
  if (nameNorm === '') return { verdict: 'no_match' }
  const { objectIdForKindAsync } = await import('../attributes/objects')
  const scope = eq(entity.objectId, await objectIdForKindAsync(input.kind))

  const exactRows = await db
    .selectDistinct({ id: entityAlias.entityId })
    .from(entityAlias)
    .innerJoin(entity, eq(entity.id, entityAlias.entityId))
    .where(
      and(
        eq(entityAlias.kind, 'name'),
        eq(entityAlias.valueNorm, nameNorm),
        scope,
      ),
    )
  const exact = [
    ...new Set(await Promise.all(exactRows.map((r) => canonicalId(r.id)))),
  ]
  const only = exact.length === 1 ? exact.at(0) : undefined
  if (only !== undefined)
    return {
      verdict: 'attach',
      entityId: only,
      matchedOn: { kind: 'name', value: nameNorm },
    }

  const scores = new Map<string, number>(exact.map((id) => [id, 1]))
  for (const row of await similarNames(nameNorm, scope, {
    excludeId: null,
    threshold: NAME_LANE_THRESHOLD,
  })) {
    const id = await canonicalId(row.otherId)
    scores.set(id, Math.max(scores.get(id) ?? 0, Number(row.score)))
  }
  if (scores.size === 0) return { verdict: 'no_match' }
  const names = await db
    .select({ id: entity.id, name: entity.canonicalName })
    .from(entity)
    .where(inArray(entity.id, [...scores.keys()]))
  const candidates = names
    .map((n) => ({
      entityId: n.id,
      name: n.name,
      score: scores.get(n.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { verdict: 'fuzzy', candidates }
}

export async function resolveEntity(
  input: ResolveInput,
): Promise<ResolveResult> {
  const keys = normalizeKeys(input)
  const name = input.name?.trim()
  if (!name && keys.length === 0) {
    throw new Error(RESOLVE_NEEDS_NAME_OR_KEY)
  }

  // 1. Deterministic: an identity key a record of this kind holds → attach.
  const match = await matchIdentity(input.kind, keys)
  if (match) {
    // New name for a known entity is still signal — record as alias.
    if (name) await recordNameAlias(match.entityId, name, input.source)
    return {
      entityId: match.entityId,
      action: 'attached',
      matchedOn: match.key.kind,
      reembed: [],
      emit: null,
    }
  }

  // 2. No identity match → create.
  const canonicalName = name ?? keys[0].valueNorm
  // Every resolvable kind is an object record now, so every one carries an
  // object row — the ghost kind that had none was deleted (clean-1).
  const objectId = await (
    await import('../attributes/objects')
  ).objectIdForKindAsync(input.kind)
  const created = await db.transaction((tx) =>
    insertResolved(tx, input, keys, name, canonicalName, objectId),
  )

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
  const { reembed } = await birthValues({
    entityId: created.id,
    actor: birthActor(input.source, input.createdBy),
    supplied: withoutIdentity(input.kind, await birthSupplied(input)),
  })

  // 3. Probabilistic: fuzzy name sweep → suggestions only, never merges.
  if (name) {
    await sweepNameSimilarity(created.id, normalizeName(name)).catch((err) =>
      console.error('[resolve] fuzzy sweep failed', err),
    )
  }

  return {
    entityId: created.id,
    action: 'created',
    reembed,
    emit: entityCreated(created.id, input.kind, input.source.class),
  }
}

/**
 * Step 2's writes, inside whichever transaction the caller opened: the
 * entity, the birth name alias, the side table row and the identity
 * attribute, each element a claim through the one write path. Shared by
 * `resolveEntity` and `resolveEntityInTx`, so the two cannot birth a record
 * differently.
 */
async function insertResolved(
  tx: Tx,
  input: ResolveInTxInput,
  keys: Array<NormalizedKey>,
  name: string | undefined,
  canonicalName: string,
  objectId: string,
): Promise<{ id: string }> {
  const ent = (
    await tx
      .insert(entity)
      .values({
        kind: input.kind,
        objectId,
        canonicalName,
        ...sourceColumns(input.source),
        createdBy: input.createdBy,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('Entity insert returned no row')

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

  // Every element is a claim, and one someone else holds — another kind of
  // record (1b found no prior loser), or a concurrent writer a moment ago —
  // is refused at that element as a duplicate_candidate, never an error.
  const identity = birthIdentity(input, keys)
  if (identity.length > 0) {
    // Imported here: values.ts imports this module.
    const { setValuesInTx } = await import('../attributes/values')
    await setValuesInTx(tx, {
      entityId: ent.id,
      patch: { [CORE_IDENTITY[input.kind].slug]: identity },
      actor: birthActor(input.source, input.createdBy),
      ...(input.valuesSource ? { source: input.valuesSource } : {}),
      ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
      identitySource: input.source,
    })
  }
  return ent
}

export type ResolveInTxInput = ResolveInput & {
  /** The door the birth values log through; `direct` when omitted. */
  valuesSource?: EventSource
  /** The import batch the write belongs to, stamped on every event. */
  batchId?: string
}

/**
 * `resolveEntity`'s result, plus the step that must wait for the caller's
 * commit: the name the fuzzy sweep runs on (null on an attach, or on a
 * record born from a key alone). The embeddable values ride in `reembed`,
 * which every resolve result carries.
 */
export type ResolveInTxResult = ResolveResult & {
  sweepName: string | null
}

/**
 * **`resolveEntity` inside a caller's transaction** (SPA-169). The import
 * commit writes each row in one transaction — its secondary creates, its own
 * record, its values — so a failure anywhere rolls back that row alone; a
 * resolve that opened its own would commit a record the row then failed to
 * finish. Same doctrine, same steps, same helpers: step 1 is the shared
 * `matchIdentity` (a read, which sees every committed row — earlier rows of
 * the batch included), step 2 is `insertResolved` plus the birth values in
 * this transaction, and step 3 — the fuzzy sweep, which inserts rows naming
 * the new record and so cannot run on another connection before it commits
 * — is handed back as `sweepName` for the caller to run after its commit
 * (`sweepNameSimilarity`).
 */
export async function resolveEntityInTx(
  tx: Tx,
  input: ResolveInTxInput,
): Promise<ResolveInTxResult> {
  const keys = normalizeKeys(input)
  const name = input.name?.trim()
  if (!name && keys.length === 0) {
    throw new Error(RESOLVE_NEEDS_NAME_OR_KEY)
  }
  const match = await matchIdentity(input.kind, keys)
  if (match) {
    if (name) await recordNameAlias(match.entityId, name, input.source, tx)
    return {
      entityId: match.entityId,
      action: 'attached',
      matchedOn: match.key.kind,
      sweepName: null,
      reembed: [],
      emit: null,
    }
  }
  const canonicalName = name ?? keys[0].valueNorm
  const { objectIdForKindAsync } = await import('../attributes/objects')
  const objectId = await objectIdForKindAsync(input.kind)
  const created = await insertResolved(
    tx,
    input,
    keys,
    name,
    canonicalName,
    objectId,
  )
  // Birth values in this transaction: supplied first, defaults for the
  // blanks, through the one write path — imported dynamically for the cycle
  // `resolveEntity` avoids the same way (values.ts imports this module).
  const { setValuesInTx } = await import('../attributes/values')
  const values = Object.fromEntries(
    Object.entries(
      withoutIdentity(input.kind, await birthSupplied(input)) ?? {},
    ).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  )
  const { reembed } = await setValuesInTx(tx, {
    entityId: created.id,
    patch: values,
    actor: birthActor(input.source, input.createdBy),
    ...(input.valuesSource ? { source: input.valuesSource } : {}),
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    fillDefaults: { now: new Date() },
  })
  return {
    entityId: created.id,
    action: 'created',
    sweepName: name ? normalizeName(name) : null,
    reembed,
    emit: entityCreated(created.id, input.kind, input.source.class),
  }
}

/** The kind of a record, by id; null when there is no such row. */
async function kindOf(id: string): Promise<string | null> {
  const row = (
    await db
      .select({ kind: entity.kind })
      .from(entity)
      .where(eq(entity.id, id))
      .limit(1)
  ).at(0)
  return row?.kind ?? null
}

/**
 * The record of `kind` that already lost the claim to `key` against
 * `holderId` — the other side of the `duplicate_candidate` that collision
 * minted, whatever its status (a dismissed pair still says which record is
 * which), unless it has since been merged away. Null when the collision is
 * new.
 */
async function priorClaimant(
  kind: EntityKindResolvable,
  key: NormalizedKey,
  holderId: string,
): Promise<string | null> {
  const pairs = await db
    .select({ a: duplicateCandidate.entityA, b: duplicateCandidate.entityB })
    .from(duplicateCandidate)
    .where(
      and(
        or(
          eq(duplicateCandidate.entityA, holderId),
          eq(duplicateCandidate.entityB, holderId),
        ),
        sql`${duplicateCandidate.reason} ->> 'shared' = ${key.kind}`,
        sql`${duplicateCandidate.reason} ->> 'value' = ${key.valueNorm}`,
      ),
    )
  const others = pairs.map((p) => (p.a === holderId ? p.b : p.a))
  if (others.length === 0) return null
  const row = (
    await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          inArray(entity.id, others),
          eq(entity.kind, kind),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.createdAt))
      .limit(1)
  ).at(0)
  return row?.id ?? null
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
const IDENTITY_NORMALIZERS: Record<
  CoreIdentityKey,
  (raw: string) => string | null
> = {
  domain: normalizeDomain,
  email: normalizeEmail,
  linkedin: normalizeLinkedin,
}

export type AliasIdentityKind = keyof typeof IDENTITY_NORMALIZERS

/**
 * The normal form a claim is actually stored and compared in. Exported so a
 * caller that must *say* what collided says the same thing the unique index
 * did — the toast on a losing write names `acme.com`, not the
 * `https://Acme.com/` the operator typed. Empty string (the normalizers'
 * "nothing here") answers null.
 */
export function normalizeIdentityValue(
  kind: AliasIdentityKind,
  rawValue: string,
): string | null {
  return IDENTITY_NORMALIZERS[kind](rawValue) || null
}

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
 * and that's a duplicate_candidate, not an error.
 * - Module-private: the one door is `claimIdentityAlias`, which `setValues`
 *   calls, so an identity alias never exists without the value it mirrors.
 */
async function addIdentityAlias(
  entityId: string,
  kind: AliasIdentityKind,
  rawValue: string,
  source: ResolveSource,
  on: Executor,
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
