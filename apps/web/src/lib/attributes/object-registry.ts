import { Cause, Effect, Exit, Option, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity } from '@spaces/db/schema/activity'
import { attribute, attributeEvent, entity, objectDef } from '@spaces/db/schema'
import { birthValuesEffect } from './defaults'
import { createAttributeProgram } from './create'
import {
  CORE_ONLY_IDENTITY_KEYS,
  CORE_ONLY_IDENTITY_MESSAGE,
  IDENTITY_KEYS,
  IDENTITY_KEY_ATTRIBUTES,
} from '@spaces/core/attributes/registry'
import { recordNameAlias } from '#/lib/entities/resolve'
import { sweepNameSimilarityEffect } from '#/lib/entities/sweep'
import { normalizeName } from '@spaces/core/entities/normalize'
import { slugifyNoun, suggestPlural } from '#/lib/object-nouns'
import type { AttributeCreateRejected, Tx } from './create'
import type { AttributeQueryFailed } from './update'
import type {
  ObjectQueryFailed as CoreObjectQueryFailed,
  SystemObjectNotSeeded,
} from './objects'
import type { IdentityKey } from '@spaces/core/attributes/registry'
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
 * documents); of the identity machinery they get fuzzy-name dedupe and
 * merge-as-target (narrowed 2026-09-13) but no enrichment and no
 * interactions — which is why they are born here and never through
 * resolveEntity.
 *
 * They do carry a birth `name` alias and they do join the sweep (SPA-60).
 * That half of the old header — "no aliases, no dedupe sweep" — was the
 * pre-narrowing boundary left behind: a record with only
 * `entity.canonical_name` is invisible to pg_trgm, so "customs get dedupe"
 * was true on paper and dead in the database. The alias is written in the
 * same transaction as the entity row (there is no birth without it), and the
 * sweep scopes by `object_id`, so a Fund is never offered as a duplicate of
 * a Vendor.
 *
 * The one genuinely per-object piece of identity is opt-in: an object may
 * declare `domain` and/or `linkedin` as identity keys, and each declared key
 * materializes its backing attribute in the same transaction (CONTEXT.md
 * "Two-tier object model", 2026-09-19). Nothing is bound later — a key with
 * no attribute behind it would be a promise the write path cannot find.
 *
 * The declaration follows the slug rule (spec §9, §3): revisable while the
 * object has no records, frozen the moment one exists — otherwise a
 * record's alias outlives the key that justified it. Creation and revision
 * go through the same `materializeIdentityKey`, so the two paths cannot
 * drift into two kinds of backing attribute.
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
  /** opt-in identity (§9) — `domain`, `linkedin`, or neither */
  identityKeys?: ReadonlyArray<string> | undefined
  createdBy: string
}

/**
 * Everything object creation can fail with. The attribute half is in the
 * union because a declared identity key creates its backing attribute
 * through `createAttributeProgram`, whose refusals are the same refusals.
 */
export type CreateObjectFailure =
  | ObjectRejected
  | ObjectQueryFailed
  | AttributeCreateRejected
  | AttributeQueryFailed
  | CoreObjectQueryFailed
  | SystemObjectNotSeeded

/** Carries a typed failure out through the transaction's rollback. */
class ObjectRollback extends Error {
  constructor(readonly failure: CreateObjectFailure) {
    super('object creation refused')
    this.name = 'ObjectRollback'
  }
}

const asFailure = (cause: unknown): CreateObjectFailure =>
  cause instanceof ObjectRollback
    ? cause.failure
    : new ObjectQueryFailed({ cause })

/**
 * The declared keys, narrowed. `email` and `cin` are refused by name rather
 * than ignored: a user who ticked them asked for person/company doctrine on
 * a bag, and the reason is the answer.
 */
