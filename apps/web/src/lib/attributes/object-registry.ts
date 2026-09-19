import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity } from '@spaces/db/schema/activity'
import { entity, objectDef } from '@spaces/db/schema'
import { birthValuesEffect } from './defaults'
import { slugifyNoun, suggestPlural } from '#/lib/object-nouns'
import type {
  Actor,
  AttributeValidationError,
  EntityNotFound,
  ValuesWriteFailed,
} from './values'

/**
 * Custom objects (spec §9, two-tier model). An object is an attribute bag
 * with a name: nouns rename freely, the slug is derived from the plural at
 * creation and frozen, archive replaces delete. Records of a custom object
 * are `entity.kind = 'custom'` rows keyed by `object_id`; they get the full
 * attribute engine and the research graph (spaces, mentions, notes,
 * documents) and none of the identity machinery (aliases, dedupe, merge,
 * enrichment, interactions) — which is why they are born here and never
 * through resolveEntity.
 */

export class ObjectRejected extends Schema.TaggedError<ObjectRejected>()(
  'ObjectRejected',
  { message: Schema.String },
) {}

export class ObjectQueryFailed extends Schema.TaggedError<ObjectQueryFailed>()(
  'ObjectQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ObjectQueryFailed({ cause }),
  })

/** Slugs that would collide with app routes or read as system objects. */
const RESERVED = new Set([
  'companies',
  'people',
  'deals',
  'settings',
  'spaces',
  'notes',
  'tasks',
  'portfolio',
  'today',
  'mandate',
  'dedupe',
  'o',
  'api',
  'login',
  'join',
  'setup',
])

export { slugifyNoun, suggestPlural }

export type CreateObjectInput = {
  singular: string
  plural: string
  icon?: string | null | undefined
  createdBy: string
}

export const createObjectProgram = Effect.fn('createObjectProgram')(function* (
  input: CreateObjectInput,
): Effect.fn.Return<
  { id: string; slug: string },
  ObjectRejected | ObjectQueryFailed
> {
  const singular = input.singular.trim()
  const plural = input.plural.trim()
  if (!singular || !plural)
    return yield* new ObjectRejected({ message: 'Give both nouns' })
  const base = slugifyNoun(plural)
  if (!base)
    return yield* new ObjectRejected({ message: 'The plural needs letters' })
  if (RESERVED.has(base))
    return yield* new ObjectRejected({
      message: `"${plural}" is taken by the app — pick another plural`,
    })
  // Slug: derived once, suffixed on collision, then immutable (§3).
  let slug = base
  for (let i = 2; ; i++) {
    const taken = yield* query(() =>
      db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, slug))
        .then((rows) => rows.length > 0),
    )
    if (!taken) break
    slug = `${base}-${i}`
  }
  const row = yield* query(() =>
    db
      .insert(objectDef)
      .values({
        slug,
        singular,
        plural,
        icon: input.icon ?? null,
        isSystem: false,
        createdBy: input.createdBy,
      })
      .returning({ id: objectDef.id, slug: objectDef.slug })
      .then((rows) => rows[0]),
  )
  return row
})

export type UpdateObjectInput = {
  id: string
  singular?: string | undefined
  plural?: string | undefined
  icon?: string | null | undefined
  archived?: boolean | undefined
}

export const updateObjectProgram = Effect.fn('updateObjectProgram')(function* (
  input: UpdateObjectInput,
): Effect.fn.Return<{ ok: true }, ObjectRejected | ObjectQueryFailed> {
  const row = yield* query(() =>
    db
      .select({ id: objectDef.id, isSystem: objectDef.isSystem })
      .from(objectDef)
      .where(eq(objectDef.id, input.id))
      .then((rows) => rows.at(0)),
  )
  if (!row) return yield* new ObjectRejected({ message: 'Object not found' })
  // System objects ship with the product: never archivable (§9).
  if (input.archived !== undefined && row.isSystem)
    return yield* new ObjectRejected({
      message: 'System objects cannot be archived',
    })
  const patch: Partial<typeof objectDef.$inferInsert> = {}
  if (input.singular !== undefined) {
    const v = input.singular.trim()
    if (!v) return yield* new ObjectRejected({ message: 'Name the singular' })
    patch.singular = v
  }
  if (input.plural !== undefined) {
    const v = input.plural.trim()
    if (!v) return yield* new ObjectRejected({ message: 'Name the plural' })
    patch.plural = v
  }
  if (input.icon !== undefined) patch.icon = input.icon
  if (input.archived !== undefined) patch.archived = input.archived
  if (Object.keys(patch).length > 0)
    yield* query(() =>
      db.update(objectDef).set(patch).where(eq(objectDef.id, input.id)),
    )
  return { ok: true }
})

export type CreateRecordInput = {
  objectId: string
  /** the display name — core-owned, required at birth (§9 birth contract) */
  name: string
  values?: Record<string, unknown> | undefined
  actor: Actor
}

/**
 * Birth of a custom record: an entity row with the display name, then the
 * same birth-values pass every record gets (supplied first, defaults for
 * the blanks). No aliases, no dedupe sweep — that's core-only machinery.
 */
export const createRecordProgram = Effect.fn('createRecordProgram')(function* (
  input: CreateRecordInput,
): Effect.fn.Return<
  { id: string },
  | ObjectRejected
  | ObjectQueryFailed
  | AttributeValidationError
  | EntityNotFound
  | ValuesWriteFailed
> {
  const name = input.name.trim()
  if (!name)
    return yield* new ObjectRejected({ message: 'Every record needs a name' })
  const object = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
      })
      .from(objectDef)
      .where(eq(objectDef.id, input.objectId))
      .then((rows) => rows.at(0)),
  )
  if (!object) return yield* new ObjectRejected({ message: 'Object not found' })
  if (object.isSystem)
    return yield* new ObjectRejected({
      message: 'Core records are born through their own flows',
    })
  if (object.archived)
    return yield* new ObjectRejected({ message: 'This object is archived' })
  const userId = input.actor.type === 'user' ? input.actor.id : null
  const row = yield* query(() =>
    db
      .insert(entity)
      .values({
        kind: 'custom',
        objectId: object.id,
        canonicalName: name,
        source: 'manual',
        createdBy: userId,
      })
      .returning({ id: entity.id })
      .then((rows) => rows[0]),
  )
  yield* birthValuesEffect({
    entityId: row.id,
    actor: input.actor,
    supplied: input.values,
  })
  yield* query(() =>
    db.insert(activity).values({
      actorId: userId,
      verb: 'record.created',
      subjectEntityId: row.id,
    }),
  )
  return { id: row.id }
})
