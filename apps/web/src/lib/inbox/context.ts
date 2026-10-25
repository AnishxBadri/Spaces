import { and, count, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  entity,
  entityAlias,
  entitySpace,
  link,
  objectDef,
} from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema/entities'
import { normalizeName } from '@spaces/sdk/identity'
import { normalizeIdentityValue } from '@spaces/core/writes/entities/resolve'
import { provenanceOf } from '@spaces/core/writes/entities/provenance'
import { nonEmptyValueCount } from './keeper'

/**
 * One side of an inbox pair, read off the record.
 *
 * Outside the server-fn modules because the suite drives `entityContext`
 * directly, and a plain export there keeps its imports alive in the client
 * bundle; the inbox server module re-exports only the type.
 */

/**
 * The domain a record *says* it has when it holds no domain alias.
 *
 * The colliding side of an identity pair lost the claim, so it owns no
 * `entity_alias` row; without this the card's Domain row would read "—" for
 * the very record that caused the pair. The value is still in
 * `entity.values`, under whichever slug that object declared as its `domain`
 * identity key, resolved here because an object names its own attributes.
 *
 * Core pairs are untouched by construction: the system company/person
 * objects carry no attribute with `options.identityKey`, so this answers
 * null for them and the card's alias lane is what renders.
 */
async function identityDomainOf(
  objectId: string | null,
  values: EntityValues,
): Promise<string | null> {
  if (objectId === null) return null
  const def = (
    await db
      .select({ slug: attribute.slug })
      .from(attribute)
      .where(
        and(
          eq(attribute.objectId, objectId),
          eq(attribute.archived, false),
          sql`${attribute.options} ->> 'identityKey' = 'domain'`,
        ),
      )
      .limit(1)
  ).at(0)
  if (!def) return null
  const raw = values[def.slug]
  if (typeof raw !== 'string' || raw.trim() === '') return null
  // Said in the same normal form the alias lane beside it is printed in,
  // so the two columns are comparable rather than merely both populated.
  return normalizeIdentityValue('domain', raw) ?? raw.trim()
}

export async function entityContext(id: string) {
  // The object row is left-joined, not looked up by kind: a custom record's
  // noun is its object's `singular`, and core rows carry an object row too
  // (`CORE_OBJECTS`), so one join answers for both. Research kinds — notes,
  // documents, terms — have no object row and answer null.
  const head = (
    await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        createdAt: entity.createdAt,
        objectId: entity.objectId,
        values: entity.values,
        objectSlug: objectDef.slug,
        objectSingular: objectDef.singular,
      })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(eq(entity.id, id))
  ).at(0)
  if (!head) throw new Error('Record not found')
  // `objectId` and the values blob are read, not shipped: they answer the
  // identity-domain fallback and the value count below, and a whole
  // record's values on every side of every pair is payload for no reader.
  const { objectId, values, ...card } = head
  // Provenance is a pair, and half an answer on its own: "integration"
  // names no integration. `provenanceOf` resolves the
  // ref to the capability id the operator installed.
  const provenance = await provenanceOf(id)
  const aliases = await db
    .select({ kind: entityAlias.kind, valueNorm: entityAlias.valueNorm })
    .from(entityAlias)
    .where(eq(entityAlias.entityId, id))
  const mentionCount =
    (
      await db
        .select({ value: count() })
        .from(link)
        .where(and(eq(link.toEntityId, id), eq(link.relation, 'mentions')))
    ).at(0)?.value ?? 0
  const spaceRows = await db
    .select({ name: entity.canonicalName })
    .from(entitySpace)
    .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
    .where(eq(entitySpace.entityId, id))
  return {
    ...card,
    ...provenance,
    createdAt: card.createdAt.toISOString(),
    domains: aliases.filter((a) => a.kind === 'domain').map((a) => a.valueNorm),
    identityDomain: await identityDomainOf(objectId, values),
    // "Other" is measured in the same normal form the aliases are written
    // in — `normalizeName`, not lowercase. Lowercasing leaves the legal
    // suffix on ("acme inc" vs the alias "acme"), so a record would list
    // its own current name as something it was also seen as. Renames write
    // a name alias, so every record has that row.
    otherNames: aliases
      .filter(
        (a) => a.kind === 'name' && a.valueNorm !== normalizeName(card.name),
      )
      .map((a) => a.valueNorm),
    mentionCount,
    // What `defaultKeeper` ranks first.
    valueCount: nonEmptyValueCount(values),
    spaces: spaceRows.map((s) => s.name),
  }
}

/** One side of a pair: the record plus everything the card compares. */
export type InboxSide = Awaited<ReturnType<typeof entityContext>>
