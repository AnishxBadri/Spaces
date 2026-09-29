import { createServerFn } from '@tanstack/react-start'
import { asc, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, space, term } from '@spaces/db/schema'
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
 * in and their ancestors, plus global terms. Filing a note into Aerospace is
 * what opts it into the aerospace vocabulary — the same act that puts it on
 * the space page. The query is `termsVisibleFrom`, the one the server-side
 * link sync matches against (SPA-34), so what the editor highlights and what
 * the graph links are drawn from the same set.
 */
export const listTermsForNote = createServerFn()
  .validator(z.object({ noteId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { termsVisibleFrom } = await import('../glossary/link-terms')
    return termsVisibleFrom(db, data.noteId)
  })

/**
 * Create and update run through `lib/glossary/write-term.ts` (SPA-75), which
 * also diff-syncs the aliases into `entity_alias` so search finds a term by
 * its abbreviation. This is the request half only.
 */
export const createTerm = createServerFn({ method: 'POST' })
  .validator(termInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createTermProgram } = await import('../glossary/write-term')
    const { effectFn } = await import('./effect')
    return effectFn(createTermProgram)(u.id, {
      name: data.name,
      aliases: data.aliases,
      definitionMd: data.definitionMd,
      spaceId: data.spaceId ?? null,
    })
  })

export const updateTerm = createServerFn({ method: 'POST' })
  .validator(termInput.partial().extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { updateTermProgram } = await import('../glossary/write-term')
    const { effectFn } = await import('./effect')
    return effectFn(updateTermProgram)({
      id: data.id,
      name: data.name,
      aliases: data.aliases,
      definitionMd: data.definitionMd,
      ...(data.spaceId !== undefined ? { spaceId: data.spaceId } : {}),
    })
  })

/**
 * The term row and its entity, through the one delete executor — what dies
 * with an entity is ENTITY_REFS' answer, not a list kept here (SPA-77). The
 * list that used to live here cleared links and activity and missed the four
 * join tables that had shipped since.
 */
export const deleteTerm = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { deleteEntityProgram } =
      await import('@spaces/core/writes/entities/delete')
    const { effectFn } = await import('./effect')
    await effectFn(deleteEntityProgram)(data.id)
    return { ok: true }
  })

/**
 * The term page's load — definition, mentions with snippets, companies
 * reached and co-mentioned terms, canRead applied in SQL. The query lives in
 * `lib/glossary/term-page.ts` (SPA-75); null means no such term.
 */
export const getTermPage = createServerFn()
  .validator(z.object({ termId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { termPageProgram } = await import('../glossary/term-page')
    const { effectFn } = await import('./effect')
    return effectFn(termPageProgram)(u.id, data.termId)
  })
