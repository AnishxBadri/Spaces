import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '#/db'
import { attribute, attributeEvent, entity, link } from '#/db/schema'
import { valueValidator } from './registry'
import type { AttributeDef, ObjectKind } from './registry'

/**
 * The one write path for attribute values. Validates against the registry,
 * diffs, writes entity.values, records attribute_event rows, and syncs
 * record-reference link rows — all in one transaction.
 */

export async function getRegistry(
  kind: ObjectKind,
): Promise<Array<AttributeDef>> {
  const rows = await db
    .select()
    .from(attribute)
    .where(and(eq(attribute.objectKind, kind), eq(attribute.archived, false)))
    .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
  return rows as Array<AttributeDef>
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
 * Patch semantics: keys present are set; null clears; absent keys untouched.
 * Returns the changed slugs (empty patch or no-op diffs write nothing).
 */
export async function setValues(opts: {
  entityId: string
  patch: Record<string, unknown>
  actorId: string
}): Promise<{ changed: Array<string> }> {
  const { entityId, patch, actorId } = opts

  return db.transaction(async (tx) => {
    // FOR UPDATE: this is a read-modify-write of the whole values blob. At
    // READ COMMITTED, two partners editing different attributes of the same
    // record concurrently would both read the same starting blob and the
    // second commit would silently erase the first one's key. The row lock
    // serializes the merges instead.
    const [ent] = await tx
      .select({ id: entity.id, kind: entity.kind, values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
      .for('update')
    if (!ent) throw new Error('Entity not found')
    const kind = ent.kind as ObjectKind
    const registry = await getRegistry(kind)
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
        actorId,
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
