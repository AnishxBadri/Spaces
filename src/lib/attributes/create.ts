import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '#/db'
import { attribute } from '#/db/schema'
import { nextBadgeColor } from './colors'
import { validateDefault } from './defaults'
import { objectIdForKind } from './objects'
import { deriveOptionIds } from './options'
import { AttributeQueryFailed } from './update'
import type { ObjectQueryFailed, SystemObjectNotSeeded } from './objects'
import type { BadgeColor } from './colors'
import type {
  AttributeOptions,
  AttributeType,
  ObjectKind,
  SelectOption,
} from './registry'

/**
 * Attribute creation as an Effect program (spec §7 dialog, §3 lifecycle).
 * The slug is derived here and never editable; type and record-reference
 * target are fixed at this moment for good. Everything the dialog can set
 * — options, per-type config, a default, required, description — lands in
 * one insert, validated the same way the update path validates it.
 */

export class AttributeCreateRejected extends Schema.TaggedError<AttributeCreateRejected>()(
  'AttributeCreateRejected',
  { message: Schema.String },
) {}

export type CreateAttributeInput = {
  /** the object row, directly — the only key custom objects have */
  objectId?: string
  /** or a core kind, resolved to its system object row */
  objectKind?: ObjectKind
  name: string
  type: AttributeType
  description?: string | null
  /** select / multi_select / status — ids derived from labels */
  options?: ReadonlyArray<{
    label: string
    group?: SelectOption['group']
    color?: BadgeColor
  }>
  config?: {
    code?: string
    max?: number
    precision?: number
    targetKind?: ObjectKind
    targetObjectId?: string
    multi?: boolean
  }
  default?: unknown
  required?: boolean
  createdBy: string
}

const OPTION_TYPES = new Set<AttributeType>([
  'select',
  'multi_select',
  'status',
])

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AttributeQueryFailed({ cause }),
  })

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'attribute'

/** Per-type options blob from the dialog's config; rejects config the type can't carry. */
const buildOptions = Effect.fn('buildOptions')(function* (
  input: CreateAttributeInput,
): Effect.fn.Return<AttributeOptions, AttributeCreateRejected> {
  const reject = (message: string) => new AttributeCreateRejected({ message })
  const cfg = input.config ?? {}
  const out: AttributeOptions = {}

  if (OPTION_TYPES.has(input.type)) {
    const labels = (input.options ?? [])
      .map((o) => ({ ...o, label: o.label.trim() }))
      .filter((o) => o.label.length > 0)
    if (labels.length === 0) return yield* reject('Give at least one option')
    const ids = deriveOptionIds(labels.map((o) => o.label))
    out.options = labels.map((o, i) => ({
      id: ids[i],
      label: o.label,
      ...(input.type === 'status' ? { group: o.group ?? 'active' } : {}),
      color:
        o.color ??
        nextBadgeColor(
          i,
          input.type === 'status' ? (o.group ?? 'active') : undefined,
        ),
    }))
  } else if (input.options && input.options.length > 0) {
    return yield* reject('This attribute type has no options')
  }

  if (cfg.code !== undefined) {
    if (input.type !== 'currency')
      return yield* reject('Currency code is not a setting of this type')
    out.code = cfg.code
  } else if (input.type === 'currency') out.code = 'USD'

  if (cfg.max !== undefined) {
    if (input.type !== 'rating')
      return yield* reject('Rating max is not a setting of this type')
    out.max = cfg.max
  } else if (input.type === 'rating') out.max = 5

  if (cfg.precision !== undefined) {
    if (input.type !== 'number')
      return yield* reject('Precision is not a setting of this type')
    out.precision = cfg.precision
  }

  if (input.type === 'record_reference') {
    if (!cfg.targetKind && !cfg.targetObjectId)
      return yield* reject('Pick what the relationship points at')
    if (cfg.targetKind) out.targetKind = cfg.targetKind
    else out.targetObjectId = cfg.targetObjectId
    out.multi = cfg.multi ?? false
  } else if (
    cfg.targetKind !== undefined ||
    cfg.targetObjectId !== undefined ||
    cfg.multi !== undefined
  ) {
    return yield* reject('Relationship settings are not settings of this type')
  }

  // Required means can't-clear (spec §5); unchecked is a value for a
  // checkbox, so the flag is meaningless there and never stored.
  if (input.required && input.type !== 'checkbox') out.required = true

  if (input.default !== undefined && input.default !== null) {
    const problem = validateDefault(
      { type: input.type, options: out },
      input.default,
    )
    if (problem) return yield* reject(`Default: ${problem}`)
    out.default = input.default
  }
  return out
})

export const createAttributeProgram = Effect.fn('createAttributeProgram')(
  function* (
    input: CreateAttributeInput,
  ): Effect.fn.Return<
    { id: string; slug: string },
    | AttributeCreateRejected
    | AttributeQueryFailed
    | ObjectQueryFailed
    | SystemObjectNotSeeded
  > {
    const name = input.name.trim()
    if (!name)
      return yield* new AttributeCreateRejected({
        message: 'Name the attribute',
      })
    const objectId =
      input.objectId ??
      (input.objectKind
        ? yield* objectIdForKind(input.objectKind)
        : yield* new AttributeCreateRejected({
            message: 'Pick the object this attribute belongs to',
          }))
    const options = yield* buildOptions(input)

    // Slug: derived once, suffixed on collision within the object, then
    // immutable forever (spec §3 — Attio's mutable slug is the footgun).
    const base = slugify(name)
    let slug = base
    for (let i = 2; ; i++) {
      const taken = yield* query(() =>
        db
          .select({ id: attribute.id })
          .from(attribute)
          .where(
            and(eq(attribute.objectId, objectId), eq(attribute.slug, slug)),
          )
          .then((rows) => rows.length > 0),
      )
      if (!taken) break
      slug = `${base}_${i}`
    }

    const maxOrder = yield* query(() =>
      db
        .select({
          maxOrder: sql<number>`coalesce(max(${attribute.sortOrder}), 0)`,
        })
        .from(attribute)
        .where(eq(attribute.objectId, objectId))
        .then((rows) => rows[0]?.maxOrder ?? 0),
    )

    const row = yield* query(() =>
      db
        .insert(attribute)
        .values({
          objectId,
          slug,
          name,
          description: input.description?.trim() || null,
          type: input.type,
          options,
          isSystem: false,
          sortOrder: maxOrder + 10,
          createdBy: input.createdBy,
        })
        .returning({ id: attribute.id, slug: attribute.slug })
        .then((rows) => rows[0]),
    )
    return row
  },
)
