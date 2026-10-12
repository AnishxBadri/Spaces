import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { BADGE_COLORS } from '@spaces/core/attributes/colors'
import { aiConfigInput } from '@spaces/core/ai/attribute-ai'
import { isDerived } from '@spaces/core/attributes/relationship'
import { requireAdmin, requireUser } from './shared'
import { jsonValue } from '@spaces/core/json'

export const listRegistry = createServerFn()
  .validator(
    z
      .object({
        /** a core kind — resolves to its system object row */
        kind: z.enum(['company', 'person', 'deal']).optional(),
        /** or the object row itself, the only key a custom object has */
        objectId: z.string().uuid().optional(),
        includeArchived: z.boolean().optional(),
        /**
         * The inverse half of a relationship (D69). `values` never holds it,
         * so only a surface that reads its value from the resolver asks —
         * the ledger and the record pages; one that edited what `values`
         * holds would empty the relationship.
         */
        includeDerived: z.boolean().optional(),
      })
      .refine((v) => v.kind || v.objectId, {
        message: 'Give a kind or an objectId',
      }),
  )
  .handler(async ({ data }) => {
    // Effect-first through the effectFn seam (backend-paradigm ratchet);
    // auth stays promise-land outside the program.
    await requireUser()
    const { attribute, objectDef } = await import('@spaces/db/schema')
    const { objectIdForKind } =
      await import('@spaces/core/writes/attributes/objects')
    const { effectFn } = await import('./effect')
    const { Effect } = await import('effect')

    const listRegistryProgram = Effect.fn('listRegistryProgram')(function* (
      key: {
        kind?: 'company' | 'person' | 'deal' | undefined
        objectId?: string | undefined
      },
      includeArchived: boolean,
      includeDerived: boolean,
    ) {
      const objectId =
        key.objectId ?? (yield* objectIdForKind(key.kind ?? 'company'))
      const rows = yield* Effect.tryPromise({
        try: () =>
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
        catch: (cause) => new Error(`Registry read failed: ${String(cause)}`),
      })
      const listed = includeDerived ? rows : rows.filter((d) => !isDerived(d))
      // Each relationship half's pair, named with the object it sits on.
      const pairIds = listed.flatMap((d) =>
        d.options.inverseOf === undefined ? [] : [d.options.inverseOf],
      )
      const pairs = new Map(
        pairIds.length === 0
          ? []
          : (yield* Effect.tryPromise({
              try: () =>
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
              catch: (cause) =>
                new Error(`Registry read failed: ${String(cause)}`),
            })).map((p) => [p.id, p]),
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
        // One control in the dialog, two columns here (SPA-93) — the edit
        // dialog reads `filterable` back so a reopened attribute shows the
        // box as it was left.
        filterable: d.filterable,
        sortable: d.sortable,
        pair:
          d.options.inverseOf === undefined
            ? null
            : (pairs.get(d.options.inverseOf) ?? null),
      }))
    })

    return effectFn(listRegistryProgram)(
      { kind: data.kind, objectId: data.objectId },
      data.includeArchived ?? false,
      data.includeDerived ?? false,
    )
  })

/**
 * Drag-to-reorder on the per-object attributes page. Admin, like every
 * other reshaping of shared vocabulary.
 */
export const reorderAttributes = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectId: z.string().uuid(),
      ids: z.array(z.string().uuid()).max(200),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const { reorderAttributesProgram } =
      await import('@spaces/core/writes/attributes/update')
    const { effectFn } = await import('./effect')
    return effectFn(reorderAttributesProgram)(data.objectId, data.ids)
  })

const optionEdit = z.object({
  /** absent id = new option (id derived from label) */
  id: z.string().max(60).optional(),
  label: z.string().trim().min(1).max(60),
  group: z.enum(['active', 'parked', 'closed']).optional(),
  /** Constrained to the shipped palette, never a free colour string — a free
   *  field is how someone stores 2:1 grey-on-white and the badge stops being
   *  readable. Structure fixed, content free. */
  color: z.enum(BADGE_COLORS).optional(),
  /** archive replaces removal — stored values keep resolving (spec §3) */
  archived: z.boolean().optional(),
})

