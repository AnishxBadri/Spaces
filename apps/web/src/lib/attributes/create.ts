import { Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute } from '@spaces/db/schema'
import { nextBadgeColor } from '@spaces/core/attributes/colors'
import { validateDefault } from './defaults'
import { objectIdForKind } from './objects'
import { deriveOptionIds } from '@spaces/core/attributes/options'
import { IDENTITY_KEY_ATTRIBUTES } from '@spaces/core/attributes/registry'
import { AttributeQueryFailed } from './update'
import type { ObjectQueryFailed, SystemObjectNotSeeded } from './objects'
import type { BadgeColor } from '@spaces/core/attributes/colors'
import type { Json } from '#/lib/json'
import type {
  AttributeOptions,
  AttributeType,
  IdentityKey,
  ObjectKind,
  SelectOption,
} from '@spaces/core/attributes/registry'

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
  objectId?: string | undefined
  /** or a core kind, resolved to its system object row */
  objectKind?: ObjectKind | undefined
  name: string
  type: AttributeType
  description?: string | null | undefined
  /** select / multi_select / status — ids derived from labels */
  options?:
    | ReadonlyArray<{
        label: string
        group?: SelectOption['group'] | undefined
        color?: BadgeColor | undefined
      }>
    | undefined
  config?:
    | {
        code?: string | undefined
        max?: number | undefined
        precision?: number | undefined
        targetKind?: ObjectKind | undefined
        targetObjectId?: string | undefined
        multi?: boolean | undefined
        /**
         * This attribute backs one of its object's declared identity keys
         * (spec §9). Only `createObjectProgram` passes it, inside the
         * transaction that declares the key — which is why it is gated to
         * the one type each key can wear, like every other config field.
         */
        identityKey?: IdentityKey | undefined
      }
    | undefined
  default?: Json | undefined
  required?: boolean | undefined
  createdBy: string
  /**
   * Run inside a caller's transaction instead of on its own connection.
   * The backing attribute of an identity key and the object row that
   * declares it are one write or neither (CONTEXT.md, 2026-09-19).
   */
  tx?: Tx | undefined
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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
    else if (cfg.targetObjectId) out.targetObjectId = cfg.targetObjectId
    out.multi = cfg.multi ?? false
  } else if (
    cfg.targetKind !== undefined ||
    cfg.targetObjectId !== undefined ||
    cfg.multi !== undefined
  ) {
    return yield* reject('Relationship settings are not settings of this type')
  }

  if (cfg.identityKey !== undefined) {
    const backing = IDENTITY_KEY_ATTRIBUTES[cfg.identityKey]
    if (input.type !== backing.type)
      return yield* reject(
        `The ${cfg.identityKey} identity key is backed by a ${backing.type} attribute, not a ${input.type} one`,
      )
    out.identityKey = cfg.identityKey
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
    // Either the caller's transaction or the pool — the reads below must see
    // the object row a caller just inserted, so they share its connection.
    const conn = input.tx ?? db

    // Slug: derived once, suffixed on collision within the object, then
    // immutable forever (spec §3 — Attio's mutable slug is the footgun).
    const base = slugify(name)
    let slug = base
    for (let i = 2; ; i++) {
      const taken = yield* query(() =>
        conn
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
      conn
        .select({
          maxOrder: sql<number>`coalesce(max(${attribute.sortOrder}), 0)`,
        })
        .from(attribute)
        .where(eq(attribute.objectId, objectId))
        .then((rows) => rows[0]?.maxOrder ?? 0),
    )

    const row = yield* query(() =>
      conn
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
