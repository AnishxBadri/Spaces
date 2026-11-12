import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import { BADGE_COLORS } from '@spaces/core/attributes/colors'
import { aiConfigInput } from '@spaces/core/ai/attribute-ai'
import { isDerived } from '@spaces/core/attributes/relationship'
import { requireAdmin, requireUser } from './shared'
import { jsonValue } from '@spaces/core/json'
import { input } from './input'
import { serverQuery } from './query'

const uuid = Schema.String.check(Schema.isUUID())

const coreKind = Schema.Literals(['company', 'person', 'deal'])

const listRegistryProgram = Effect.fn('listRegistryProgram')(function* (
  key: {
    kind?: 'company' | 'person' | 'deal' | undefined
    objectId?: string | undefined
  },
  includeArchived: boolean,
  includeDerived: boolean,
) {
  const { objectIdForKind } = yield* Effect.promise(
    () => import('@spaces/core/writes/attributes/objects'),
  )
  const objectId =
    key.objectId ?? (yield* objectIdForKind(key.kind ?? 'company'))
  const rows = yield* serverQuery(
    () =>
      db
        .select()
        .from(attribute)
        .where(
          includeArchived
            ? eq(attribute.objectId, objectId)
            : and(
                eq(attribute.objectId, objectId),
                eq(attribute.archived, false),
              ),
        )
        .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
    'Registry read failed',
  )
  const listed = includeDerived ? rows : rows.filter((d) => !isDerived(d))
  // Each relationship half's pair, named with the object it sits on.
  const pairIds = listed.flatMap((d) =>
    d.options.inverseOf === undefined ? [] : [d.options.inverseOf],
  )
  const pairs = new Map(
    pairIds.length === 0
      ? []
      : (yield* serverQuery(
          () =>
            db
              .select({
                id: attribute.id,
                name: attribute.name,
                objectPlural: objectDef.plural,
                archived: attribute.archived,
              })
              .from(attribute)
              .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
              .where(inArray(attribute.id, pairIds)),
          'Registry read failed',
        )).map((p) => [p.id, p]),
  )
  return listed.map((d) => ({
    id: d.id,
    slug: d.slug,
    name: d.name,
    description: d.description,
    type: d.type,
    options: d.options,
    isSystem: d.isSystem,
    archived: d.archived,
    sortOrder: d.sortOrder,
    // One control in the dialog, two columns here: the edit dialog reads
    // `filterable` back so a reopened attribute shows the box as it was left.
    filterable: d.filterable,
    sortable: d.sortable,
    pair:
      d.options.inverseOf === undefined
        ? null
        : (pairs.get(d.options.inverseOf) ?? null),
  }))
})

export const listRegistry = createServerFn()
  .validator(
    input(
      Schema.Struct({
        /** a core kind — resolves to its system object row */
        kind: Schema.optional(coreKind),
        /** or the object row itself, the only key a custom object has */
        objectId: Schema.optional(uuid),
        includeArchived: Schema.optional(Schema.Boolean),
        /**
         * The inverse half of a relationship. `values` never holds it,
         * so only a surface that reads its value from the resolver asks —
         * the ledger and the record pages; one that edited what `values`
         * holds would empty the relationship.
         */
        includeDerived: Schema.optional(Schema.Boolean),
      }).check(
        Schema.makeFilter((v) => Boolean(v.kind || v.objectId), {
          message: 'Give a kind or an objectId',
        }),
      ),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(
      listRegistryProgram(
        { kind: data.kind, objectId: data.objectId },
        data.includeArchived ?? false,
        data.includeDerived ?? false,
      ),
    )
  })

/**
 * Drag-to-reorder on the per-object attributes page. Admin, like every
 * other reshaping of shared vocabulary.
 */
export const reorderAttributes = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        objectId: uuid,
        ids: Schema.Array(uuid).check(Schema.isMaxLength(200)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const { reorderAttributesProgram } =
      await import('@spaces/core/writes/attributes/update')
    const { effectFn } = await import('./effect')
    return effectFn(reorderAttributesProgram)(data.objectId, [...data.ids])
  })

// The option, update and create boundaries stay zod: they compose core's
// zod shapes `aiConfigInput` and `jsonValue`.
const optionEdit = z.object({
  /** absent id = new option (id derived from label) */
  id: z.string().max(60).optional(),
  label: z.string().trim().min(1).max(60),
  group: z.enum(['active', 'parked', 'closed']).optional(),
  /** Constrained to the shipped palette, never a free colour string — a free
   *  field is how someone stores 2:1 grey-on-white and the badge stops being
   *  readable. Structure fixed, content free. */
  color: z.enum(BADGE_COLORS).optional(),
  /** archive replaces removal — stored values keep resolving */
  archived: z.boolean().optional(),
})

/**
 * The update boundary.
 * - `type`, `slug`, `targetKind` and `config.multi` are not here: zod strips
 *   unknown keys, so those edits cannot reach `updateAttributeProgram`.
 * - The one shape change is top-level `multi`, which widens and is refused
 *   when it would narrow.
 */
