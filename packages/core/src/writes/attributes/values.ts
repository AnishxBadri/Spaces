import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  attributeEvent,
  entity,
  link,
  objectDef,
} from '@spaces/db/schema'
import type { attributeEventSource } from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema/entities'
import type { Json } from '@spaces/db/json'
import type { DomainEvent } from '@spaces/sdk'
import { resolveDefault } from '../../attributes/default-values'
import { objectIdForKindAsync } from './objects'
import {
  claimIdentityAlias,
  normalizeIdentityValue,
  recordNameAlias,
  releaseIdentityAlias,
} from '../entities/resolve'
import type { IdentityOutcome, ResolveSource } from '../entities/resolve'
import {
  attributeSource,
  deleteSourceChunks,
  isEmbeddableAttribute,
} from '../ai/chunk-sources'
import type { EmbedSource } from '../ai/chunk-sources'
import {
  coreKindOf,
  identityNorm,
  isNonIdentityValue,
  toObjectKind,
  valueValidator,
} from '../../attributes/registry'
import { isDerived } from '../../attributes/relationship'
import type {
  AttributeDef,
  CoreIdentityKey,
  ObjectKind,
} from '../../attributes/registry'
import {
  FIRST_NAME_SLUG,
  LAST_NAME_SLUG,
  isNamePart,
  joinName,
  splitName,
} from '../../attributes/person-name'

/**
 * The one write path for attribute values. Validates against the registry,
 * diffs, writes entity.values, records attribute_event rows, and syncs
 * record-reference link rows — all in one transaction.
 *
 * Effect-first per the backend-paradigm ratchet (converted in SPA-6, the
 * first behavioral change to the engine after the rule landed): planning is
 * a pure program with typed failures; the transaction applies the plan.
 * `setValues` is the Promise seam for server-fns and tests.
 */

/**
 * An object's live attributes, in order.
 * - The inverse half of a pair (`isDerived`) is left out unless asked for:
 *   `values` never holds it, so a reader that wrote back what it read would
 *   empty the relationship. `setValuesInTx` asks. (D69)
 */
export async function getRegistryByObjectId(
  objectId: string,
  opts: { derived?: true } = {},
): Promise<Array<AttributeDef>> {
  const rows = await db
    .select()
    .from(attribute)
    .where(and(eq(attribute.objectId, objectId), eq(attribute.archived, false)))
    .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
  return opts.derived ? rows : rows.filter((d) => !isDerived(d))
}

export async function getRegistry(
  kind: ObjectKind,
): Promise<Array<AttributeDef>> {
  return getRegistryByObjectId(await objectIdForKindAsync(kind))
}

/**
 * A rejected value. `message` is `slug: detail` so a toast reads well on
 * its own; the record rail strips the prefix when it renders inline.
 */
export class AttributeValidationError extends Schema.TaggedError<AttributeValidationError>()(
  'AttributeValidationError',
  { slug: Schema.String, message: Schema.String },
) {}

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()(
  'EntityNotFound',
  { entityId: Schema.String, message: Schema.String },
) {}

/**
 * A write to the derived half of a relationship whose owner is archived
 * (D69): archiving a half detaches the pair, so the derived half stores
 * nothing new. The refusal names the archived pair.
 */
export class PairedAttributeLocked extends Schema.TaggedError<PairedAttributeLocked>()(
  'PairedAttributeLocked',
  { slug: Schema.String, pair: Schema.String, message: Schema.String },
) {}

export class ValuesWriteFailed extends Schema.TaggedError<ValuesWriteFailed>()(
  'ValuesWriteFailed',
  { cause: Schema.Defect() },
) {}

const invalid = (slug: string, detail: string) =>
  new AttributeValidationError({ slug, message: `${slug}: ${detail}` })

/**
 * Who attended to a write (spec §4). `user` carries the user FK; `integration`
 * carries the `integration` row's id (SPA-70 — the table landed, so the
 * id-less member is gone and the column's biconditional check is what makes
 * its absence unrepresentable rather than merely discouraged); `system` is
 * the merge executor and seeds — rewrites no person asserted.
 */
export type Actor =
  | { type: 'user'; id: string }
  | { type: 'integration'; id: string }
  | { type: 'system' }

export type EventSource = (typeof attributeEventSource.enumValues)[number]

type Change = {
  slug: string
  def: AttributeDef
  before: Json
  value: Json
  /** set when the change came from a default rather than the patch */
  door?: 'default'
}

/**
 * Pure: registry + current values + patch → the changes to apply. Patch
 * semantics: keys present are set; null (or '' / undefined) clears; absent
 * keys are untouched; no-op diffs drop out.
 *
 * `required` means can't-clear, nothing more (spec §5, grilled 2026-09):
 * an explicit clear of a required attribute is rejected for every type. A
 * record may still be *born* without the value — creation completeness is
 * the create dialog's concern, and machine writes and imports legitimately
 * create partial records. Clearing an already-empty required field is a
 * no-op, not an error: there is nothing to clear.
 */
