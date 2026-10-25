import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, objectDef } from '@spaces/db/schema'
import { nextBadgeColor } from '../../attributes/colors'
import { coreKindOf, enrichmentLinkProblem } from '../../attributes/registry'
import { aiModeFits, buildAiConfig } from '../../ai/attribute-ai'
import { flipCardinality, holdsMany } from '../../attributes/relationship'
import {
  holdsList,
  widenCardinality,
  widenDefault,
  widenedType,
} from '../../attributes/widen'
import { wrapStoredValues } from './values'
import type { Actor } from './values'
import type { AiConfigInput } from '../../ai/attribute-ai'
import { validateDefault } from './defaults'
import type { BadgeColor } from '../../attributes/colors'
import type { Json } from '@spaces/db/json'
import type {
  AttributeOptions,
  AttributeType,
  ObjectKind,
  SelectOption,
} from '../../attributes/registry'

/**
 * Attribute maintenance. The config-mutability table is the contract.
 * - Slug and record_reference `targetKind` are not in the patch at all, so
 *   the illegal edit is unrepresentable rather than validated away.
 * - Type and `multi` change only through `multi`, which widens and never
 *   narrows.
 */

export class AttributeNotFound extends Schema.TaggedError<AttributeNotFound>()(
  'AttributeNotFound',
  { id: Schema.String, message: Schema.String },
) {}

/** A config edit that the attribute's type doesn't carry, or an option removal. */
export class AttributeConfigRejected extends Schema.TaggedError<AttributeConfigRejected>()(
  'AttributeConfigRejected',
  { message: Schema.String },
) {}

/** rating.max lowered below values already stored — the count is the message. */
export class RatingMaxBelowValues extends Schema.TaggedError<RatingMaxBelowValues>()(
  'RatingMaxBelowValues',
  { max: Schema.Number, count: Schema.Number, message: Schema.String },
) {}

/**
 * Archiving an attribute that backs one of its object's declared identity
 * keys. The key would be left pointing at nothing, so the refusal
 * names the object: undeclare the key, then archive.
 */
export class IdentityKeyAttributeLocked extends Schema.TaggedError<IdentityKeyAttributeLocked>()(
  'IdentityKeyAttributeLocked',
  { key: Schema.String, object: Schema.String, message: Schema.String },
) {}

/** System attributes ship with the product: never archived, never reshaped. */
export class SystemAttributeLocked extends Schema.TaggedError<SystemAttributeLocked>()(
  'SystemAttributeLocked',
  { attribute: Schema.String, message: Schema.String },
) {}

/** A multi-valued attribute asked to hold one value again. Edits widen only. */
export class AttributeNarrowingRefused extends Schema.TaggedError<AttributeNarrowingRefused>()(
  'AttributeNarrowingRefused',
  { attribute: Schema.String, message: Schema.String },
) {}

export class AttributeQueryFailed extends Schema.TaggedError<AttributeQueryFailed>()(
  'AttributeQueryFailed',
  { cause: Schema.Defect() },
) {}

export type OptionEdit = {
  /** absent id = new option (id derived from label) */
  id?: string | undefined
  label: string
  group?: SelectOption['group'] | undefined
  color?: BadgeColor | undefined
  /** true retires the option; false or absent restores it */
  archived?: boolean | undefined
}

/**
 * Per-type scalar config that survives values existing. Each key is gated
 * to its type inside the program; anything absent here (targetKind, multi,
 * required) is immutable by construction.
 */
export type AttributeConfigPatch = {
  /** currency — pure relabel, nothing converts */
  code?: string | undefined
  /** rating — raise freely; lowering is checked against stored values */
  max?: number | undefined
  /** number — display-only */
  precision?: number | undefined
  /**
   * Static value in the write shape, `'current-user'`, or an
   * ISO-8601 duration for dates; null clears. Validated here, at config
   * time, never at record creation.
   */
  default?: Json | undefined
  /**
   * AI attribute config, stored as `options.ai`; null clears. Any type that
   * can hold the mode may carry it; it rewrites no value and touches no other
   * key, so it sits outside every mutability guard rather than loosening one.
   */
  ai?: AiConfigInput | null | undefined
  /**
   * Fill from enrichment: a vocabulary key the attribute's type and
   * object can hold; null is "from nothing", which the seeder respects.
   */
  enrichmentKey?: string | null | undefined
}