/**
 * The update boundary (spec-attribute-engine §3).
 * - `type`, `slug`, `targetKind` and `config.multi` are not here: zod strips
 *   unknown keys, so those edits cannot reach `updateAttributeProgram`.
 * - The one shape change is top-level `multi`, which widens and is refused
 *   when it would narrow. (D69)
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
      /** spec §4 default — shape checked by the program, per type */
      default: jsonValue.optional(),
      /**
       * SPA-72: the spec's `attribute.config.ai`, stored as `options.ai`;
       * null clears. The mode is checked against the type by the program.
       */
      ai: aiConfigInput.nullable().optional(),
      /** "Fill from" (D76): the vocabulary key to link; null unlinks. Checked by the program. */
      enrichmentKey: z.string().trim().min(1).max(80).nullable().optional(),
    })
    .optional(),
})

/**
 * Attribute maintenance. Structure fixed, content free: names, options and
 * per-type config are editable (system included); options can be added,
 * renamed and archived but not removed — stored values may reference them.
 * - A user attribute widens to a list and archives; a system one does neither. (D69)
 */
export const updateAttribute = createServerFn({ method: 'POST' })
  .validator(updateAttributeInput)
  .handler(async ({ data }) => {
    // canWrite's admin edge: renames, option edits, and archiving reshape
    // shared vocabulary for everyone, so they are settings — admin-owned.
    // Creating an attribute stays member (the "+ Add column" flow): additive,
    // and a two-person fund should not need ceremony to add a field.
    const u = await requireAdmin()
    const { updateAttributeProgram } =
      await import('@spaces/core/writes/attributes/update')
    const { effectFn } = await import('./effect')
    const result = await effectFn(updateAttributeProgram)(data, {
      type: 'user',
      id: u.id,
    })
    // After the write commits, never inside it: `CREATE INDEX CONCURRENTLY`
    // cannot run in a transaction (SPA-93). Ticking the box mints the
    // attribute's `attr_idx_<id>`, unticking it — or archiving the
    // attribute — drops it, with no restart. A failed mint is logged by the
    // reconciler and leaves the attribute usable; the next boot retries.
    if (data.indexed !== undefined || data.archived !== undefined) {
      const { reconcileAttributeIndexes } =
        await import('@spaces/core/writes/attributes/reconcile')
      await reconcileAttributeIndexes()
    }
    return result
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
 * The create boundary (spec §7): everything the morphing dialog can set.
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
    })
    .optional(),
  default: jsonValue.optional(),
  required: z.boolean().optional(),
  /** "Filter and sort on this" — sets attribute.filterable and .sortable together */
  indexed: z.boolean().optional(),
})

export const createAttribute = createServerFn({ method: 'POST' })
  .validator(createAttributeInput)
  .handler(async ({ data }) => {
    // Additive, so member-level: a two-person fund should not need ceremony
    // to add a field. Reshaping (rename, options, archive) is admin — see
    // updateAttribute.
    const u = await requireUser()
    const { createAttributeProgram } =
      await import('@spaces/core/writes/attributes/create')
    const { effectFn } = await import('./effect')
    const result = await effectFn(createAttributeProgram)({
      ...data,
      createdBy: u.id,
    })
    // Same rule as the update path: after the insert commits.
    if (data.indexed) {
      const { reconcileAttributeIndexes } =
        await import('@spaces/core/writes/attributes/reconcile')
      await reconcileAttributeIndexes()
    }
    return result
  })

/**
 * The Relationship dialog's one commit (D69): both halves in one
 * transaction, each naming the other in `options.inverseOf`. Additive, so
 * member-level like `createAttribute`.
 */
export const createRelationship = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectId: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
      targetObjectId: z.string().uuid(),
      inverseName: z.string().trim().min(1).max(80),
      cardinality: z.enum(['1:1', '1:N', 'N:1', 'N:N']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createRelationshipProgram } =
      await import('@spaces/core/writes/attributes/relationship')
    const { effectFn } = await import('./effect')
    return effectFn(createRelationshipProgram)({ ...data, createdBy: u.id })
  })