export const planPatch = Effect.fn('planPatch')(function* (
  registry: Array<AttributeDef>,
  current: EntityValues,
  patch: Record<string, unknown>,
): Effect.fn.Return<Array<Change>, AttributeValidationError> {
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  const changes: Array<Change> = []

  for (const [slug, raw] of Object.entries(patch)) {
    const def = bySlug.get(slug)
    if (!def) return yield* invalid(slug, 'Unknown attribute')

    let value: Json = null
    if (raw !== undefined && raw !== null && raw !== '') {
      if (
        def.type === 'record_reference' &&
        !def.options.multi &&
        Array.isArray(raw)
      )
        return yield* invalid(slug, holdsOne(def))
      const parsed = valueValidator(def, current[slug]).safeParse(raw)
      if (!parsed.success) {
        return yield* invalid(
          slug,
          parsed.error.issues[0]?.message ?? 'Invalid value',
        )
      }
      value = parsed.data
    }

    const before = current[slug] ?? null
    if (JSON.stringify(before) === JSON.stringify(value)) continue

    if (value === null && def.options.required) {
      return yield* invalid(slug, "Required — can't be cleared")
    }

    changes.push({ slug, def, before, value })
  }
  return changes
})

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The refusal of a list on a reference that holds one record. */
const holdsOne = (def: AttributeDef) =>
  def.options.cardinality === undefined
    ? 'Holds one record'
    : `Holds one record — the relationship is ${def.options.cardinality}`

/** Records of one object: its row, or a core kind's rows born without one. */
function ofObject(objectId: string, core: ObjectKind | null): SQL {
  const own = eq(entity.objectId, objectId)
  if (core === null) return own
  return or(own, and(isNull(entity.objectId), eq(entity.kind, core))) ?? own
}

/**
 * 1:1 on the owner (D69): a record may be held by one owner at a time. The
 * refusal names the record that already holds it.
 */
async function checkOneToOne(
  tx: Tx,
  entityId: string,
  members: SQL,
  change: Change,
) {
  const { def, slug, value } = change
  if (def.options.cardinality !== '1:1' || typeof value !== 'string') return
  // Serializes owners claiming one target: a second writer waits here, then
  // reads the first one's committed link. Released when the transaction ends.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${value}::text || ':' || ${slug}::text))`,
  )
  const holder = (
    await tx
      .select({ name: entity.canonicalName })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, value),
          eq(link.relation, 'references'),
          eq(link.attrSlug, slug),
          ne(link.fromEntityId, entityId),
          isNull(entity.mergedIntoId),
          members,
        ),
      )
      .limit(1)
  ).at(0)
  if (!holder) return
  const target = (
    await tx
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, value))
  ).at(0)
  throw invalid(
    slug,
    `${target?.name ?? 'That record'} is already held by ${holder.name}`,
  )
}

/** Referenced records must exist, be alive, and match the target kind. */
async function checkReferences(tx: Tx, change: Change) {
  const { def, slug, value } = change
  if (def.type !== 'record_reference' || value === null) return
  const ids = (Array.isArray(value) ? value : [value]).map(String)
  if (ids.length === 0) return
  const targets = await tx
    .select({
      id: entity.id,
      kind: entity.kind,
      objectId: entity.objectId,
      merged: entity.mergedIntoId,
    })
    .from(entity)
    .where(inArray(entity.id, ids))
  if (targets.length !== ids.length)
    throw invalid(slug, 'Referenced record not found')
  for (const t of targets) {
    // Targets stay single-object (§6): a core kind for the system objects,
    // an object row for custom ones — the picker just lists more objects.
    if (def.options.targetObjectId) {
      if (t.objectId !== def.options.targetObjectId)
        throw invalid(slug, 'Must reference a record of the target object')
    } else if (t.kind !== def.options.targetKind) {
      throw invalid(slug, `Must reference a ${def.options.targetKind}`)
    }
    if (t.merged) throw invalid(slug, 'Referenced record was merged')
  }
}

/**
 * The same provenance the `attribute_event` row carries, said in the pair
 * the alias columns want. Only `integration` is a different answer — a
 * plugin's alias names its own row, never whoever's session carried it —
 * and `import`/`merge`/`seed` are the three doors both enums spell the same
 * way. Everything else is a person at a keyboard: `manual`.
 */
const aliasSource = (actor: Actor, source: EventSource): ResolveSource =>
  actor.type === 'integration'
    ? { class: 'integration', ref: actor.id }
    : source === 'import' || source === 'merge' || source === 'seed'
      ? { class: source }
      : { class: 'manual' }

/** One identity-backed slug's before and after, as the mirror needs them. */
type IdentityWork = {
  slug: string
  key: CoreIdentityKey
  /** the claim standing before this write, if any */
  held: string | null
  /** the claim after it; null is the clear */
  value: string | null
}

const identityString = (v: Json): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

/**
 * Which identity keys this write touches (spec §9). Two sources, because a
 * no-op is still an answer: a slug the patch changed, and a slug the patch
 * named without changing — re-writing the domain you already own is
 * `already_own`, and that is the outcome objects-8 shows. Reconciling the
 * no-op is also what re-adds an alias that went missing, so the claim and
 * the field cannot drift apart silently.
 */
