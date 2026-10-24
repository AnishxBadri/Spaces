import { and, eq, exists, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { company, entity, person } from '@spaces/db/schema'
import type { SQL } from 'drizzle-orm'

/**
 * Which `entity` rows a list page lists, before any view condition: the
 * subtype guard, the kind, and "not merged away".
 * Spelled once so a view chip's count and the page it opens cannot disagree.
 * A new list surface adds an arm here, not a copy of a `where`.
 */
export type ListScope =
  | { kind: 'company' }
  | { kind: 'person' }
  | { kind: 'deal' }
  | { kind: 'custom'; objectId: string }

export function listScope(scope: ListScope): SQL {
  const live = isNull(entity.mergedIntoId)
  switch (scope.kind) {
    case 'company':
      // The subtype row is the guard; as an `exists` it cannot multiply a row.
      return and(
        eq(entity.kind, 'company'),
        exists(
          db
            .select({ one: sql`1` })
            .from(company)
            .where(eq(company.entityId, entity.id)),
        ),
        live,
      )!
    case 'person':
      // `/people` filters on the subtype row alone, never on `entity.kind`.
      return and(
        exists(
          db
            .select({ one: sql`1` })
            .from(person)
            .where(eq(person.entityId, entity.id)),
        ),
        live,
      )!
    case 'deal':
      return and(eq(entity.kind, 'deal'), live)!
    case 'custom':
      return and(
        eq(entity.objectId, scope.objectId),
        eq(entity.kind, 'custom'),
        live,
      )!
  }
}
