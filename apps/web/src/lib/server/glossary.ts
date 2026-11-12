import { createServerFn } from '@tanstack/react-start'
import { asc, eq, isNull, or, sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { entity, space, term } from '@spaces/db/schema'
import { requireUser } from './shared'
import { input } from './input'
import { serverQuery } from './query'

/**
 * Terms are scoped to a space because "stage" means something different in
 * aerospace and in bio — a global glossary would force one definition on
 * both. A null space_id is the deliberate exception: vocabulary true
 * everywhere (SAFE, pro-rata, ARR).
 */

const uuid = Schema.String.check(Schema.isUUID())

const termName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
)

// An absent list or definition reads as empty, on update as on create.
const termFields = {
  aliases: Schema.Array(termName)
    .check(Schema.isMaxLength(20))
    .pipe(
      Schema.withDecodingDefault(Effect.succeed<ReadonlyArray<string>>([])),
    ),
  definitionMd: Schema.Trim.check(Schema.isMaxLength(4000)).pipe(
    Schema.withDecodingDefault(Effect.succeed('')),
  ),
  spaceId: Schema.optional(Schema.NullOr(uuid)),
}

const listTermsProgram = Effect.fn('listTermsProgram')(function* (
  spaceId: string | null | undefined,
) {
  return yield* serverQuery(() =>
    db
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
        spaceId
          ? // A space's glossary is its own terms, everything inherited from
            // its ancestors, and the global ones. Inheritance runs downward
            // only: PUE defined at Data centers is true in Cooling, but a
            // term defined in Cooling says nothing about Aerospace — which
            // is the collision the scoping exists to prevent.
            or(
              isNull(term.spaceId),
              sql`${term.spaceId} in (
                select anc.entity_id from space anc
                join space self on self.entity_id = ${spaceId}
                where anc.path @> self.path
              )`,
            )
          : undefined,
      )
      .orderBy(asc(term.name)),
  )
})

export const listTerms = createServerFn()
  .validator(
    input(
      Schema.UndefinedOr(
        Schema.Struct({ spaceId: Schema.optional(Schema.NullOr(uuid)) }),
      ),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(listTermsProgram(data?.spaceId))
  })

/**
 * The term set in scope for a note: everything from the spaces it is filed
 * in and their ancestors, plus global terms. Filing a note into Aerospace is
 * what opts it into the aerospace vocabulary — the same act that puts it on
 * the space page. The query is `termsVisibleFrom`, the one the server-side
 * link sync matches against, so what the editor highlights and what
 * the graph links are drawn from the same set.
 */
const listTermsForNoteProgram = Effect.fn('listTermsForNoteProgram')(function* (
  noteId: string,
) {
  const { termsVisibleFrom } = yield* Effect.promise(
    () => import('../glossary/link-terms'),
  )
  return yield* serverQuery(() => termsVisibleFrom(db, noteId))
})

export const listTermsForNote = createServerFn()
  .validator(input(Schema.Struct({ noteId: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(listTermsForNoteProgram(data.noteId))
  })

/**
 * Create and update run through the term writer, which also diff-syncs the
 * aliases into `entity_alias` so search finds a term by its abbreviation. This is the request half only.
 */
export const createTerm = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ name: termName, ...termFields })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createTermProgram } = await import('../glossary/write-term')
    const { effectFn } = await import('./effect')
    return effectFn(createTermProgram)(u.id, {
      name: data.name,
      aliases: [...data.aliases],
      definitionMd: data.definitionMd,
      spaceId: data.spaceId ?? null,
    })
  })

export const updateTerm = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: uuid,
        name: Schema.optional(termName),
        ...termFields,
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { updateTermProgram } = await import('../glossary/write-term')
    const { effectFn } = await import('./effect')
    return effectFn(updateTermProgram)({
      id: data.id,
      name: data.name,
      aliases: [...data.aliases],
      definitionMd: data.definitionMd,
      ...(data.spaceId !== undefined ? { spaceId: data.spaceId } : {}),
    })
  })

/**
 * The term row and its entity, through the one delete executor: what dies
 * with an entity is ENTITY_REFS' answer. Never keep a hand list here.
 */
export const deleteTerm = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ id: uuid })))
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
 * reached and co-mentioned terms, canRead applied in SQL. Null means no such
 * term.
 */
export const getTermPage = createServerFn()
  .validator(input(Schema.Struct({ termId: uuid })))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { termPageProgram } = await import('../glossary/term-page')
    const { effectFn } = await import('./effect')
    return effectFn(termPageProgram)(u.id, data.termId)
  })