function planIdentity(
  registry: Array<AttributeDef>,
  current: EntityValues,
  patch: Record<string, unknown>,
  changes: Array<Change>,
): Array<IdentityWork> {
  const changed = new Map(changes.map((c) => [c.slug, c]))
  const work: Array<IdentityWork> = []
  for (const def of registry) {
    const key = def.options.identityKey
    // A multi-valued key is claimed element by element, before the write.
    if (!key || def.options.multi) continue
    const change = changed.get(def.slug)
    if (change) {
      work.push({
        slug: def.slug,
        key,
        held: identityString(change.before),
        value: identityString(change.value),
      })
    } else if (def.slug in patch) {
      const held = identityString(current[def.slug] ?? null)
      if (held !== null) work.push({ slug: def.slug, key, held, value: held })
    }
  }
  return work
}

const identityList = (v: Json): Array<string> =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []

/**
 * A multi-valued identity slug, claimed element by element before its value
 * is written (D75), so the stored array and the aliases cannot disagree.
 * - A removed element retires its alias; every remaining one is claimed.
 * - An element another record holds is refused: dropped from the value and
 *   raised as a `duplicate_candidate`; the rest of the patch still writes.
 * - A slug the patch named without changing it is reconciled the same way.
 * - A non-identity element (`isNonIdentityValue`) is stored and never
 *   claimed, so any number of records may hold it.
 */
async function claimIdentityElements(
  tx: Tx,
  entityId: string,
  registry: Array<AttributeDef>,
  current: EntityValues,
  patch: Record<string, unknown>,
  changes: Array<Change>,
  source: ResolveSource,
): Promise<{
  changes: Array<Change>
  claims: Record<string, Array<IdentityClaim>>
}> {
  const claims: Record<string, Array<IdentityClaim>> = {}
  let out = changes
  for (const def of registry) {
    const key = def.options.identityKey
    if (!key || !def.options.multi) continue
    const change = out.find((c) => c.slug === def.slug)
    if (!change && !(def.slug in patch)) continue
    const before = identityList(current[def.slug] ?? null)
    const after = change ? identityList(change.value) : before
    const afterNorms = new Set(after.map((v) => identityNorm(key, v)))

    const results: Array<IdentityClaim> = []
    for (const held of before) {
      const norm = identityNorm(key, held)
      if (norm === null || afterNorms.has(norm)) continue
      await releaseIdentityAlias(tx, entityId, key, held)
      results.push({ value: norm, outcome: 'released' })
    }
    const kept: Array<string> = []
    for (const value of after) {
      const norm = identityNorm(key, value)
      if (norm === null) {
        // A role address is kept as contact data and claims nothing.
        if (isNonIdentityValue(key, value)) kept.push(value)
        continue
      }
      const outcome = await claimIdentityAlias(tx, entityId, key, value, source)
      results.push({ value: norm, outcome })
      if (outcome !== 'suggested_duplicate') kept.push(value)
    }
    claims[def.slug] = results

    const held = current[def.slug] ?? null
    const value: Json = kept.length === 0 ? null : kept
    out = out.filter((c) => c.slug !== def.slug)
    if (JSON.stringify(held) !== JSON.stringify(value))
      out.push({ slug: def.slug, def, before: held, value })
  }
  return { changes: out, claims }
}

/** One outcome for a multi-valued slug: a refusal first, then what it did. */
function summarize(claims: Array<IdentityClaim>): IdentityClaim | null {
  for (const outcome of [
    'suggested_duplicate',
    'added',
    'already_own',
  ] as const) {
    const hit = claims.find((c) => c.outcome === outcome)
    if (hit) return hit
  }
  return claims.find((c) => c.outcome === 'released') ?? null
}

/**
 * Provenance rides the event row: `source` names the door the write came
 * through (default: a direct human edit), `suggestionId` and `refs` carry
 * the receipt when a suggestion or enrichment is accepted.
 */
export type SetValuesInput = {
  entityId: string
  patch: Record<string, unknown>
  actor: Actor
  source?: EventSource
  suggestionId?: string
  refs?: Array<string>
  /**
   * The import batch this write belongs to (SPA-169), stamped on every
   * event it writes — the supplied values and the defaults alike — so a
   * commit's receipts are findable by batch.
   */
  batchId?: string
  /**
   * Birth mode (spec §4): after the patch, fill every still-blank attribute
   * that carries a default, logged through the `default` door — inside the
   * same transaction and registry read as the supplied values.
   */
  fillDefaults?: { now: Date }
  /**
   * Fill-blanks mode (sdk-9, `Facts.fill`; spec-plugin-sdk §4, CONTEXT.md
   * "Enrichment" — never overwrite a manually-edited field). Decided here,
   * after the `FOR UPDATE` row lock, against the values the lock returned:
   * deciding "blank" before the transaction is the read-modify-write race
   * the lock exists to prevent. Per slug the patch changes:
   *
   * - blank (absent or null) → filled, unless a person cleared it: a
   *   blank whose latest `attribute_event` is a user's is user-held and
   *   skipped (`skipped`), neither written nor a conflict (D72);
   * - held, and the slug's latest `attribute_event` is this write's own
   *   actor (same type and id) recording the value still held → updated in
   *   place: machine-over-machine by the same integration is a fill;
   * - a relationship (`record_reference`) fills only when empty: any held
   *   value is refused, this actor's own included (D72);
   * - held by anyone else — a person, another integration, a merge, a
   *   value with no event at all → refused, written nowhere, and handed
   *   back in `conflicts`. Disagreement between providers is normal;
   *   last-write-wins would corrupt it.
   *
   * Validation still runs over the whole patch first, so a value the
   * registry refuses fails the write (`AttributeValidationError`) whether
   * or not its slug would have conflicted, and a required attribute's
   * empty value is the same refused clear it is for a person.
   */
  fillBlanks?: true
  /**
   * The provenance the identity aliases this write claims are stamped with.
   * Omitted, it follows the actor and the door (`aliasSource`); a record's
   * birth passes the source it was resolved from.
   */
  identitySource?: ResolveSource
  /**
   * A whole name for the record. On a person it splits into `first_name`
   * and `last_name` (`splitName`), overriding the patch's parts, unless it
   * is already their join; elsewhere it sets `canonical_name` as given.
   */
  name?: string
}

