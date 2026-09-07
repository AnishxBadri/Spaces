import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '#/db'
import { attribute, attributeEvent, entity, link } from '#/db/schema'
import type { attributeEventSource } from '#/db/schema'
import { objectIdForKindAsync } from './objects'
import { valueValidator } from './registry'
import type { AttributeDef, ObjectKind } from './registry'

/**
 * The one write path for attribute values. Validates against the registry,
 * diffs, writes entity.values, records attribute_event rows, and syncs
 * record-reference link rows — all in one transaction.
 */

export async function getRegistryByObjectId(
  objectId: string,
): Promise<Array<AttributeDef>> {
  const rows = await db
    .select()
    .from(attribute)
    .where(and(eq(attribute.objectId, objectId), eq(attribute.archived, false)))
    .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
  return rows as Array<AttributeDef>
}

export async function getRegistry(
  kind: ObjectKind,
): Promise<Array<AttributeDef>> {
  return getRegistryByObjectId(await objectIdForKindAsync(kind))
}

export class AttributeValidationError extends Error {
  constructor(
    public slug: string,
    message: string,
  ) {
    super(`${slug}: ${message}`)
  }
}

/**
 * Who attended to a write (spec §4). `user` carries the user FK; `integration`
 * gains an id when the integration table lands; `system` is the merge
 * executor and seeds — rewrites no person asserted.
 */
export type Actor =
  { type: 'user'; id: string } | { type: 'integration' } | { type: 'system' }

export type EventSource = (typeof attributeEventSource.enumValues)[number]

/**
 * Patch semantics: keys present are set; null clears; absent keys untouched.
 * Returns the changed slugs (empty patch or no-op diffs write nothing).
 *
 * Provenance rides the event row: `source` names the door the write came
 * through (default: a direct human edit), `suggestionId` and `refs` carry
 * the receipt when a suggestion or enrichment is accepted.
 */
export async function setValues(opts: {
  entityId: string
  patch: Record<string, unknown>
  actor: Actor
  source?: EventSource
  suggestionId?: string
  refs?: Array<string>
}): Promise<{ changed: Array<string> }> {
  const { entityId, patch, actor, source = 'direct', suggestionId, refs } = opts
  const actorId = actor.type === 'user' ? actor.id : null

  return db.transaction(async (tx) => {
    // FOR UPDATE: this is a read-modify-write of the whole values blob. At
    // READ COMMITTED, two partners editing different attributes of the same
    // record concurrently would both read the same starting blob and the
    // second commit would silently erase the first one's key. The row lock
    // serializes the merges instead.
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
    if (!ent) throw new Error('Entity not found')
    // objectId is the registry key; kind fallback covers rows created
    // outside the creation server-fns (tests, raw inserts) — core kinds
    // resolve to their system object row.
    const objectId =
      ent.objectId ?? (await objectIdForKindAsync(ent.kind as ObjectKind))
    const registry = await getRegistryByObjectId(objectId)
    const bySlug = new Map(registry.map((d) => [d.slug, d]))
    const current = (ent.values ?? {}) as Record<string, unknown>

    const next = { ...current }
    const changed: Array<string> = []

    for (const [slug, raw] of Object.entries(patch)) {
      const def = bySlug.get(slug)
      if (!def) throw new AttributeValidationError(slug, 'Unknown attribute')

      let value: unknown = raw
      if (value === undefined || value === null || value === '') value = null
      if (value !== null) {
        const parsed = valueValidator(def).safeParse(value)
        if (!parsed.success) {
          throw new AttributeValidationError(
            slug,
            parsed.error.issues[0]?.message ?? 'Invalid value',
          )
        }
        value = parsed.data
      }
      if (
        value === null &&
        def.type === 'record_reference' &&
        def.options.required
      ) {
        throw new AttributeValidationError(slug, 'Required')
      }

      const before = current[slug] ?? null
      if (JSON.stringify(before) === JSON.stringify(value)) continue

      // Referenced records must exist, be alive, and match the target kind.
      if (def.type === 'record_reference' && value !== null) {
        const ids = Array.isArray(value) ? value : [value as string]
        if (ids.length > 0) {
          const targets = await tx
            .select({
              id: entity.id,
              kind: entity.kind,
              merged: entity.mergedIntoId,
            })
            .from(entity)
            .where(inArray(entity.id, ids))
          if (targets.length !== ids.length)
            throw new AttributeValidationError(
              slug,
              'Referenced record not found',
            )
          for (const t of targets) {
            if (t.kind !== def.options.targetKind)
              throw new AttributeValidationError(
                slug,
                `Must reference a ${def.options.targetKind}`,
              )
            if (t.merged)
              throw new AttributeValidationError(
                slug,
                'Referenced record was merged',
              )
          }
        }
      }

      if (value === null) delete next[slug]
      else next[slug] = value
      changed.push(slug)

      await tx.insert(attributeEvent).values({
        entityId,
        attrSlug: slug,
        from: before,
        to: value,
        actorType: actor.type,
        actorId,
        source,
        suggestionId: suggestionId ?? null,
        refs: refs ?? null,
      })

      // Materialize record-references into the graph (values authoritative).
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
        const ids =
          value === null ? [] : Array.isArray(value) ? value : [value as string]
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

    if (changed.length > 0) {
      await tx
        .update(entity)
        .set({ values: next })
        .where(eq(entity.id, entityId))
    }
    return { changed }
  })
}