export type UpdateAttributePatch = {
  id: string
  name?: string | undefined
  /** null clears */
  description?: string | null | undefined
  /** can't-clear; freely toggleable — it never rewrites data */
  required?: boolean | undefined
  /**
   * "Filter and sort on this": both engine flags, set together by
   * the one dialog control. Freely toggleable — it rewrites no data, it only
   * changes which `attr_idx_<id>` expression index `reconcileValueIndexes()`
   * wants to exist. The mint and the drop happen **after** this program's
   * writes commit, from the server fn, because `CREATE INDEX CONCURRENTLY`
   * cannot run inside a transaction.
   */
  indexed?: boolean | undefined
  archived?: boolean | undefined
  /**
   * true widens a single-valued attribute to a list: `select` becomes
   * `multi_select`, a reference, phone or email gains `multi`, and every
   * stored value is wrapped. false on a multi-valued one is refused.
   */
  multi?: boolean | undefined
  move?: 'up' | 'down' | undefined
  /** select/multi_select/status option list */
  options?: Array<OptionEdit> | undefined
  config?: AttributeConfigPatch | undefined
}

export type UpdateAttributeError =
  | AttributeNotFound
  | AttributeConfigRejected
  | IdentityKeyAttributeLocked
  | SystemAttributeLocked
  | AttributeNarrowingRefused
  | RatingMaxBelowValues
  | AttributeQueryFailed

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AttributeQueryFailed({ cause }),
  })

const slugify = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'option'

/**
 * Live records of one object whose stored rating exceeds `max`. Merged
 * losers are excluded: they're redirects carrying a snapshot, not records
 * anyone edits, and the validator never runs on them again.
 */
export const countRatingsAbove = Effect.fn('countRatingsAbove')(function* (
  objectId: string,
  slug: string,
  max: number,
): Effect.fn.Return<number, AttributeQueryFailed> {
  const row = yield* query(() =>
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(entity)
      .where(
        and(
          eq(entity.objectId, objectId),
          isNull(entity.mergedIntoId),
          sql`jsonb_typeof(${entity.values} -> ${slug}::text) = 'number'`,
          sql`(${entity.values} ->> ${slug}::text)::numeric > ${max}::numeric`,
        ),
      )
      .then((rows) => rows.at(0)),
  )
  return row?.count ?? 0
})

/**
 * Option-list edit: options can be added, renamed and archived but never
 * removed — stored values may reference them, and archiving leaves those
 * values untouched. Colours are pinned on save so the editor never
 * reshuffles what the user has been looking at.
 */
const mergeOptions = Effect.fn('mergeOptions')(function* (
  type: string,
  current: AttributeOptions,
  edits: Array<OptionEdit>,
): Effect.fn.Return<Array<SelectOption>, AttributeConfigRejected> {
  if (!['select', 'multi_select', 'status'].includes(type))
    return yield* new AttributeConfigRejected({
      message: 'This attribute type has no options',
    })
  const existingIds = new Set((current.options ?? []).map((o) => o.id))
  const keptIds = new Set(edits.flatMap((o) => (o.id ? [o.id] : [])))
  for (const id of existingIds) {
    if (!keptIds.has(id))
      return yield* new AttributeConfigRejected({
        message:
          'Options cannot be removed — records may hold that value. Archive it instead.',
      })
  }
  const seen = new Set<string>()
  return edits.map((o, i) => {
    let id = o.id
    if (!id) {
      id = slugify(o.label)
      while (seen.has(id) || existingIds.has(id)) id = `${id}_2`
    }
    seen.add(id)
    return {
      id,
      label: o.label,
      ...(o.group ? { group: o.group } : {}),
      color: o.color ?? nextBadgeColor(i, o.group),
      ...(o.archived ? { archived: true } : {}),
    }
  })
})