/** One element of a multi-valued identity slug, and what its claim did. */
export type IdentityClaim = { value: string; outcome: IdentityOutcome }

/** A value fill-blanks mode refused: someone else's value is already there. */
export type ValueConflict = {
  slug: string
  existing: Json
  proposed: Json
  /** A relationship: `proposed` is record ids, never a claim a card can hold as is. */
  reference: boolean
}

/**
 * `identity` is the per-slug outcome of the identity mirror, computed
 * inside the transaction that wrote the values — decided here, where the
 * claim was actually made, and nowhere else can reconstruct it afterwards.
 * `updateRecord` and `createObjectRecord` hand both maps to the client, and
 * `collisionToast` turns them into the one sentence a losing write owes the
 * operator (SPA-97 — "a conflict is never silent").
 *
 * `identityValues` is the same keys, carrying the *normalized* value each
 * slug asserted — what the unique index compared, so the toast names
 * `acme.com` rather than whatever the operator typed. A slug whose outcome
 * is `released` asserted nothing and has no entry.
 */
export type SetValuesResult = {
  changed: Array<string>
  defaulted: Array<string>
  identity: Record<string, IdentityOutcome>
  identityValues: Record<string, string>
  /**
   * A multi-valued identity slug's outcome per element, keyed by slug, each
   * element in its normal form. An element another record holds is
   * `suggested_duplicate`: it was refused — left out of the stored value —
   * and a `duplicate_candidate` raised, while the rest of the patch wrote.
   * `identity[slug]` is the summary: `suggested_duplicate` when any element
   * was refused.
   */
  identityClaims: Record<string, Array<IdentityClaim>>
  /**
   * The embeddable values this write set (SPA-132), to be chunked once it
   * has committed. The caller queues them — apps/web's `enqueueSourceEmbed`
   * — because the queue reads the environment and core may not
   * (SPA-174/175); a caller that owns the transaction owned that step
   * already. A clear is not here: its chunks were deleted inside the write.
   */
  reembed: Array<EmbedSource>
  /**
   * What fill-blanks mode refused (`SetValuesInput.fillBlanks`), in patch
   * order, each with the value held and the value proposed. Always empty
   * for a patch write.
   */
  conflicts: Array<ValueConflict>
  /** Blank slugs fill-blanks mode left alone because a person cleared them. */
  skipped: Array<string>
  /**
   * Records this write made a party of a deal — targets added to a deal's
   * `company` or `people` — for the caller to emit `deal.linked` once it
   * has committed.
   */
  dealParties: Array<DealParty>
  /**
   * A domain or email this write claimed for a company or person after its
   * birth, as the `identity.added` the caller dispatches once it has
   * committed. Never for a birth (`fillDefaults`), an import, a seed or a merge.
   */
  identityAdded: Array<IdentityAddedEvent>
}

export type IdentityAddedEvent = Extract<
  DomainEvent,
  { name: 'identity.added' }
>

/** The writes that add identity without the record gaining one. */
const SILENT_IDENTITY: ReadonlySet<EventSource> = new Set([
  'import',
  'seed',
  'merge',
])

/** A company or person that became a party of a deal. */
export type DealParty = {
  dealId: string
  entityId: string
  kind: 'company' | 'person'
}

/** The deal slugs whose targets are its parties, and the kind each holds. */
const DEAL_PARTY_SLUGS: ReadonlyMap<string, DealParty['kind']> = new Map([
  ['company', 'company'],
  ['people', 'person'],
])

const referenceIds = (v: Json): Array<string> =>
  v === null ? [] : (Array.isArray(v) ? v : [v]).map(String)

/**
 * Who wrote the value each held slug carries now: the latest
 * `attribute_event` per slug, read inside the caller's transaction after the
 * entity row lock — so a concurrent write to the same record has either
 * committed (and is read here) or is waiting on the lock.
 */
export async function lastWriters(
  tx: Tx,
  entityId: string,
  slugs: Array<string>,
) {
  if (slugs.length === 0) return new Map<string, LastWriter>()
  const rows = await tx
    .selectDistinctOn([attributeEvent.attrSlug], {
      slug: attributeEvent.attrSlug,
      to: attributeEvent.to,
      actorType: attributeEvent.actorType,
      actorId: attributeEvent.actorId,
      actorRef: attributeEvent.actorRef,
    })
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, entityId),
        inArray(attributeEvent.attrSlug, slugs),
      ),
    )
    .orderBy(attributeEvent.attrSlug, desc(attributeEvent.at))
  return new Map(rows.map((r) => [r.slug, r]))
}

