import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '#/db'
import { attribute, entity } from '#/db/schema'
import { nextBadgeColor } from './colors'
import { validateDefault } from './defaults'
import type { BadgeColor } from './colors'
import type { AttributeOptions, AttributeType, SelectOption } from './registry'

/**
 * Attribute maintenance as an Effect program (backend-paradigm ratchet: the
 * handler was opened for behavioral change, so its core converts here; the
 * server-fn stays a thin wrapper).
 *
 * The config-mutability table (spec-attribute-engine §3) is the contract.
 * Type and slug are not in the patch at all — there is no code path that
 * could change them. Same for record_reference `targetKind` / `multi`: the
 * `config` patch has no such fields, so the illegal edit is unrepresentable
 * rather than validated away.
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

export class AttributeQueryFailed extends Schema.TaggedError<AttributeQueryFailed>()(
  'AttributeQueryFailed',
  { cause: Schema.Defect() },
) {}

export type OptionEdit = {
  /** absent id = new option (id derived from label) */
  id?: string
  label: string
  group?: SelectOption['group']
  color?: BadgeColor
  /** true retires the option; false or absent restores it */
  archived?: boolean
}

/**
 * Per-type scalar config that survives values existing. Each key is gated
 * to its type inside the program; anything absent here (targetKind, multi,
 * required) is immutable by construction.
 */
export type AttributeConfigPatch = {
  /** currency — pure relabel, nothing converts */
  code?: string
  /** rating — raise freely; lowering is checked against stored values */
  max?: number
  /** number — display-only */
  precision?: number
  /**
   * spec §4 — static value in the write shape, `'current-user'`, or an
   * ISO-8601 duration for dates; null clears. Validated here, at config
   * time, never at record creation.
   */
  default?: unknown
}

export type UpdateAttributePatch = {
  id: string
  name?: string
  /** null clears */
  description?: string | null
  /** can't-clear (spec §5); freely toggleable — it never rewrites data */
  required?: boolean
  archived?: boolean
  move?: 'up' | 'down'
  /** select/multi_select/status option list */
  options?: Array<OptionEdit>
  config?: AttributeConfigPatch
}

export type UpdateAttributeError =
  | AttributeNotFound
  | AttributeConfigRejected
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
 * values untouched (spec §3). Colours are pinned on save so the editor never
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

/** The §3 table, one branch per row. Returns the merged options blob. */
const applyConfig = Effect.fn('applyConfig')(function* (
  attr: { type: string; objectId: string; slug: string },
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
        { type: attr.type as AttributeType, options: next },
        patch.default,
      )
      if (problem)
        return yield* new AttributeConfigRejected({
          message: `Default: ${problem}`,
        })
      next = { ...next, default: patch.default }
    }
  }
  return next
})

export const updateAttributeProgram = Effect.fn('updateAttributeProgram')(
  function* (
    patch: UpdateAttributePatch,
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
    const current = attr.options as AttributeOptions

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
    if (next !== current)
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