export const updateAttributeInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** true widens to a list, wrapping every stored value; false is refused on a list */
  multi: z.boolean().optional(),
  move: z.enum(['up', 'down']).optional(),
  /** "Filter and sort on this" — sets attribute.filterable and .sortable together */
  indexed: z.boolean().optional(),
  options: z.array(optionEdit).max(50).optional(),
  config: z
    .object({
      /** currency — ISO 4217 */
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, 'Three-letter currency code')
        .optional(),
      /** rating */
      max: z.number().int().min(1).max(10).optional(),
      /** number — decimals shown */
      precision: z.number().int().min(0).max(6).optional(),
      /** the default value — shape checked by the program, per type */
      default: jsonValue.optional(),
      /**
       * The attribute's AI config, stored as `options.ai`; null clears. The
       * mode is checked against the type by the program.
       */
      ai: aiConfigInput.nullable().optional(),
      /** "Fill from": the vocabulary key to link; null unlinks. Checked by the program. */
      enrichmentKey: z.string().trim().min(1).max(80).nullable().optional(),
      /** text — "Long text": a paragraph in Overview, not a rail row */
      longText: z.boolean().optional(),
    })
    .optional(),
})

/**
 * Attribute maintenance. Structure fixed, content free: names, options and
 * per-type config are editable (system included); options can be added,
 * renamed and archived but not removed — stored values may reference them.
 * - A user attribute widens to a list and archives; a system one does neither.
 */
const reconcileIndexesProgram = Effect.fn('reconcileIndexesProgram')(
  function* () {
    const { reconcileAttributeIndexes } = yield* Effect.promise(
      () => import('@spaces/core/writes/attributes/reconcile'),
    )
    yield* serverQuery(() => reconcileAttributeIndexes())
  },
)

const editAttributeProgram = Effect.fn('editAttributeProgram')(function* (
  data: z.infer<typeof updateAttributeInput>,
  actorId: string,
) {
  const core = yield* Effect.promise(
    () => import('@spaces/core/writes/attributes/update'),
  )
  const result = yield* core.updateAttributeProgram(data, {
    type: 'user',
    id: actorId,
  })
  // After the write commits, never inside it: `CREATE INDEX CONCURRENTLY`
  // cannot run in a transaction. Ticking the box mints the
  // attribute's `attr_idx_<id>`, unticking it — or archiving the
  // attribute — drops it, with no restart. A failed mint is logged by the
  // reconciler and leaves the attribute usable; the next boot retries.
  if (data.indexed !== undefined || data.archived !== undefined)
    yield* reconcileIndexesProgram()
  return result
})

export const updateAttribute = createServerFn({ method: 'POST' })
  .validator(updateAttributeInput)
  .handler(async ({ data }) => {
    // canWrite's admin edge: renames, option edits, and archiving reshape
    // shared vocabulary for everyone, so they are settings — admin-owned.
    // Creating an attribute stays member (the "+ Add column" flow): additive,
    // and a two-person fund should not need ceremony to add a field.
    const u = await requireAdmin()
    return Effect.runPromise(editAttributeProgram(data, u.id))
  })

const ATTRIBUTE_TYPES = [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'domain',
  'email',
  'url',
  'phone',
  'rating',
  'record_reference',
  'actor_reference',
] as const

/**
 * The create boundary: everything the morphing dialog can set.
 * No slug — derived server-side, immutable forever. Option ids are derived
 * from labels the same way the dialog previews them (`deriveOptionIds`).
 */
export const createAttributeInput = z.object({
  objectKind: z.enum(['company', 'person', 'deal']).optional(),
  objectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  type: z.enum(ATTRIBUTE_TYPES),
  options: z
    .array(optionEdit.omit({ id: true, archived: true }))
    .max(50)
    .optional(),
  config: z
    .object({
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, 'Three-letter currency code')
        .optional(),
      max: z.number().int().min(1).max(10).optional(),
      precision: z.number().int().min(0).max(6).optional(),
      targetKind: z.enum(['company', 'person', 'deal']).optional(),
      targetObjectId: z.string().uuid().optional(),
      multi: z.boolean().optional(),
      longText: z.boolean().optional(),
    })
    .optional(),
  default: jsonValue.optional(),
  required: z.boolean().optional(),
  /** "Filter and sort on this" — sets attribute.filterable and .sortable together */
  indexed: z.boolean().optional(),
})

const addAttributeProgram = Effect.fn('addAttributeProgram')(function* (
  data: z.infer<typeof createAttributeInput>,
  createdBy: string,
) {
  const core = yield* Effect.promise(
    () => import('@spaces/core/writes/attributes/create'),
  )
  const result = yield* core.createAttributeProgram({ ...data, createdBy })
  // Same rule as the update path: after the insert commits.
  if (data.indexed) yield* reconcileIndexesProgram()
  return result
})

export const createAttribute = createServerFn({ method: 'POST' })
  .validator(createAttributeInput)
  .handler(async ({ data }) => {
    // Additive, so member-level: a two-person fund should not need ceremony
    // to add a field. Reshaping (rename, options, archive) is admin — see
    // updateAttribute.
    const u = await requireUser()
    return Effect.runPromise(addAttributeProgram(data, u.id))
  })

/**
 * The Relationship dialog's one commit: both halves in one
 * transaction, each naming the other in `options.inverseOf`. Additive, so
 * member-level like `createAttribute`.
 */
export const createRelationship = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        objectId: uuid,
        name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
        targetObjectId: uuid,
        inverseName: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(80),
        ),
        cardinality: Schema.Literals(['1:1', '1:N', 'N:1', 'N:N']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createRelationshipProgram } =
      await import('@spaces/core/writes/attributes/relationship')
    const { effectFn } = await import('./effect')
    return effectFn(createRelationshipProgram)({ ...data, createdBy: u.id })
  })
