import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entityAlias, objectDef } from '@spaces/db/schema'
import type { EntitySearchInput } from '#/lib/server/search'

/**
 * The query behind `searchEntities`, minus the request context, so it can
 * be exercised without a session — which is how SPA-63 pins that a renamed
 * record is still reachable by its previous name.
 *
 * It lives outside `lib/server/` because a plain export from a
 * `lib/server/*.ts` module keeps its imports alive in the client bundle
 * (SPA-155); only the server fn that wraps it stays in `server/search.ts`.
 */
export async function entitySearchRows(
  userId: string,
  data: EntitySearchInput,
) {
  const q = data.q.trim()
  if (!q) return []
  const pattern = `%${q}%`
  return db
    .selectDistinctOn([entity.id], {
      id: entity.id,
      name: entity.canonicalName,
      kind: entity.kind,
      // Custom records route through their object's slug; core kinds
      // carry it too, harmlessly.
      objectSlug: objectDef.slug,
    })
    .from(entity)
    .leftJoin(entityAlias, eq(entityAlias.entityId, entity.id))
    .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
    .where(
      and(
        isNull(entity.mergedIntoId),
        // The default lane excludes nothing by kind (SPA-27). It used to end
        // `ne(entity.kind, 'document')`, which is what kept a deck out of the
        // note-body @ menu — and the note editor is the only caller that
        // omits `kinds`, so widening it widens exactly that one menu. Every
        // other caller (log-interaction, value-editor, the record-filing
        // picker) names its kinds and is unchanged.
        data.objectId
          ? eq(entity.objectId, data.objectId)
          : data.kinds
            ? inArray(entity.kind, data.kinds)
            : undefined,
        // canRead at the SQL layer: a private note's title must not
        // surface in anyone else's autocomplete.
        sql`not exists (select 1 from note pn where pn.entity_id = ${entity.id} and pn.visibility = 'private' and pn.author_id <> ${userId})`,
        sql`(${entity.canonicalName} ilike ${pattern} or (${entityAlias.kind} = 'name' and ${entityAlias.valueNorm} ilike ${pattern}))`,
      ),
    )
    .limit(8)
}