export type LastWriter = {
  to: Json | null
  actorType: Actor['type']
  actorId: string | null
  actorRef: string | null
}

/** The held value is this actor's own: its latest event is ours and still true. */
const ownedBy = (actor: Actor, held: Json, last: LastWriter | undefined) => {
  if (last === undefined || last.actorType !== actor.type) return false
  if (JSON.stringify(last.to ?? null) !== JSON.stringify(held)) return false
  switch (actor.type) {
    case 'user':
      return last.actorId === actor.id
    case 'integration':
      return last.actorRef === actor.id
    case 'system':
      return true
  }
}

/**
 * The write itself, inside a transaction the caller owns. `setValuesEffect`
 * is the usual door and opens its own; a caller whose write must be atomic
 * with a row of its own passes its transaction here instead — accepting a
 * suggestion flips `status` and writes the value in one transaction, so two
 * concurrent accepts cannot both write (`apps/web/src/lib/ai/propose.ts`,
 * SPA-46). Refusals throw the typed errors (`AttributeValidationError`,
 * `EntityNotFound`), which roll the caller's transaction back.
 */
export async function setValuesInTx(
  tx: Tx,
  opts: SetValuesInput,
): Promise<SetValuesResult> {
  const {
    entityId,
    actor,
    source = 'direct',
    suggestionId,
    refs,
    batchId,
    fillDefaults,
    fillBlanks,
    identitySource,
    name,
  } = opts
  const claimSource = identitySource ?? aliasSource(actor, source)
  const actorId = actor.type === 'user' ? actor.id : null
  // The other half of the typed actor: set iff type = 'integration', which
  // the column's check constraint enforces rather than trusts.
  const actorRef = actor.type === 'integration' ? actor.id : null

  // FOR UPDATE: this is a read-modify-write of the whole values blob.
  // At READ COMMITTED, two partners editing different attributes of
  // the same record concurrently would both read the same starting
  // blob and the second commit would silently erase the first one's
  // key. The row lock serializes the merges instead.
  const ent = (
    await tx
      .select({
        id: entity.id,
        kind: entity.kind,
        objectId: entity.objectId,
        values: entity.values,
        canonicalName: entity.canonicalName,
      })
      .from(entity)
      .where(eq(entity.id, entityId))
      .for('update')
  ).at(0)
  if (!ent) throw new EntityNotFound({ entityId, message: 'Entity not found' })
  // objectId is the registry key; kind fallback covers rows created
  // outside the creation server-fns (tests, raw inserts) — core kinds
  // resolve to their system object row.
  let objectId = ent.objectId
  if (objectId === null) {
    const core = toObjectKind(ent.kind)
    if (core === null)
      throw new EntityNotFound({
        entityId,
        message: `No attribute registry for kind ${ent.kind}`,
      })
    objectId = await objectIdForKindAsync(core)
  }
  const registry = await getRegistryByObjectId(objectId, { derived: true })
  const current = ent.values
  const nameParts =
    ent.kind === 'person' && registry.some((d) => isNamePart(d.slug))
  const named = withNameParts(opts.patch, {
    nameParts,
    current,
    canonicalName: ent.canonicalName,
    name,
    birth: fillDefaults !== undefined,
  })
  // The inverse half of a pair stores nothing (D69): its slugs leave the
  // patch here and are written on their owners once this record's own write
  // is done, so a self-relationship's owner write reads this one's result.
  const inverse = await planInverse(tx, registry, named)
  const patch = Object.fromEntries(
    Object.entries(named).filter(
      ([slug]) => !inverse.some((w) => w.def.slug === slug),
    ),
  )

  // Planning is synchronous and pure; a typed failure surfaces as a
  // throw here and is passed through untouched by the catch below.
  const planned = Effect.runSync(planPatch(registry, current, patch))

  // Fill-blanks mode: split the plan into what may land and what someone
  // else already holds. Conflicted slugs leave the patch altogether — no
  // event, no identity reconcile, no default — as if never named.
  const conflicts: Array<ValueConflict> = []
  const skipped: Array<string> = []
  let changes = planned
  let effectivePatch = patch
  if (fillBlanks) {
    const writers = await lastWriters(
      tx,
      entityId,
      planned.map((c) => c.slug),
    )
    changes = []
    for (const c of planned) {
      const last = writers.get(c.slug)
      const reference = c.def.type === 'record_reference'
      if (c.before === null) {
        // A blank a person left blank — they cleared it — is theirs.
        if (last?.actorType === 'user') skipped.push(c.slug)
        else changes.push(c)
      } else if (!reference && ownedBy(actor, c.before, last)) {
        changes.push(c)
      } else {
        conflicts.push({
          slug: c.slug,
          existing: c.before,
          proposed: c.value,
          reference,
        })
      }
    }
    const refused = new Set([...conflicts.map((c) => c.slug), ...skipped])
    effectivePatch = Object.fromEntries(
      Object.entries(patch).filter(([slug]) => !refused.has(slug)),
    )
  }

  // Birth mode: defaults for whatever the patch left blank, planned
  // against the same registry snapshot and written through their own
  // door. Supplied values always win — a default never touches a slug
  // the patch named.
  if (fillDefaults) {
    const afterPatch = { ...current }
    for (const c of changes) {
      if (c.value === null) delete afterPatch[c.slug]
      else afterPatch[c.slug] = c.value
    }
    const userId = actor.type === 'user' ? actor.id : null
    const defaultPatch: Record<string, unknown> = {}
    for (const def of registry) {
      if (def.slug in effectivePatch || isDerived(def)) continue
      // Absent and null both mean "blank" — a default fills either.
      if ((afterPatch[def.slug] ?? null) !== null) continue
      const v = resolveDefault(def, { now: fillDefaults.now, userId })
      if (v !== undefined) defaultPatch[def.slug] = v
    }
    for (const c of Effect.runSync(
      planPatch(registry, afterPatch, defaultPatch),
    ))
      changes.push({ ...c, door: 'default' })
  }

  const elements = await claimIdentityElements(
    tx,
    entityId,
    registry,
    current,
    effectivePatch,
    changes,
    claimSource,
  )
  changes = elements.changes
  const identity: Record<string, IdentityOutcome> = {}
  const identityValues: Record<string, string> = {}
  for (const [slug, claims] of Object.entries(elements.claims)) {
    const summary = summarize(claims)
    if (summary === null) continue
    identity[slug] = summary.outcome
    if (summary.outcome !== 'released') identityValues[slug] = summary.value
  }

  const members = ofObject(objectId, toObjectKind(ent.kind))
  const next = { ...current }
  for (const change of changes) {
    await checkReferences(tx, change)
    await checkOneToOne(tx, entityId, members, change)
    const { slug, def, before, value } = change
    if (value === null) delete next[slug]
    else next[slug] = value

    const viaDefault = change.door === 'default'
    await tx.insert(attributeEvent).values({
      entityId,
      attrSlug: slug,
      from: before,
      to: value,
      actorType: actor.type,
      actorId,
      actorRef,
      source: viaDefault ? 'default' : source,
      suggestionId: viaDefault ? null : (suggestionId ?? null),
      refs: viaDefault ? null : (refs ?? null),
      batchId: batchId ?? null,
    })

    // Materialize record-references into the graph (values
    // authoritative).
    if (def.type === 'record_reference') {
      await tx
        .delete(link)
        .where(
          and(
            eq(link.fromEntityId, entityId),
            eq(link.relation, 'references'),
            eq(link.attrSlug, slug),
          ),
        )
      const ids: Array<string> =
        value === null
          ? []
          : (Array.isArray(value) ? value : [value]).map(String)
      for (const target of ids) {
        await tx
          .insert(link)
          .values({
            fromEntityId: entityId,
            toEntityId: target,
            relation: 'references',
            attrSlug: slug,
            source: 'manual',
            createdBy: actorId,
          })
          .onConflictDoNothing()
      }
    }
  }

  if (changes.length > 0) {
    await tx.update(entity).set({ values: next }).where(eq(entity.id, entityId))
  }

  // The name follows its parts on a person; elsewhere a given name is set.
  const renamed = nameParts
    ? changes.some((c) => isNamePart(c.slug))
      ? joinName(next[FIRST_NAME_SLUG], next[LAST_NAME_SLUG])
      : null
    : name !== undefined
      ? name.trim()
      : null
  if (renamed === '')
    throw invalid(FIRST_NAME_SLUG, 'A person needs a first or last name')
  if (renamed !== null && renamed !== ent.canonicalName) {
    await tx
      .update(entity)
      .set({ canonicalName: renamed })
      .where(eq(entity.id, entityId))
    // Names are history: the one left behind stays findable.
    await recordNameAlias(entityId, ent.canonicalName, claimSource, tx)
    await recordNameAlias(entityId, renamed, claimSource, tx)
  }

  // The declaration made flesh (spec §9): an attribute carrying
  // `options.identityKey` mirrors its value into `entity_alias` as an
  // identity alias, in this transaction, beside the `attribute_event`
  // that logged it. The value is the user's field and always lands;
  // only the *claim* is withheld from the loser of a race, which is a
  // `duplicate_candidate` and never an error. A change of value
  // retires the claim the old one made before asserting the new one,
  // and a clear retires it and asserts nothing — clearing the value
  // releases the claim (CONTEXT.md, 2026-09-19), so another record may
  // take the domain.
  for (const work of planIdentity(registry, current, effectivePatch, changes)) {
    if (work.held !== null && work.held !== work.value) {
      await releaseIdentityAlias(tx, entityId, work.key, work.held)
    }
    if (work.value === null) {
      identity[work.slug] = 'released'
      continue
    }
    identity[work.slug] = await claimIdentityAlias(
      tx,
      entityId,
      work.key,
      work.value,
      claimSource,
    )
    // The normal form the claim was actually compared in — the same
    // function the alias row was written through, so whoever reports
    // the collision reports what collided.
    const norm = normalizeIdentityValue(work.key, work.value)
    if (norm !== null) identityValues[work.slug] = norm
  }

  // Embeddable values (`EMBEDDABLE_ATTRIBUTES`; a deal's close_reason) are
  // chunked for the semantic lane. A clear deletes the chunks here, in the
  // transaction that cleared the value, so no search ever finds a reason
  // the record no longer gives; a set is handed back for the embed job,
  // which must not be queued before this commits — it reads the value.
  const reembed: Array<EmbedSource> = []
  for (const change of changes) {
    if (!isEmbeddableAttribute(ent.kind, change.slug)) continue
    const chunked = attributeSource(entityId, change.slug)
    if (change.value === null) await deleteSourceChunks(tx, chunked)
    else reembed.push(chunked)
  }

  // A deal's new parties: targets its `company` or `people` gained here.
  const dealParties: Array<DealParty> = []
  if (ent.kind === 'deal') {
    for (const change of changes) {
      const kind = DEAL_PARTY_SLUGS.get(change.slug)
      if (kind === undefined || change.def.type !== 'record_reference') continue
      const before = new Set(referenceIds(change.before))
      for (const id of referenceIds(change.value))
        if (!before.has(id))
          dealParties.push({ dealId: entityId, entityId: id, kind })
    }
  }

  // Identity a company or person gained: claimed here and new to it.
  const identityAdded: Array<IdentityAddedEvent> = []
  const ownKind =
    ent.kind === 'company' || ent.kind === 'person' ? ent.kind : null
  if (ownKind !== null && !fillDefaults && !SILENT_IDENTITY.has(source)) {
    const at = new Date().toISOString()
    for (const def of registry) {
      const key = def.options.identityKey
      if (key !== 'domain' && key !== 'email') continue
      for (const claim of elements.claims[def.slug] ?? [])
        if (claim.outcome === 'added')
          identityAdded.push({
            name: 'identity.added',
            entityId,
            kind: ownKind,
            key,
            value: claim.value,
            occurredAt: at,
          })
    }
  }

  const owners = await writeInverse(tx, entityId, inverse, opts)

  return {
    reembed: [...reembed, ...owners.reembed],
    skipped,
    dealParties: [...dealParties, ...owners.dealParties],
    identityAdded: [...identityAdded, ...owners.identityAdded],
    changed: [
      ...changes.filter((c) => c.door !== 'default').map((c) => c.slug),
      ...owners.changed,
    ],
    defaulted: changes.filter((c) => c.door === 'default').map((c) => c.slug),
    identity,
    identityValues,
    identityClaims: elements.claims,
    conflicts: [...conflicts, ...owners.conflicts],
  }
}

