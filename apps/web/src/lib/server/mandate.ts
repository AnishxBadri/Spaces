import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { mandate } from '@spaces/db/schema/workspace'
import { requireUser } from './shared'
import { input } from './input'
import { serverQuery } from './query'
import type { ServerQueryFailed } from './query'

/**
 * The mandate — the fund's prescriptive strategy. One active row; the prose
 * body is a real note (kind: memo) so search, mentions, and future AI
 * screening come free. Member-writable like the rest of the content layer:
 * a two-person fund has no ceremony, and the mandate is judgment, not
 * settings.
 */

class NoActiveMandate extends Schema.TaggedError<NoActiveMandate>()(
  'NoActiveMandate',
  { message: Schema.String },
) {}

class CheckSizeInverted extends Schema.TaggedError<CheckSizeInverted>()(
  'CheckSizeInverted',
  { message: Schema.String },
) {}

const getMandateProgram = Effect.fn('getMandateProgram')(function* () {
  const row = (yield* serverQuery(() =>
    db
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
      .where(eq(mandate.status, 'active')),
  )).at(0)
  if (!row) return null
  return { ...row, updatedAt: row.updatedAt.toISOString() }
})

export const getMandate = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(getMandateProgram())
})

const createMandateProgram = Effect.fn('createMandateProgram')(function* (
  actorId: string,
) {
  return yield* serverQuery(() =>
    db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Mandate', createdBy: actorId })
        .returning({ id: entity.id })
      await tx.insert(note).values({
        entityId: ent.id,
        authorId: actorId,
        kind: 'memo',
        bodyMd: '',
      })
      const [row] = await tx
        .insert(mandate)
        .values({ noteEntityId: ent.id })
        .returning({ id: mandate.id })
      await tx.insert(activity).values({
        actorId,
        verb: 'mandate.created',
        subjectEntityId: ent.id,
      })
      return { id: row.id, noteEntityId: ent.id }
    }),
  )
})

/** Born with an empty memo note titled "Mandate" — prose first, facts after. */
export const createMandate = createServerFn({ method: 'POST' }).handler(
  async () => {
    const u = await requireUser()
    return Effect.runPromise(createMandateProgram(u.id))
  },
)

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const factsInput = Schema.Struct({
  stages: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(
      Schema.isMaxLength(20),
    ),
  ),
  geos: Schema.optional(
    Schema.Array(
      Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
    ).check(Schema.isMaxLength(30)),
  ),
  checkMin: Schema.optional(Schema.NullOr(nonNegativeInt)),
  checkMax: Schema.optional(Schema.NullOr(nonNegativeInt)),
  currency: Schema.optional(
    Schema.NullOr(Schema.Trim.check(Schema.isMaxLength(8))),
  ),
})

const updateMandateFactsProgram = Effect.fn('updateMandateFactsProgram')(
  function* (
    data: typeof factsInput.Type,
  ): Effect.fn.Return<
    { ok: boolean },
    NoActiveMandate | CheckSizeInverted | ServerQueryFailed
  > {
    const row = (yield* serverQuery(() =>
      db
        .select({ id: mandate.id })
        .from(mandate)
        .where(eq(mandate.status, 'active')),
    )).at(0)
    if (!row)
      return yield* new NoActiveMandate({ message: 'No active mandate' })
    if (
      data.checkMin != null &&
      data.checkMax != null &&
      data.checkMin > data.checkMax
    ) {
      return yield* new CheckSizeInverted({
        message: 'Check size: minimum exceeds maximum',
      })
    }
    yield* serverQuery(() =>
      db
        .update(mandate)
        .set({
          ...(data.stages !== undefined ? { stages: [...data.stages] } : {}),
          ...(data.geos !== undefined ? { geos: [...data.geos] } : {}),
          ...(data.checkMin !== undefined ? { checkMin: data.checkMin } : {}),
          ...(data.checkMax !== undefined ? { checkMax: data.checkMax } : {}),
          ...(data.currency !== undefined ? { currency: data.currency } : {}),
          updatedAt: new Date(),
        })
        .where(eq(mandate.id, row.id)),
    )
    return { ok: true }
  },
)

export const updateMandateFacts = createServerFn({ method: 'POST' })
  .validator(input(factsInput))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(updateMandateFactsProgram(data))
  })
