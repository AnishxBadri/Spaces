import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { BADGE_COLORS } from '../attributes/colors'
import { requireAdmin, requireUser } from './shared'
import { jsonValue } from '#/lib/json'

export const listRegistry = createServerFn()
  .validator(
    z
      .object({
        /** a core kind — resolves to its system object row */
        kind: z.enum(['company', 'person', 'deal']).optional(),
        /** or the object row itself, the only key a custom object has */
        objectId: z.string().uuid().optional(),
        includeArchived: z.boolean().optional(),
      })
      .refine((v) => v.kind || v.objectId, {
        message: 'Give a kind or an objectId',
      }),
  )
  .handler(async ({ data }) => {
    // Effect-first through the effectFn seam (backend-paradigm ratchet);
    // auth stays promise-land outside the program.
    await requireUser()
    const { attribute } = await import('#/db/schema')
    const { objectIdForKind } = await import('../attributes/objects')
    const { effectFn } = await import('./effect')
    const { Effect } = await import('effect')

    const listRegistryProgram = Effect.fn('listRegistryProgram')(function* (
      key: {
        kind?: 'company' | 'person' | 'deal' | undefined
        objectId?: string | undefined
      },
      includeArchived: boolean,
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
      return rows.map((d) => ({
        id: d.id,
        slug: d.slug,
        name: d.name,
        description: d.description,
        type: d.type,
        options: d.options,
        isSystem: d.isSystem,
        archived: d.archived,
        sortOrder: d.sortOrder,
      }))
    })

    return effectFn(listRegistryProgram)(
      { kind: data.kind, objectId: data.objectId },
      data.includeArchived ?? false,
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
    const { reorderAttributesProgram } = await import('../attributes/update')
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
 * The update boundary (spec-attribute-engine §3). `type` and `slug` are not
 * here, and neither are record_reference's `targetKind` / `multi`: zod
 * strips unknown keys, so those edits cannot reach the program at all —
 * unrepresentable, not validated away. The per-type rules for what *is*
 * here live in the program (`src/lib/attributes/update.ts`).
 */
export const updateAttributeInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
  move: z.enum(['up', 'down']).optional(),
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
    })
    .optional(),
})

/**
 * Attribute maintenance. Structure fixed, content free: names, options and
 * per-type config are editable (system included); types never change;
 * options can be added, renamed and archived but not removed — stored
 * values may reference them.
 */
export const updateAttribute = createServerFn({ method: 'POST' })
  .validator(updateAttributeInput)
  .handler(async ({ data }) => {
    // canWrite's admin edge: renames, option edits, and archiving reshape
    // shared vocabulary for everyone, so they are settings — admin-owned.
    // Creating an attribute stays member (the "+ Add column" flow): additive,
    // and a two-person fund should not need ceremony to add a field.
    await requireAdmin()
    const { updateAttributeProgram } = await import('../attributes/update')
    const { effectFn } = await import('./effect')
    return effectFn(updateAttributeProgram)(data)
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
})

export const createAttribute = createServerFn({ method: 'POST' })
  .validator(createAttributeInput)
  .handler(async ({ data }) => {
    // Additive, so member-level: a two-person fund should not need ceremony
    // to add a field. Reshaping (rename, options, archive) is admin — see
    // updateAttribute.
    const u = await requireUser()
    const { createAttributeProgram } = await import('../attributes/create')
    const { effectFn } = await import('./effect')
    return effectFn(createAttributeProgram)({ ...data, createdBy: u.id })
  })
