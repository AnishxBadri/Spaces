import { createServerFn } from '@tanstack/react-start'
import { asc, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, entitySpace, link, space, term } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { requireUser } from './shared'

/**
 * Terms are scoped to a space because "stage" means something different in
 * aerospace and in bio — a global glossary would force one definition on
 * both. A null space_id is the deliberate exception: vocabulary true
 * everywhere (SAFE, pro-rata, ARR).
 */

const termInput = z.object({
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  definitionMd: z.string().trim().max(4000).default(''),
  spaceId: z.string().uuid().nullish(),
})

export const listTerms = createServerFn()
  .validator(z.object({ spaceId: z.string().uuid().nullish() }).optional())
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: term.entityId,
        name: term.name,
        aliases: term.aliases,
        definitionMd: term.definitionMd,
        spaceId: term.spaceId,
        spaceName: entity.canonicalName,
      })
      .from(term)
      .leftJoin(space, eq(space.entityId, term.spaceId))
      .leftJoin(entity, eq(entity.id, space.entityId))
      .where(
        data?.spaceId
          ? // A space's glossary is its own terms, everything inherited from
            // its ancestors, and the global ones. Inheritance runs downward
            // only: PUE defined at Data centers is true in Cooling, but a
            // term defined in Cooling says nothing about Aerospace — which
            // is the collision the scoping exists to prevent.
            or(
              isNull(term.spaceId),
              sql`${term.spaceId} in (
                select anc.entity_id from space anc
                join space self on self.entity_id = ${data.spaceId}
                where anc.path @> self.path
              )`,
            )
          : undefined,
      )
      .orderBy(asc(term.name))
    return rows
  })

/**
 * The term set in scope for a note: everything from the spaces it is filed
 * in, plus global terms. Filing a note into Aerospace is what opts it into
 * the aerospace vocabulary — the same act that puts it on the space page.
 */
export const listTermsForNote = createServerFn()
  .validator(z.object({ noteId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const spaceIds = (
      await db
        .select({ spaceId: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, data.noteId))
    ).map((r) => r.spaceId)

    return db
      .select({
        id: term.entityId,
        name: term.name,
        aliases: term.aliases,
        definitionMd: term.definitionMd,
      })
      .from(term)
      .where(
        spaceIds.length > 0
          ? // Ancestors too: a note filed in Immersion cooling should know
            // the vocabulary of Cooling and of Data centers above it.
            or(
              isNull(term.spaceId),
              sql`${term.spaceId} in (
                select anc.entity_id from space anc
                join space self on self.entity_id = any(${sql.param(spaceIds)}::uuid[])
                where anc.path @> self.path
              )`,
            )
          : isNull(term.spaceId),
      )
      .orderBy(asc(term.name))
  })

export const createTerm = createServerFn({ method: 'POST' })
  .validator(termInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'term', canonicalName: data.name, createdBy: u.id })
        .returning({ id: entity.id })
      await tx.insert(term).values({
        entityId: ent.id,
        name: data.name,
        aliases: data.aliases,
        definitionMd: data.definitionMd,
        spaceId: data.spaceId ?? null,
      })
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'term.created',
        subjectEntityId: ent.id,
      })
      return { id: ent.id }
    })
  })

export const updateTerm = createServerFn({ method: 'POST' })
  .validator(termInput.partial().extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.transaction(async (tx) => {
      await tx
        .update(term)
        .set({
          ...(data.name ? { name: data.name } : {}),
          ...(data.aliases ? { aliases: data.aliases } : {}),
          ...(data.definitionMd !== undefined
            ? { definitionMd: data.definitionMd }
            : {}),
          ...(data.spaceId !== undefined
            ? { spaceId: data.spaceId ?? null }
            : {}),
        })
        .where(eq(term.entityId, data.id))
      if (data.name) {
        await tx
          .update(entity)
          .set({ canonicalName: data.name })
          .where(eq(entity.id, data.id))
      }
    })
    return { ok: true }
  })

export const deleteTerm = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.transaction(async (tx) => {
      await tx
        .delete(link)
        .where(or(eq(link.fromEntityId, data.id), eq(link.toEntityId, data.id)))
      await tx
        .delete(activity)
        .where(
          or(
            eq(activity.subjectEntityId, data.id),
            eq(activity.objectEntityId, data.id),
          ),
        )
      await tx.delete(term).where(eq(term.entityId, data.id))
      await tx.delete(entity).where(eq(entity.id, data.id))
    })
    return { ok: true }
  })