/** The mutability table, one branch per row. Returns the merged options blob. */
const applyConfig = Effect.fn('applyConfig')(function* (
  attr: { type: AttributeType; objectId: string; slug: string },
  current: AttributeOptions,
  patch: AttributeConfigPatch,
): Effect.fn.Return<
  AttributeOptions,
  AttributeConfigRejected | RatingMaxBelowValues | AttributeQueryFailed
> {
  let next = current
  const reject = (field: string) =>
    new AttributeConfigRejected({
      message: `${field} is not a setting of a ${attr.type} attribute`,
    })

  if (patch.code !== undefined) {
    // Relabel only — no conversion machinery exists anywhere; the UI warns.
    if (attr.type !== 'currency') return yield* reject('Currency code')
    next = { ...next, code: patch.code }
  }
  if (patch.max !== undefined) {
    if (attr.type !== 'rating') return yield* reject('Rating max')
    const currentMax = current.max ?? 5
    if (patch.max < currentMax) {
      const count = yield* countRatingsAbove(
        attr.objectId,
        attr.slug,
        patch.max,
      )
      if (count > 0)
        return yield* new RatingMaxBelowValues({
          max: patch.max,
          count,
          message: `${count} ${count === 1 ? 'record has a rating' : 'records have ratings'} above ${patch.max}`,
        })
    }
    next = { ...next, max: patch.max }
  }
  if (patch.precision !== undefined) {
    if (attr.type !== 'number') return yield* reject('Precision')
    next = { ...next, precision: patch.precision }
  }
  if (patch.default !== undefined) {
    if (patch.default === null) {
      next = { ...next }
      delete next.default
    } else {
      // Validated against the options as they'll be after this save, so a
      // default can't point at an option the same edit removed.
      const problem = validateDefault(
        { type: attr.type, options: next },
        patch.default,
      )
      if (problem)
        return yield* new AttributeConfigRejected({
          message: `Default: ${problem}`,
        })
      next = { ...next, default: patch.default }
    }
  }
  if (patch.ai !== undefined) {
    if (patch.ai === null) {
      next = { ...next }
      delete next.ai
    } else {
      const slugs = yield* query(() =>
        db
          .select({ slug: attribute.slug })
          .from(attribute)
          .where(eq(attribute.objectId, attr.objectId)),
      )
      const built = buildAiConfig(
        attr.type,
        patch.ai,
        slugs.map((s) => s.slug),
      )
      if (!built.ok)
        return yield* new AttributeConfigRejected({ message: built.message })
      next = { ...next, ai: built.config }
    }
  }
  if (patch.enrichmentKey !== undefined) {
    if (patch.enrichmentKey !== null) {
      const owner = yield* query(() =>
        db
          .select({ slug: objectDef.slug, isSystem: objectDef.isSystem })
          .from(objectDef)
          .where(eq(objectDef.id, attr.objectId))
          .then((rows) => rows.at(0)),
      )
      const problem = enrichmentLinkProblem(
        attr.type,
        owner === undefined ? null : coreKindOf(owner),
        patch.enrichmentKey,
        current.targetKind,
      )
      if (problem !== null)
        return yield* new AttributeConfigRejected({
          message: `Fill from: ${problem}`,
        })
    }
    next = { ...next, enrichmentKey: patch.enrichmentKey }
  }
  return next
})

/** What one widening writes, all of it in one transaction. */
type WidenPlan = {
  type: AttributeType
  options: AttributeOptions
  /** The other half of a relationship, with its cardinality read from its side. */
  pair: { id: string; options: AttributeOptions } | null
  /** The object's core kind, for its rows born without an object id. */
  core: ObjectKind | null
}

/**
 * Widen or refuse, before anything is written.
 * - `multi: false` on a list is refused naming the attribute; on a single
 *   value it is a no-op, as is `multi: true` on a list.
 * - A pair widens on the side asked: that side holds many and the other
 *   keeps its shape (a 1:1 owner becomes 1:N, its derived half N:1).
 */