/** A write to the inverse half of a pair, and the owner it lands on. (D69) */
type InverseWrite = {
  def: AttributeDef
  owner: AttributeDef
  /** the owner's object, as a filter on `entity` */
  members: SQL
  /** the referencing records the patch asks for; null clears them all */
  value: Json
}

/**
 * The patch's slugs on derived attributes, validated as the inverse's own
 * shape (a 1:1 inverse holds one record) and joined to their owner.
 */
async function planInverse(
  tx: Tx,
  registry: Array<AttributeDef>,
  patch: Record<string, unknown>,
): Promise<Array<InverseWrite>> {
  const writes: Array<InverseWrite> = []
  for (const def of registry) {
    if (!isDerived(def) || !(def.slug in patch)) continue
    const raw = patch[def.slug]
    let value: Json = null
    if (raw !== undefined && raw !== null && raw !== '') {
      if (!def.options.multi && Array.isArray(raw))
        throw invalid(def.slug, holdsOne(def))
      const parsed = valueValidator(def).safeParse(raw)
      if (!parsed.success)
        throw invalid(
          def.slug,
          parsed.error.issues[0]?.message ?? 'Invalid value',
        )
      value = parsed.data
    }
    const pairId = def.options.inverseOf
    const owner =
      pairId === undefined
        ? undefined
        : (
            await tx.select().from(attribute).where(eq(attribute.id, pairId))
          ).at(0)
    if (!owner) throw invalid(def.slug, 'Its relationship has no owner')
    if (owner.archived)
      throw new PairedAttributeLocked({
        slug: def.slug,
        pair: owner.id,
        message: `${def.slug}: its pair ${owner.name} is archived — the relationship stores nothing new`,
      })
    const object = (
      await tx
        .select({ slug: objectDef.slug, isSystem: objectDef.isSystem })
        .from(objectDef)
        .where(eq(objectDef.id, owner.objectId))
    ).at(0)
    writes.push({
      def,
      owner,
      members: ofObject(owner.objectId, object ? coreKindOf(object) : null),
      value,
    })
  }
  return writes
}

