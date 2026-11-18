import { Effect, Schema } from 'effect'
import { asc, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, objectDef } from '@spaces/db/schema'
import { coreKindOf, identityKeysOf } from '../../attributes/registry'
import type { ObjectKind } from '../../attributes/registry'
import type { MappingAttribute, MappingRegistry } from '../../import/mapping'

/**
 * One object's registry as the import reads it: the attributes in the
 * order the registry keeps them, archived ones included (the mapping filters
 * them), and the identity keys. The import maps onto it and the workspace
 * export writes its columns from it, so a file the export wrote is a file
 * the import takes back.
 */

export type ImportObject = {
  id: string
  slug: string
  /** The core kind behind a system object; null for a custom one. */
  kind: ObjectKind | null
  singular: string
  plural: string
  archived: boolean
  registry: MappingRegistry
}

export class ImportRegistryFailed extends Schema.TaggedError<ImportRegistryFailed>()(
  'ImportRegistryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ImportRegistryFailed({ cause }),
  })

/** The object and its registry, or null when no such object exists. */
export const importObjectOf = Effect.fn('importObjectOf')(function* (
  objectId: string,
): Effect.fn.Return<ImportObject | null, ImportRegistryFailed> {
  const object = (yield* query(() =>
    db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
        identityKeys: objectDef.identityKeys,
      })
      .from(objectDef)
      .where(eq(objectDef.id, objectId)),
  )).at(0)
  if (object === undefined) return null
  const attributes: Array<MappingAttribute> = yield* query(() =>
    db
      .select({
        id: attribute.id,
        slug: attribute.slug,
        name: attribute.name,
        type: attribute.type,
        options: attribute.options,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.objectId, objectId))
      .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
  )
  return {
    id: object.id,
    slug: object.slug,
    kind: coreKindOf(object),
    singular: object.singular,
    plural: object.plural,
    archived: object.archived,
    registry: { attributes, identityKeys: identityKeysOf(object) },
  }
})
