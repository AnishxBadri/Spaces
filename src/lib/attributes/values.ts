import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '#/db'
import { attribute, attributeEvent, entity, link } from '#/db/schema'
import type { attributeEventSource } from '#/db/schema'
import type { EntityValues } from '#/db/schema/entities'
import type { Json } from '#/lib/json'
import { resolveDefault } from './default-values'
import { objectIdForKindAsync } from './objects'
import { toObjectKind, valueValidator } from './registry'
import type { AttributeDef, ObjectKind } from './registry'

/**
 * The one write path for attribute values. Validates against the registry,
 * diffs, writes entity.values, records attribute_event rows, and syncs
 * record-reference link rows — all in one transaction.
 *
 * Effect-first per the backend-paradigm ratchet (converted in SPA-6, the
 * first behavioral change to the engine after the rule landed): planning is
 * a pure program with typed failures; the transaction applies the plan.
 * `setValues` is the Promise seam for server-fns and tests.
 */

export async function getRegistryByObjectId(
  objectId: string,
): Promise<Array<AttributeDef>> {
  const rows = await db
    .select()
    .from(attribute)
    .where(and(eq(attribute.objectId, objectId), eq(attribute.archived, false)))
    .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
  return rows
}

export async function getRegistry(
  kind: ObjectKind,
): Promise<Array<AttributeDef>> {
  return getRegistryByObjectId(await objectIdForKindAsync(kind))
}

/**
 * A rejected value. `message` is `slug: detail` so a toast reads well on
 * its own; the record rail strips the prefix when it renders inline.
 */
export class AttributeValidationError extends Schema.TaggedError<AttributeValidationError>()(
  'AttributeValidationError',
  { slug: Schema.String, message: Schema.String },
) {}

export class EntityNotFound extends Schema.TaggedError<EntityNotFound>()(
  'EntityNotFound',
  { entityId: Schema.String, message: Schema.String },
) {}

export class ValuesWriteFailed extends Schema.TaggedError<ValuesWriteFailed>()(
  'ValuesWriteFailed',
  { cause: Schema.Defect() },
) {}

const invalid = (slug: string, detail: string) =>
  new AttributeValidationError({ slug, message: `${slug}: ${detail}` })

/**
 * Who attended to a write (spec §4). `user` carries the user FK; `integration`
 * gains an id when the integration table lands; `system` is the merge
 * executor and seeds — rewrites no person asserted.
 */
export type Actor =
  { type: 'user'; id: string } | { type: 'integration' } | { type: 'system' }

export type EventSource = (typeof attributeEventSource.enumValues)[number]

type Change = {
  slug: string
  def: AttributeDef
  before: Json
  value: Json
  /** set when the change came from a default rather than the patch */
  door?: 'default'
}

/**
 * Pure: registry + current values + patch → the changes to apply. Patch
 * semantics: keys present are set; null (or '' / undefined) clears; absent
 * keys are untouched; no-op diffs drop out.
 *
 * `required` means can't-clear, nothing more (spec §5, grilled 2026-09):
 * an explicit clear of a required attribute is rejected for every type. A
 * record may still be *born* without the value — creation completeness is
 * the create dialog's concern, and machine writes and imports legitimately
 * create partial records. Clearing an already-empty required field is a
 * no-op, not an error: there is nothing to clear.
 */
export const planPatch = Effect.fn('planPatch')(function* (
  registry: Array<AttributeDef>,
  current: EntityValues,
  patch: Record<string, unknown>,
): Effect.fn.Return<Array<Change>, AttributeValidationError> {
  const bySlug = new Map(registry.map((d) => [d.slug, d]))
  const changes: Array<Change> = []

  for (const [slug, raw] of Object.entries(patch)) {
    const def = bySlug.get(slug)
    if (!def) return yield* invalid(slug, 'Unknown attribute')

    let value: Json = null
    if (raw !== undefined && raw !== null && raw !== '') {
      const parsed = valueValidator(def, current[slug]).safeParse(raw)
      if (!parsed.success) {
        return yield* invalid(
          slug,
          parsed.error.issues[0]?.message ?? 'Invalid value',
        )
      }
      value = parsed.data
    }

    const before = current[slug] ?? null
    if (JSON.stringify(before) === JSON.stringify(value)) continue

    if (value === null && def.options.required) {
      return yield* invalid(slug, "Required — can't be cleared")
    }

    changes.push({ slug, def, before, value })
  }
  return changes
})

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Referenced records must exist, be alive, and match the target kind. */
async function checkReferences(tx: Tx, change: Change) {
  const { def, slug, value } = change
  if (def.type !== 'record_reference' || value === null) return
  const ids = (Array.isArray(value) ? value : [value]).map(String)
  if (ids.length === 0) return
  const targets = await tx
    .select({
      id: entity.id,
      kind: entity.kind,
      objectId: entity.objectId,
      merged: entity.mergedIntoId,
    })
    .from(entity)
    .where(inArray(entity.id, ids))
  if (targets.length !== ids.length)
    throw invalid(slug, 'Referenced record not found')
  for (const t of targets) {
    // Targets stay single-object (§6): a core kind for the system objects,
    // an object row for custom ones — the picker just lists more objects.
    if (def.options.targetObjectId) {
      if (t.objectId !== def.options.targetObjectId)
        throw invalid(slug, 'Must reference a record of the target object')
    } else if (t.kind !== def.options.targetKind) {
      throw invalid(slug, `Must reference a ${def.options.targetKind}`)
    }
    if (t.merged) throw invalid(slug, 'Referenced record was merged')
  }
}