const planWiden = Effect.fn('planWiden')(function* (
  attr: typeof attribute.$inferSelect,
  options: AttributeOptions,
  multi: boolean,
): Effect.fn.Return<
  WidenPlan | null,
  | AttributeNarrowingRefused
  | SystemAttributeLocked
  | AttributeConfigRejected
  | AttributeQueryFailed
> {
  const isList = holdsList({ type: attr.type, options })
  if (!multi) {
    if (!isList) return null
    return yield* new AttributeNarrowingRefused({
      attribute: attr.name,
      message: `${attr.name} holds a list and cannot narrow to one value`,
    })
  }
  if (isList) return null
  const type = widenedType(attr.type)
  if (type === null)
    return yield* new AttributeConfigRejected({
      message: `A ${attr.type} attribute holds one value; it has no list to widen to`,
    })
  if (attr.isSystem)
    return yield* new SystemAttributeLocked({
      attribute: attr.name,
      message: `${attr.name} ships with Spaces; its shape is fixed`,
    })
  if (options.ai !== undefined && !aiModeFits(options.ai.mode, type))
    return yield* new AttributeConfigRejected({
      message: `${attr.name} answers by AI as one value — clear its AI config before widening`,
    })
  const owner = yield* query(() =>
    db
      .select({ slug: objectDef.slug, isSystem: objectDef.isSystem })
      .from(objectDef)
      .where(eq(objectDef.id, attr.objectId))
      .then((rows) => rows.at(0)),
  )
  const core = owner === undefined ? null : coreKindOf(owner)
  if (typeof options.enrichmentKey === 'string') {
    const problem = enrichmentLinkProblem(
      type,
      core,
      options.enrichmentKey,
      options.targetKind,
    )
    if (problem !== null)
      return yield* new AttributeConfigRejected({
        message: `Fill from: ${problem} — unlink it before widening`,
      })
  }

  const next: AttributeOptions = {
    ...options,
    ...(type === attr.type ? { multi: true } : {}),
    ...(options.default === undefined
      ? {}
      : { default: widenDefault(options.default) }),
  }
  let pair: WidenPlan['pair'] = null
  if (options.inverseOf !== undefined && options.cardinality !== undefined) {
    const pairId = options.inverseOf
    const row = yield* query(() =>
      db
        .select({ id: attribute.id, name: attribute.name })
        .from(attribute)
        .where(eq(attribute.id, pairId))
        .then((rows) => rows.at(0)),
    )
    const widened = widenCardinality(options.cardinality)
    next.cardinality = widened
    if (row) {
      const flipped = flipCardinality(widened)
      pair = {
        id: row.id,
        options: { cardinality: flipped, multi: holdsMany(flipped) },
      }
    }
  }
  return { type, options: next, pair, core }
})

