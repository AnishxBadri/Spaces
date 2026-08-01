import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, note } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { mandate } from '#/db/schema/workspace'
import { requireUser } from './shared'

/**
 * The mandate — the fund's prescriptive strategy. One active row; the prose
 * body is a real note (kind: memo) so search, mentions, and future AI
 * screening come free. Member-writable like the rest of the content layer:
 * a two-person fund has no ceremony, and the mandate is judgment, not
 * settings.
 */

export const getMandate = createServerFn().handler(async () => {
  await requireUser()
  const [row] = await db
    .select({
      id: mandate.id,
      noteEntityId: mandate.noteEntityId,
      stages: mandate.stages,
      geos: mandate.geos,
      checkMin: mandate.checkMin,
      checkMax: mandate.checkMax,
      currency: mandate.currency,
      updatedAt: mandate.updatedAt,
    })
    .from(mandate)
    .where(eq(mandate.status, 'active'))
  if (!row) return null
  return { ...row, updatedAt: row.updatedAt.toISOString() }
})

/** Born with an empty memo note titled "Mandate" — prose first, facts after. */
export const createMandate = createServerFn({ method: 'POST' }).handler(
  async () => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Mandate', createdBy: u.id })
        .returning({ id: entity.id })
      await tx.insert(note).values({
        entityId: ent.id,
        authorId: u.id,
        kind: 'memo',
        bodyMd: '',
      })
      const [row] = await tx
        .insert(mandate)
        .values({ noteEntityId: ent.id })
        .returning({ id: mandate.id })
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'mandate.created',
        subjectEntityId: ent.id,
      })
      return { id: row.id, noteEntityId: ent.id }
    })
  },
)

const factsInput = z.object({
  stages: z.array(z.string().max(60)).max(20).optional(),
  geos: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  checkMin: z.number().int().nonnegative().nullable().optional(),
  checkMax: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().max(8).nullable().optional(),
})

export const updateMandateFacts = createServerFn({ method: 'POST' })
  .validator(factsInput)
  .handler(async ({ data }) => {
    await requireUser()
    const [row] = await db
      .select({ id: mandate.id })
      .from(mandate)
      .where(eq(mandate.status, 'active'))
    if (!row) throw new Error('No active mandate')
    if (
      data.checkMin != null &&
      data.checkMax != null &&
      data.checkMin > data.checkMax
    ) {
      throw new Error('Check size: minimum exceeds maximum')
    }
    await db
      .update(mandate)
      .set({
        ...(data.stages !== undefined ? { stages: data.stages } : {}),
        ...(data.geos !== undefined ? { geos: data.geos } : {}),
        ...(data.checkMin !== undefined ? { checkMin: data.checkMin } : {}),
        ...(data.checkMax !== undefined ? { checkMax: data.checkMax } : {}),
        ...(data.currency !== undefined ? { currency: data.currency } : {}),
        updatedAt: new Date(),
      })
      .where(eq(mandate.id, row.id))
    return { ok: true }
  })