const readIdentityKeys = Effect.fn('readIdentityKeys')(function* (
  declared: ReadonlyArray<string> | undefined,
): Effect.fn.Return<Array<IdentityKey>, ObjectRejected> {
  const keys: Array<IdentityKey> = []
  for (const raw of declared ?? []) {
    const candidate = raw.trim().toLowerCase()
    if (CORE_ONLY_IDENTITY_KEYS.includes(candidate))
      return yield* new ObjectRejected({ message: CORE_ONLY_IDENTITY_MESSAGE })
    const key = IDENTITY_KEYS.find((k) => k === candidate)
    if (!key)
      return yield* new ObjectRejected({
        message: `"${raw}" is not an identity key — domain and linkedin are the two`,
      })
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
})

/**
 * Materialize one declared key's backing attribute inside the caller's
 * transaction: creation and revision share this step, so a key declared at
 * birth and one declared later are the same attribute, made by the same
 * door — `createAttributeProgram`, which rejects config a type cannot
 * carry. A typed refusal leaves through `ObjectRollback`, so the failure
 * rides the rollback instead of being swallowed by it.
 */
const materializeIdentityKey = async (args: {
  tx: Tx
  objectId: string
  key: IdentityKey
  createdBy: string
}) => {
  const backing = IDENTITY_KEY_ATTRIBUTES[args.key]
  const exit = await Effect.runPromiseExit(
    createAttributeProgram({
      tx: args.tx,
      objectId: args.objectId,
      name: backing.name,
      type: backing.type,
      description: `Identity key — ${backing.help}.`,
      config: { identityKey: args.key },
      createdBy: args.createdBy,
    }),
  )
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause)
    throw new ObjectRollback(
      Option.isSome(failure)
        ? failure.value
        : new ObjectQueryFailed({ cause: Cause.squash(exit.cause) }),
    )
  }
}

/**
 * Undeclaring a key on an empty object deletes its backing attribute row
 * outright rather than archiving it: an object with no records holds no
 * values, so there is nothing an archived column would preserve, and a
 * retired attribute nobody ever wrote to is litter. No table references
 * `attribute.id` — `attribute_event` keys on `(entity_id, attr_slug)` — so
 * the delete cascades into nothing, which is exactly why the event rows are
 * counted first: one would mean the "empty" check lied, and the answer to
 * that is to refuse, never to delete history out from under a record.
 */
const dropBackingAttribute = async (args: {
  tx: Tx
  objectId: string
  key: IdentityKey
  plural: string
}) => {
  // Found by `options.identityKey`, the way the write path finds it — the
  // slug is only ever a consequence of the name, and the name renames.
  const attr = (
    await args.tx
      .select({ id: attribute.id, slug: attribute.slug })
      .from(attribute)
      .where(
        and(
          eq(attribute.objectId, args.objectId),
          sql`${attribute.options} ->> 'identityKey' = ${args.key}`,
        ),
      )
  ).at(0)
  if (!attr) return
  const events = (
    await args.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(attributeEvent)
      .innerJoin(entity, eq(entity.id, attributeEvent.entityId))
      .where(
        and(
          eq(entity.objectId, args.objectId),
          eq(attributeEvent.attrSlug, attr.slug),
        ),
      )
  ).at(0)
  if ((events?.count ?? 0) > 0)
    throw new ObjectRollback(
      new ObjectRejected({
        message: `${args.plural} has ${attr.slug} history — identity keys are frozen`,
      }),
    )
  await args.tx.delete(attribute).where(eq(attribute.id, attr.id))
}

/**
 * Does this object hold a record? A merged-away record counts: it keeps its
 * values and its snapshot, and the merge that retired it is itself a
 * consequence of the identity keys, so the declaration is as frozen by a
 * loser as by a live record (spec §9 — the slug rule).
 */
const objectHasRecords = Effect.fn('objectHasRecords')(function* (
  objectId: string,
): Effect.fn.Return<boolean, ObjectQueryFailed> {
  return yield* query(() =>
    db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.objectId, objectId))
      .limit(1)
      .then((rows) => rows.length > 0),
  )
})

export const createObjectProgram = Effect.fn('createObjectProgram')(function* (
  input: CreateObjectInput,
): Effect.fn.Return<{ id: string; slug: string }, CreateObjectFailure> {
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
  const identityKeys = yield* readIdentityKeys(input.identityKeys)
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
  // One write or neither: the object row and the backing attribute of every
  // key it declares (CONTEXT.md, 2026-09-19). The attributes go in through
  // createAttributeProgram — the door that rejects config a type cannot
  // carry — sharing this transaction rather than a second connection.
  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = (
          await tx
            .insert(objectDef)
            .values({
              slug,
              singular,
              plural,
              icon: input.icon ?? null,
              identityKeys,
              isSystem: false,
              createdBy: input.createdBy,
            })
            .returning({ id: objectDef.id, slug: objectDef.slug })
        )[0]
        for (const key of identityKeys)
          await materializeIdentityKey({
            tx,
            objectId: row.id,
            key,
            createdBy: input.createdBy,
          })
        return row
      }),
    catch: asFailure,
  })
})

