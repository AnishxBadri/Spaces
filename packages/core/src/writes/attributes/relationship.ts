import { Cause, Effect, Exit, Option, Schema } from 'effect'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import { coreKindOf } from '../../attributes/registry'
import {
  flipCardinality,
  holdsMany,
  ownerSide,
} from '../../attributes/relationship'
import type { Cardinality } from '../../attributes/relationship'
import type { AttributeOptions } from '../../attributes/registry'
import { createAttributeProgram } from './create'
import type { AttributeCreateRejected, Tx } from './create'
import { ObjectQueryFailed } from './objects'
import type { SystemObjectNotSeeded } from './objects'
import type { AttributeQueryFailed } from './update'

/**
 * A relationship: two `record_reference` attributes, one per object,
 * created together in one transaction and joined by `options.inverseOf`.
 * - Each carries the cardinality read from its own side.
 * - The owner stores the value; the other half is `derived` and stores
 *   nothing (`ownerSide`).
 */

export class RelationshipRejected extends Schema.TaggedError<RelationshipRejected>()(
  'RelationshipRejected',
  { message: Schema.String },
) {}

export type CreateRelationshipFailure =
  | RelationshipRejected
  | AttributeCreateRejected
  | AttributeQueryFailed
  | ObjectQueryFailed
  | SystemObjectNotSeeded

export type CreateRelationshipInput = {
  /** Object A — the side the dialog was opened from. */
  objectId: string
  /** The attribute's name on A. */
  name: string
  /** Object B. */
  targetObjectId: string
  /** The attribute's name on B. */
  inverseName: string
  /** Read from A's side: `N:1` is many A to one B. */
  cardinality: Cardinality
  createdBy: string
}

export type RelationshipHalf = { id: string; slug: string }

/** Carries a typed failure out through the transaction's rollback. */
class RelationshipRollback extends Error {
  constructor(readonly failure: CreateRelationshipFailure) {
    super('relationship creation refused')
    this.name = 'RelationshipRollback'
  }
}

const asFailure = (cause: unknown): CreateRelationshipFailure =>
  cause instanceof RelationshipRollback
    ? cause.failure
    : new ObjectQueryFailed({ cause })

type ObjectRow = {
  id: string
  slug: string
  isSystem: boolean
  archived: boolean
}

/** A reference to `object`'s records: a core kind, or the object row. */
const targetOf = (object: ObjectRow) => {
  const kind = coreKindOf(object)
  return kind === null ? { targetObjectId: object.id } : { targetKind: kind }
}

/** One half, made by the attribute door inside the caller's transaction. */
async function createHalf(
  tx: Tx,
  args: {
    object: ObjectRow
    target: ObjectRow
    name: string
    cardinality: Cardinality
    createdBy: string
  },
): Promise<RelationshipHalf> {
  const exit = await Effect.runPromiseExit(
    createAttributeProgram({
      tx,
      objectId: args.object.id,
      name: args.name,
      type: 'record_reference',
      config: {
        ...targetOf(args.target),
        multi: holdsMany(args.cardinality),
      },
      createdBy: args.createdBy,
    }),
  )
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  throw new RelationshipRollback(
    Option.isSome(failure)
      ? failure.value
      : new ObjectQueryFailed({ cause: Cause.squash(exit.cause) }),
  )
}

/** Joins a half to its pair: `inverseOf`, its cardinality, and `derived` on the inverse. */
const pairOptions = (
  inverseOf: string,
  cardinality: Cardinality,
  derived: boolean,
): AttributeOptions => ({
  inverseOf,
  cardinality,
  ...(derived ? { derived: true } : {}),
})

export const createRelationshipProgram = Effect.fn('createRelationshipProgram')(
  function* (
    input: CreateRelationshipInput,
  ): Effect.fn.Return<
    { a: RelationshipHalf; b: RelationshipHalf; owner: 'a' | 'b' },
    CreateRelationshipFailure
  > {
    const name = input.name.trim()
    const inverseName = input.inverseName.trim()
    if (!name || !inverseName)
      return yield* new RelationshipRejected({ message: 'Name both sides' })

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: objectDef.id,
            slug: objectDef.slug,
            isSystem: objectDef.isSystem,
            archived: objectDef.archived,
          })
          .from(objectDef)
          .where(inArray(objectDef.id, [input.objectId, input.targetObjectId])),
      catch: (cause) => new ObjectQueryFailed({ cause }),
    })
    const a = rows.find((r) => r.id === input.objectId)
    const b = rows.find((r) => r.id === input.targetObjectId)
    if (!a || !b)
      return yield* new RelationshipRejected({
        message: 'Pick both objects',
      })
    if (a.archived || b.archived)
      return yield* new RelationshipRejected({
        message: 'An archived object takes no new relationships',
      })

    const flipped = flipCardinality(input.cardinality)
    const owner = ownerSide(input.cardinality)
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const halfA = await createHalf(tx, {
            object: a,
            target: b,
            name,
            cardinality: input.cardinality,
            createdBy: input.createdBy,
          })
          const halfB = await createHalf(tx, {
            object: b,
            target: a,
            name: inverseName,
            cardinality: flipped,
            createdBy: input.createdBy,
          })
          const join = async (
            id: string,
            options: AttributeOptions,
          ): Promise<void> => {
            await tx
              .update(attribute)
              .set({
                options: sql`${attribute.options} || ${JSON.stringify(options)}::jsonb`,
              })
              .where(eq(attribute.id, id))
          }
          await join(
            halfA.id,
            pairOptions(halfB.id, input.cardinality, owner === 'b'),
          )
          await join(halfB.id, pairOptions(halfA.id, flipped, owner === 'a'))
          return { a: halfA, b: halfB, owner }
        }),
      catch: asFailure,
    })
  },
)