export const updateAttributeProgram = Effect.fn('updateAttributeProgram')(
  function* (
    patch: UpdateAttributePatch,
    /** who a widening's `attribute_event` names; the server fn passes the user */
    actor: Actor = { type: 'system' },
  ): Effect.fn.Return<{ ok: true }, UpdateAttributeError> {
    const attr = yield* query(() =>
      db
        .select()
        .from(attribute)
        .where(eq(attribute.id, patch.id))
        .then((rows) => rows.at(0)),
    )
    if (!attr)
      return yield* new AttributeNotFound({
        id: patch.id,
        message: 'Attribute not found',
      })
    // Refused before anything is written: a declared identity key with no
    // live attribute behind it is the state the materialization rule exists
    // to prevent.
    const identityKey = attr.options.identityKey
    if (patch.archived === true && identityKey !== undefined) {
      const owner = yield* query(() =>
        db
          .select({
            plural: objectDef.plural,
            identityKeys: objectDef.identityKeys,
            isSystem: objectDef.isSystem,
          })
          .from(objectDef)
          .where(eq(objectDef.id, attr.objectId))
          .then((rows) => rows.at(0)),
      )
      // A core object's identity attribute (a person's emails, a company's
      // domains) is what `resolveEntity` births records through.
      if (owner?.isSystem)
        return yield* new IdentityKeyAttributeLocked({
          key: identityKey,
          object: owner.plural,
          message: `${attr.name} is how ${owner.plural} are identified and cannot be archived`,
        })
      if (owner && owner.identityKeys.some((k) => k === identityKey))
        return yield* new IdentityKeyAttributeLocked({
          key: identityKey,
          object: owner.plural,
          message: `${attr.name} backs the ${identityKey} identity key of ${owner.plural} — drop the key from ${owner.plural} before archiving it`,
        })
    }
    if (patch.archived === true && attr.isSystem)
      return yield* new SystemAttributeLocked({
        attribute: attr.name,
        message: `${attr.name} ships with Spaces and cannot be archived`,
      })
    // Either half of a relationship may be archived; that detaches the pair,
    // and a write to a derived half whose owner is archived is refused by
    // `setValues` (`PairedAttributeLocked`).
    const current = attr.options

    let next = current
    if (patch.options)
      next = {
        ...next,
        options: yield* mergeOptions(attr.type, current, patch.options),
      }
    if (patch.config) next = yield* applyConfig(attr, next, patch.config)
    if (patch.required !== undefined && attr.type !== 'checkbox') {
      next = { ...next }
      if (patch.required) next.required = true
      else delete next.required
    }
    const widen =
      patch.multi === undefined
        ? null
        : yield* planWiden(attr, next, patch.multi)
    if (widen !== null) {
      // One transaction: the attribute's shape, its pair's, and every stored
      // value wrapped by one statement with one event on the attribute.
      const { pair, core } = widen
      const shape = (type: string, options: AttributeOptions) => ({
        type,
        multi: holdsList({ type, options }),
        ...(options.cardinality === undefined
          ? {}
          : { cardinality: options.cardinality }),
      })
      yield* query(() =>
        db.transaction(async (tx) => {
          // The pair first: a write on the derived side holds its own
          // registry, then the owner's, so this order cannot cross it.
          if (pair !== null)
            await tx
              .update(attribute)
              .set({
                options: sql`${attribute.options} || ${JSON.stringify(pair.options)}::jsonb`,
              })
              .where(eq(attribute.id, pair.id))
          await tx
            .update(attribute)
            .set({ type: widen.type, options: widen.options })
            .where(eq(attribute.id, attr.id))
          // A derived half stores nothing, so only its event is written.
          await wrapStoredValues(tx, {
            attributeId: attr.id,
            objectId: attr.objectId,
            core,
            slug: attr.slug,
            from: shape(attr.type, attr.options),
            to: shape(widen.type, widen.options),
            actor,
          })
        }),
      )
    } else if (next !== current)
      yield* query(() =>
        db
          .update(attribute)
          .set({ options: next })
          .where(eq(attribute.id, patch.id)),
      )

    if (patch.name)
      yield* query(() =>
        db
          .update(attribute)
          .set({ name: patch.name })
          .where(eq(attribute.id, patch.id)),
      )
    if (patch.description !== undefined)
      yield* query(() =>
        db
          .update(attribute)
          .set({ description: patch.description?.trim() || null })
          .where(eq(attribute.id, patch.id)),
      )
    if (patch.indexed !== undefined)
      yield* query(() =>
        db
          .update(attribute)
          .set({ filterable: patch.indexed, sortable: patch.indexed })
          .where(eq(attribute.id, patch.id)),
      )
    if (patch.archived !== undefined)
      yield* query(() =>
        db
          .update(attribute)
          .set({ archived: patch.archived })
          .where(eq(attribute.id, patch.id)),
      )
    if (patch.move) {
      const siblings = yield* query(() =>
        db
          .select({ id: attribute.id, sortOrder: attribute.sortOrder })
          .from(attribute)
          .where(eq(attribute.objectId, attr.objectId))
          .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
      )
      const idx = siblings.findIndex((s) => s.id === patch.id)
      const swapIdx = patch.move === 'up' ? idx - 1 : idx + 1
      const swapWith = swapIdx >= 0 ? siblings.at(swapIdx) : undefined
      if (swapWith)
        yield* query(async () => {
          await db
            .update(attribute)
            .set({ sortOrder: swapWith.sortOrder })
            .where(eq(attribute.id, patch.id))
          await db
            .update(attribute)
            .set({ sortOrder: attr.sortOrder })
            .where(eq(attribute.id, swapWith.id))
        })
    }
    return { ok: true }
  },
)

/**
 * Drag-to-reorder from the per-object attributes page: the full order of
 * one object's attributes, written as sort_order = position × 10 in one
 * transaction. Ids that don't belong to the object are ignored rather than
 * rejected — a stale page must not be able to reorder someone else's
 * registry. Table columns and record rails read sort_order, so the change
 * shows everywhere.
 */
export const reorderAttributesProgram = Effect.fn('reorderAttributesProgram')(
  function* (
    objectId: string,
    ids: Array<string>,
  ): Effect.fn.Return<{ ok: true }, AttributeQueryFailed> {
    const owned = new Set(
      (yield* query(() =>
        db
          .select({ id: attribute.id })
          .from(attribute)
          .where(eq(attribute.objectId, objectId)),
      )).map((r) => r.id),
    )
    const ordered = ids.filter((id) => owned.has(id))
    yield* query(() =>
      db.transaction(async (tx) => {
        for (const [i, id] of ordered.entries()) {
          await tx
            .update(attribute)
            .set({ sortOrder: (i + 1) * 10 })
            .where(eq(attribute.id, id))
        }
      }),
    )
    return { ok: true }
  },
)