/**
 * The nouns and the lifecycle flag are free; `identityKeys` is the whole
 * declaration, not a delta, and carries the actor who declared it because
 * adding a key creates an attribute that someone owns.
 */
type ObjectPatch = {
  id: string
  singular?: string | undefined
  plural?: string | undefined
  icon?: string | null | undefined
  archived?: boolean | undefined
}

export type UpdateObjectInput =
  | (ObjectPatch & { identityKeys: ReadonlyArray<string>; declaredBy: string })
  | (ObjectPatch & { identityKeys?: undefined; declaredBy?: undefined })

export const updateObjectProgram = Effect.fn('updateObjectProgram')(function* (
  input: UpdateObjectInput,
): Effect.fn.Return<{ ok: true }, CreateObjectFailure> {
  const row = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        plural: objectDef.plural,
        identityKeys: objectDef.identityKeys,
        isSystem: objectDef.isSystem,
      })
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

  // Identity keys follow the slug rule (spec §9): revisable while the object
  // has no records, frozen the moment one exists. A no-op declaration is not
  // a change, so re-saving the dialog on a populated object is not a refusal.
  const declaration =
    input.identityKeys === undefined
      ? null
      : {
          keys: yield* readIdentityKeys(input.identityKeys),
          declaredBy: input.declaredBy,
        }
  const added = declaration
    ? declaration.keys.filter((k) => !row.identityKeys.includes(k))
    : []
  const removed = declaration
    ? row.identityKeys.filter((k) => !declaration.keys.includes(k))
    : []

  if (declaration && (added.length > 0 || removed.length > 0)) {
    // Core identity lives in entity_alias under resolution rules, not in
    // this column — there is nothing here for a system object to declare.
    if (row.isSystem)
      return yield* new ObjectRejected({
        message: 'System objects own their identity in code',
      })
    if (yield* objectHasRecords(row.id))
      return yield* new ObjectRejected({
        message: `${row.plural} has records — identity keys are frozen`,
      })
    // One write or neither, as at creation: the column and every backing
    // attribute the revision adds or drops move together.
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          for (const key of removed)
            await dropBackingAttribute({
              tx,
              objectId: row.id,
              key,
              plural: row.plural,
            })
          for (const key of added)
            await materializeIdentityKey({
              tx,
              objectId: row.id,
              key,
              createdBy: declaration.declaredBy,
            })
          await tx
            .update(objectDef)
            .set({ ...patch, identityKeys: declaration.keys })
            .where(eq(objectDef.id, row.id))
        }),
      catch: asFailure,
    })
    return { ok: true }
  }

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
 * Birth of a custom record: an entity row and its `name` alias, in one
 * transaction, then the same birth-values pass every record gets (supplied
 * first, defaults for the blanks), then the fuzzy sweep every other record
 * gets. The alias is non-identity — a custom object's identity keys are
 * opt-in and still unbuilt — but it is what puts the record in front of
 * pg_trgm and in `searchEntities`' alias lane.
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
  // One transaction: an entity whose name alias failed to land would be a
  // record the sweep cannot see and search cannot reach by its birth name.
  const row = yield* query(() =>
    db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({
          kind: 'custom',
          objectId: object.id,
          canonicalName: name,
          sourceClass: 'manual',
          createdBy: userId,
        })
        .returning({ id: entity.id })
      // Stamped exactly as `resolveEntity` stamps a manual birth alias —
      // `manual`, no integration ref, `is_identity` false.
      await recordNameAlias(ent.id, name, { class: 'manual' }, tx)
      return ent
    }),
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
  // Probabilistic, suggestion-only, and never fatal: the record exists by
  // now, so a failing sweep must not report the creation as failed. Same
  // stance `resolveEntity` takes, said in Effect.
  yield* sweepNameSimilarityEffect(row.id, normalizeName(name)).pipe(
    Effect.catch((cause) =>
      Effect.logError('[objects] fuzzy sweep failed', cause),
    ),
  )
  return { id: row.id }
})
