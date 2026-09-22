import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  document,
  entity,
  mandate,
  note,
  term,
} from '@spaces/db/schema'
import { ContextQueryFailed } from './assemble'
import type { CiteLookup } from './cite'
import { parseRef } from './ref'

/**
 * The database half of citation labels: every name `cite.ts` could ask for,
 * for one list of refs, fetched in a handful of set-wise queries and handed
 * back as a pure `CiteLookup`. `cite.ts` stays pure; this is the only file
 * that knows where the names live.
 *
 * Refs may name merged losers (`ref.ts`), so the entity fetch walks
 * `merged_into_id` to the survivor — the lookup carries both the loser's
 * redirect and the winner's name, and `cite.ts` follows the one to the other.
 */

const MAX_MERGE_ROUNDS = 8

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

export const citeLookupProgram = Effect.fn('citeLookupProgram')(function* (
  refs: ReadonlyArray<string>,
): Effect.fn.Return<CiteLookup, ContextQueryFailed> {
  const entityIds = new Set<string>()
  const mandateIds = new Set<string>()
  for (const r of refs) {
    const p = parseRef(r)
    if (p === null) continue
    switch (p.kind) {
      case 'attr':
      case 'note':
      case 'memo':
      case 'doc':
      case 'term':
        entityIds.add(p.entityId)
        break
      case 'mandate':
        mandateIds.add(p.id)
        break
      case 'event':
      case 'interaction':
      case 'task':
        break
    }
  }

  const names = new Map<string, string>()
  const mergedInto = new Map<string, string>()
  const objectOf = new Map<string, string>()
  const byKind = new Map<string, Array<string>>()

  // entities, then whatever they were merged into, until the chain ends
  let pending = [...entityIds]
  const fetched = new Set<string>()
  for (let round = 0; round < MAX_MERGE_ROUNDS && pending.length > 0; round++) {
    const batch = pending
    batch.forEach((id) => fetched.add(id))
    const rows = yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
          objectId: entity.objectId,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(inArray(entity.id, batch)),
    )
    const next = new Set<string>()
    for (const e of rows) {
      names.set(e.id, e.name)
      if (e.objectId) objectOf.set(e.id, e.objectId)
      byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.id])
      if (e.mergedIntoId) {
        mergedInto.set(e.id, e.mergedIntoId)
        if (!fetched.has(e.mergedIntoId)) next.add(e.mergedIntoId)
      }
    }
    pending = [...next]
  }

  // the names a person knows these by, over the entity's canonical name
  const docIds = byKind.get('document') ?? []
  if (docIds.length > 0)
    for (const d of yield* query(() =>
      db
        .select({ id: document.entityId, filename: document.filename })
        .from(document)
        .where(inArray(document.entityId, docIds)),
    ))
      if (d.filename) names.set(d.id, d.filename)
  const noteIds = byKind.get('note') ?? []
  if (noteIds.length > 0)
    for (const n of yield* query(() =>
      db
        .select({ id: note.entityId, title: note.title })
        .from(note)
        .where(inArray(note.entityId, noteIds)),
    ))
      if (n.title) names.set(n.id, n.title)
  const termIds = byKind.get('term') ?? []
  if (termIds.length > 0)
    for (const t of yield* query(() =>
      db
        .select({ id: term.entityId, name: term.name })
        .from(term)
        .where(inArray(term.entityId, termIds)),
    ))
      names.set(t.id, t.name)

  // mandate → its note entity, for the name
  if (mandateIds.size > 0)
    for (const m of yield* query(() =>
      db
        .select({ id: mandate.id, name: entity.canonicalName })
        .from(mandate)
        .innerJoin(entity, eq(entity.id, mandate.noteEntityId))
        .where(inArray(mandate.id, [...mandateIds])),
    ))
      names.set(m.id, m.name)

  // attribute display names on the objects those records belong to
  const attrNames = new Map<string, string>()
  const objectIds = [...new Set(objectOf.values())]
  if (objectIds.length > 0)
    for (const a of yield* query(() =>
      db
        .select({
          objectId: attribute.objectId,
          slug: attribute.slug,
          name: attribute.name,
        })
        .from(attribute)
        .where(inArray(attribute.objectId, objectIds)),
    ))
      attrNames.set(`${a.objectId}:${a.slug}`, a.name)

  return {
    name: (id) => names.get(id),
    mergedInto: (id) => mergedInto.get(id),
    attribute: (entityId, slug) => {
      const objectId = objectOf.get(entityId)
      return objectId === undefined
        ? undefined
        : attrNames.get(`${objectId}:${slug}`)
    },
  }
})