/**
 * Provenance rides the event row: `source` names the door the write came
 * through (default: a direct human edit), `suggestionId` and `refs` carry
 * the receipt when a suggestion or enrichment is accepted.
 */
export type SetValuesInput = {
  entityId: string
  patch: Record<string, unknown>
  actor: Actor
  source?: EventSource
  suggestionId?: string
  refs?: Array<string>
  /**
   * Birth mode (spec §4): after the patch, fill every still-blank attribute
   * that carries a default, logged through the `default` door — inside the
   * same transaction and registry read as the supplied values.
   */
  fillDefaults?: { now: Date }
}

export const setValuesEffect = Effect.fn('setValues')(function* (
  opts: SetValuesInput,
): Effect.fn.Return<
  { changed: Array<string>; defaulted: Array<string> },
  AttributeValidationError | EntityNotFound | ValuesWriteFailed
> {
  const {
    entityId,
    patch,
    actor,
    source = 'direct',
    suggestionId,
    refs,
    fillDefaults,
  } = opts
  const actorId = actor.type === 'user' ? actor.id : null

  return yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        // FOR UPDATE: this is a read-modify-write of the whole values blob.
        // At READ COMMITTED, two partners editing different attributes of
        // the same record concurrently would both read the same starting
        // blob and the second commit would silently erase the first one's
        // key. The row lock serializes the merges instead.
        const ent = (
          await tx
            .select({
              id: entity.id,
              kind: entity.kind,
              objectId: entity.objectId,
              values: entity.values,
            })
            .from(entity)
            .where(eq(entity.id, entityId))
            .for('update')
        ).at(0)
        if (!ent)
          throw new EntityNotFound({ entityId, message: 'Entity not found' })
        // objectId is the registry key; kind fallback covers rows created
        // outside the creation server-fns (tests, raw inserts) — core kinds
        // resolve to their system object row.
        let objectId = ent.objectId
        if (objectId === null) {
          const core = toObjectKind(ent.kind)
          if (core === null)
            throw new EntityNotFound({
              entityId,
              message: `No attribute registry for kind ${ent.kind}`,
            })
          objectId = await objectIdForKindAsync(core)
        }
        const registry = await getRegistryByObjectId(objectId)
        const current = ent.values

        // Planning is synchronous and pure; a typed failure surfaces as a
        // throw here and is passed through untouched by the catch below.
        const changes = Effect.runSync(planPatch(registry, current, patch))

        // Birth mode: defaults for whatever the patch left blank, planned
        // against the same registry snapshot and written through their own
        // door. Supplied values always win — a default never touches a slug
        // the patch named.
        if (fillDefaults) {
          const afterPatch = { ...current }
          for (const c of changes) {
            if (c.value === null) delete afterPatch[c.slug]
            else afterPatch[c.slug] = c.value
          }
          const userId = actor.type === 'user' ? actor.id : null
          const defaultPatch: Record<string, unknown> = {}
          for (const def of registry) {
            if (def.slug in patch) continue
            // Absent and null both mean "blank" — a default fills either.
            if ((afterPatch[def.slug] ?? null) !== null) continue
            const v = resolveDefault(def, { now: fillDefaults.now, userId })
            if (v !== undefined) defaultPatch[def.slug] = v
          }
          for (const c of Effect.runSync(
            planPatch(registry, afterPatch, defaultPatch),
          ))
            changes.push({ ...c, door: 'default' })
        }

        const next = { ...current }
        for (const change of changes) {
          await checkReferences(tx, change)
          const { slug, def, before, value } = change
          if (value === null) delete next[slug]
          else next[slug] = value

          const viaDefault = change.door === 'default'
          await tx.insert(attributeEvent).values({
            entityId,
            attrSlug: slug,
            from: before,
            to: value,
            actorType: actor.type,
            actorId,
            source: viaDefault ? 'default' : source,
            suggestionId: viaDefault ? null : (suggestionId ?? null),
            refs: viaDefault ? null : (refs ?? null),
          })

          // Materialize record-references into the graph (values
          // authoritative).
          if (def.type === 'record_reference') {
            await tx
              .delete(link)
              .where(
                and(
                  eq(link.fromEntityId, entityId),
                  eq(link.relation, 'references'),
                  eq(link.attrSlug, slug),
                ),
              )
            const ids: Array<string> =
              value === null
                ? []
                : (Array.isArray(value) ? value : [value]).map(String)
            for (const target of ids) {
              await tx
                .insert(link)
                .values({
                  fromEntityId: entityId,
                  toEntityId: target,
                  relation: 'references',
                  attrSlug: slug,
                  source: 'manual',
                  createdBy: actorId,
                })
                .onConflictDoNothing()
            }
          }
        }

        if (changes.length > 0) {
          await tx
            .update(entity)
            .set({ values: next })
            .where(eq(entity.id, entityId))
        }
        return {
          changed: changes
            .filter((c) => c.door !== 'default')
            .map((c) => c.slug),
          defaulted: changes
            .filter((c) => c.door === 'default')
            .map((c) => c.slug),
        }
      }),
    catch: (cause) =>
      cause instanceof AttributeValidationError ||
      cause instanceof EntityNotFound
        ? cause
        : new ValuesWriteFailed({ cause }),
  })
})

/** Promise seam for server-fns and tests; new Effect code composes `setValuesEffect`. */
export const setValues = (
  opts: SetValuesInput,
): Promise<{ changed: Array<string>; defaulted: Array<string> }> =>
  Effect.runPromise(setValuesEffect(opts))
