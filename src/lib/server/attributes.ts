import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { BADGE_COLORS, nextBadgeColor } from '../attributes/colors'
import { requireAdmin, requireUser } from './shared'
import type { Json } from './shared'

export const listRegistry = createServerFn()
  .validator(
    z.object({
      kind: z.enum(['company', 'person', 'deal']),
      includeArchived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { attribute } = await import('#/db/schema')
    const rows = await db
      .select()
      .from(attribute)
      .where(
        data.includeArchived
          ? eq(attribute.objectKind, data.kind)
          : and(
              eq(attribute.objectKind, data.kind),
              eq(attribute.archived, false),
            ),
      )
      .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
    return rows.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      type: d.type,
      options: d.options as Json,
      isSystem: d.isSystem,
      archived: d.archived,
      sortOrder: d.sortOrder,
    }))
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
})

/**
 * Attribute maintenance. Structure fixed, content free: names and options
 * are editable (system included); types never change; options can be added
 * and renamed but not removed — stored values may reference them.
 */
export const updateAttribute = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(80).optional(),
      archived: z.boolean().optional(),
      move: z.enum(['up', 'down']).optional(),
      options: z.array(optionEdit).max(50).optional(),
    }),
  )
  .handler(async ({ data }) => {
    // canWrite's admin edge: renames, option edits, and archiving reshape
    // shared vocabulary for everyone, so they are settings — admin-owned.
    // Creating an attribute stays member (the "+ Add column" flow): additive,
    // and a two-person fund should not need ceremony to add a field.
    await requireAdmin()
    const { attribute } = await import('#/db/schema')
    const attr = (
      await db.select().from(attribute).where(eq(attribute.id, data.id))
    ).at(0)
    if (!attr) throw new Error('Attribute not found')

    if (data.options) {
      const isOptionType = ['select', 'multi_select', 'status'].includes(
        attr.type,
      )
      if (!isOptionType) throw new Error('This attribute type has no options')
      const existing =
        ((attr.options as Record<string, unknown>).options as
          Array<{ id: string }> | undefined) ?? []
      const existingIds = new Set(existing.map((o) => o.id))
      const keptIds = new Set(
        data.options.filter((o) => o.id).map((o) => o.id!),
      )
      for (const id of existingIds) {
        if (!keptIds.has(id))
          throw new Error(
            'Options cannot be removed — records may hold that value. Rename it instead.',
          )
      }
      const seen = new Set<string>()
      const nextOptions = data.options.map((o, i) => {
        let id = o.id
        if (!id) {
          id =
            o.label
              .toLowerCase()
              .normalize('NFKD')
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 48) || 'option'
          while (seen.has(id) || existingIds.has(id)) id = `${id}_2`
        }
        seen.add(id)
        return {
          id,
          label: o.label,
          ...(o.group ? { group: o.group } : {}),
          // An option without an explicit colour is stored with the one it was
          // already rendering, so saving the editor never silently reshuffles
          // the colours the user has been looking at.
          color: o.color ?? nextBadgeColor(i, o.group),
        }
      })
      await db
        .update(attribute)
        .set({
          options: {
            ...(attr.options as Record<string, unknown>),
            options: nextOptions,
          },
        })
        .where(eq(attribute.id, data.id))
    }

    if (data.name) {
      await db
        .update(attribute)
        .set({ name: data.name })
        .where(eq(attribute.id, data.id))
    }
    if (data.archived !== undefined) {
      await db
        .update(attribute)
        .set({ archived: data.archived })
        .where(eq(attribute.id, data.id))
    }
    if (data.move) {
      const siblings = await db
        .select({ id: attribute.id, sortOrder: attribute.sortOrder })
        .from(attribute)
        .where(eq(attribute.objectKind, attr.objectKind))
        .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
      const idx = siblings.findIndex((s) => s.id === data.id)
      const swapIdx = data.move === 'up' ? idx - 1 : idx + 1
      const swapWith = swapIdx >= 0 ? siblings.at(swapIdx) : undefined
      if (swapWith) {
        await db
          .update(attribute)
          .set({ sortOrder: swapWith.sortOrder })
          .where(eq(attribute.id, data.id))
        await db
          .update(attribute)
          .set({ sortOrder: attr.sortOrder })
          .where(eq(attribute.id, swapWith.id))
      }
    }
    return { ok: true }
  })

const createAttributeInput = z.object({
  objectKind: z.enum(['company', 'person', 'deal']),
  name: z.string().trim().min(1).max(80),
  type: z.enum([
    'text',
    'number',
    'currency',
    'date',
    'checkbox',
    'select',
    'multi_select',
    'rating',
    'url',
    'email',
    'phone',
  ]),
  /** select/multi_select: option labels; ids derived */
  optionLabels: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
})

export const createAttribute = createServerFn({ method: 'POST' })
  .validator(createAttributeInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { attribute } = await import('#/db/schema')

    const baseSlug =
      data.name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'attribute'

    // Suffix on slug collision within the object kind.
    let slug = baseSlug
    for (let i = 2; ; i++) {
      const existing = await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(
          and(
            eq(attribute.objectKind, data.objectKind),
            eq(attribute.slug, slug),
          ),
        )
      if (existing.length === 0) break
      slug = `${baseSlug}_${i}`
    }

    const needsOptions = data.type === 'select' || data.type === 'multi_select'
    if (
      needsOptions &&
      (!data.optionLabels || data.optionLabels.length === 0)
    ) {
      throw new Error('Select attributes need at least one option')
    }
    const options = needsOptions
      ? {
          options: data.optionLabels!.map((label, i) => ({
            id:
              label
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 48) || 'option',
            label,
            // Coloured on creation, so a new select is legible immediately
            // rather than a column of identical grey chips.
            color: nextBadgeColor(i),
          })),
        }
      : data.type === 'rating'
        ? { max: 5 }
        : {}

    const [{ maxOrder }] = await db
      .select({
        maxOrder: sql<number>`coalesce(max(${attribute.sortOrder}), 0)`,
      })
      .from(attribute)
      .where(eq(attribute.objectKind, data.objectKind))

    const [row] = await db
      .insert(attribute)
      .values({
        objectKind: data.objectKind,
        slug,
        name: data.name,
        type: data.type,
        options,
        isSystem: false,
        sortOrder: maxOrder + 10,
        createdBy: u.id,
      })
      .returning({ id: attribute.id, slug: attribute.slug })
    return row
  })