type OwnerWrites = Pick<
  SetValuesResult,
  'changed' | 'conflicts' | 'reembed' | 'dealParties' | 'identityAdded'
>

/**
 * Each inverse write as `setValues` on the owners it changes: removals
 * first, so a 1:1 can move, then additions. One owner record changed is one
 * `attribute_event` and one `references` link; this record gains neither.
 */
async function writeInverse(
  tx: Tx,
  entityId: string,
  writes: Array<InverseWrite>,
  door: Pick<
    SetValuesInput,
    'actor' | 'source' | 'suggestionId' | 'refs' | 'batchId' | 'fillBlanks'
  >,
): Promise<OwnerWrites> {
  const out: OwnerWrites = {
    changed: [],
    conflicts: [],
    reembed: [],
    dealParties: [],
    identityAdded: [],
  }
  for (const w of writes) {
    const held = (
      await tx
        .selectDistinct({ id: entity.id })
        .from(link)
        .innerJoin(entity, eq(entity.id, link.fromEntityId))
        .where(
          and(
            eq(link.toEntityId, entityId),
            eq(link.relation, 'references'),
            eq(link.attrSlug, w.owner.slug),
            isNull(entity.mergedIntoId),
            w.members,
          ),
        )
        .orderBy(entity.id)
    ).map((r) => r.id)
    const want = [...new Set(referenceIds(w.value))]
    if (held.length === want.length && held.every((id) => want.includes(id)))
      continue
    const conflict = (existing: Json) =>
      out.conflicts.push({
        slug: w.def.slug,
        existing,
        proposed: w.value,
        reference: true,
      })
    // Fill-blanks: a relationship fills only when empty. (D72)
    if (door.fillBlanks && held.length > 0) {
      conflict(w.def.options.multi ? held : (held.at(0) ?? null))
      continue
    }
    await checkReferences(tx, {
      slug: w.def.slug,
      def: w.def,
      before: null,
      value: want,
    })

    const many = w.owner.options.multi === true
    const removals = held.filter((id) => !want.includes(id))
    const additions = want.filter((id) => !held.includes(id))
    // Every owner this write changes, locked before it is read: each owner
    // write is a read-modify-write.
    const current = new Map<string, Json>()
    for (const holder of [...removals, ...additions]) {
      const row = (
        await tx
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, holder))
          .for('update')
      ).at(0)
      current.set(holder, row?.values[w.owner.slug] ?? null)
    }
    // The inverse proved empty, so a fill is a plain addition — except on a
    // single-value owner that holds another record, which it would replace.
    // That refuses the whole write, naming the holders, before any step runs.
    if (door.fillBlanks && !many) {
      const taken = additions.flatMap((id) =>
        referenceIds(current.get(id) ?? null),
      )
      if (taken.length > 0) {
        conflict(taken)
        continue
      }
    }

    const steps: Array<{ holder: string; value: Json }> = [
      ...removals.map((holder) => {
        const kept = referenceIds(current.get(holder) ?? null).filter(
          (id) => id !== entityId,
        )
        return { holder, value: many && kept.length > 0 ? kept : null }
      }),
      ...additions.map((holder) => ({
        holder,
        value: many
          ? [...referenceIds(current.get(holder) ?? null), entityId]
          : entityId,
      })),
    ]
    // Removals first, so a 1:1 can move. A refusal throws and rolls back
    // every step with it: an inverse write lands whole or not at all.
    for (const { holder, value } of steps) {
      const result = await setValuesInTx(tx, {
        entityId: holder,
        patch: { [w.owner.slug]: value },
        actor: door.actor,
        ...(door.source === undefined ? {} : { source: door.source }),
        ...(door.suggestionId === undefined
          ? {}
          : { suggestionId: door.suggestionId }),
        ...(door.refs === undefined ? {} : { refs: door.refs }),
        ...(door.batchId === undefined ? {} : { batchId: door.batchId }),
      })
      out.reembed.push(...result.reembed)
      out.dealParties.push(...result.dealParties)
      out.identityAdded.push(...result.identityAdded)
    }
    out.changed.push(w.def.slug)
  }
  return out
}

export const setValuesEffect = Effect.fn('setValues')(function* (
  opts: SetValuesInput,
): Effect.fn.Return<
  SetValuesResult,
  | AttributeValidationError
  | EntityNotFound
  | PairedAttributeLocked
  | ValuesWriteFailed
> {
  const result = yield* Effect.tryPromise({
    try: () => db.transaction((tx) => setValuesInTx(tx, opts)),
    catch: (cause) =>
      cause instanceof AttributeValidationError ||
      cause instanceof EntityNotFound ||
      cause instanceof PairedAttributeLocked
        ? cause
        : new ValuesWriteFailed({ cause }),
  })
  // `result.reembed` is the caller's to queue once this returns, silently
  // (spec-ai-substrate §9: "automatic once enabled"). Until SPA-174/175 the
  // loop was here; it moved out with the enqueue, which core cannot hold.
  return result
})

/**
 * The patch with a person's name parts settled: a given `name` split into
 * them unless it is already their join, and a birth that names neither part
 * filling both from the name the record was born with.
 */
function withNameParts(
  patch: Record<string, unknown>,
  ctx: {
    nameParts: boolean
    current: EntityValues
    canonicalName: string
    name: string | undefined
    birth: boolean
  },
): Record<string, unknown> {
  if (!ctx.nameParts) return patch
  const held = joinName(
    ctx.current[FIRST_NAME_SLUG],
    ctx.current[LAST_NAME_SLUG],
  )
  let whole: string | null = null
  if (ctx.name !== undefined) {
    if (joinName(ctx.name, null) !== held) whole = ctx.name
  } else if (
    ctx.birth &&
    held === '' &&
    !(FIRST_NAME_SLUG in patch) &&
    !(LAST_NAME_SLUG in patch)
  ) {
    whole = ctx.canonicalName
  }
  if (whole === null) return patch
  const parts = splitName(whole)
  return {
    ...patch,
    [FIRST_NAME_SLUG]: parts.first,
    [LAST_NAME_SLUG]: parts.last,
  }
}

/** Promise seam for server-fns and tests; new Effect code composes `setValuesEffect`. */
export const setValues = (opts: SetValuesInput): Promise<SetValuesResult> =>
  Effect.runPromise(setValuesEffect(opts))
