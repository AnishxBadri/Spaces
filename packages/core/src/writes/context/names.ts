import { Effect } from 'effect'
import { eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import {
  attribute,
  document,
  entity,
  mandate,
  note,
  term,
} from '@spaces/db/schema'
import { ContextQueryFailed } from '../../context/errors'
import { cite } from '../../context/cite'
import type { CiteLookup } from '../../context/cite'
import { parseRef } from '../../context/ref'

/**
 * The one ref resolver (SPA-18 built the lookup, SPA-119 made it the reader):
 * stored refs — `suggestion.refs`, `attribute_event.refs`, a Context item's
 * ref — in, `{ref, entityId, label, missing}` out. `cite.ts` is the only
 * renderer and stays pure; this is the only file that knows where the names
 * live, and the only caller of `cite()`. Nothing else in `src` formats a ref.
 *
 * - **Merges.** Ids inside refs may be merged losers (`ref.ts`). A merge
 *   flattens chains at write time (`entity.merged_into_id` always names a
 *   survivor), so one hop is the whole walk — the rule `canonicalId` in
 *   `lib/entities/sweep.ts` reads — and it is taken in the same query that
 *   fetches the entity, through a self-join.
 * - **Re-chunks.** `doc:<id>#<idx>` names the document, not a chunk row, so a
 *   re-chunk leaves the ref resolving to the same document; the index may now
 *   point at different text, and that is the accepted trade.
 * - **Deletes.** A target that is gone resolves `missing: true` with a label
 *   that says so. Nothing throws on a missing row.
 * - **Cost.** One query per kind of lookup, never one per ref: the entities
 *   (with their survivors), then document filenames, note titles, term
 *   names, attribute display names and mandates — each only when a ref needs
 *   it. Twenty refs cost what two do.
 */

export type ResolvedRef = {
  ref: string
  /**
   * The record the citation lands on — the survivor for a merged loser, the
   * mandate's note for a mandate ref. Null for a ref that names no entity
   * (event, interaction, task, an id outside the grammar) and for a missing
   * target.
   */
  entityId: string | null
  /** What a person reads — `cite.ts`, or {@link MISSING_LABEL}. */
  label: string
  /** The target was deleted. */
  missing: boolean
}

/** A citation whose target no longer exists. */
export const MISSING_LABEL = 'no longer here'

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

const survivorEntity = alias(entity, 'survivor')

type Loaded = {
  lookup: CiteLookup
  /** Every ref'd entity id that exists → the survivor it lands on. */
  landsOn: Map<string, string>
  /** Every ref'd mandate id that exists → its note entity. */
  mandateNote: Map<string, string>
}

const loadRefNames = Effect.fn('loadRefNames')(function* (
  refs: ReadonlyArray<string>,
): Effect.fn.Return<Loaded, ContextQueryFailed> {
  const entityIds = new Set<string>()
  const mandateIds = new Set<string>()
  const attrEntityIds = new Set<string>()
  for (const r of refs) {
    const p = parseRef(r)
    if (p === null) continue
    switch (p.kind) {
      case 'attr':
        attrEntityIds.add(p.entityId)
        entityIds.add(p.entityId)
        break
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
  const landsOn = new Map<string, string>()
  const byKind = new Map<string, Set<string>>()

  // Each ref'd entity with the survivor it redirects to, in one round trip.
  // A loser whose survivor is gone has no survivor row, and lands nowhere.
  if (entityIds.size > 0) {
    const rows = yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
          objectId: entity.objectId,
          mergedIntoId: entity.mergedIntoId,
          survivorId: survivorEntity.id,
          survivorKind: survivorEntity.kind,
          survivorName: survivorEntity.canonicalName,
          survivorObjectId: survivorEntity.objectId,
        })
        .from(entity)
        .leftJoin(survivorEntity, eq(survivorEntity.id, entity.mergedIntoId))
        .where(inArray(entity.id, [...entityIds])),
    )
    for (const e of rows) {
      let head: {
        id: string
        kind: string
        name: string
        objectId: string | null
      }
      if (e.mergedIntoId === null)
        head = { id: e.id, kind: e.kind, name: e.name, objectId: e.objectId }
      else if (
        e.survivorId !== null &&
        e.survivorKind !== null &&
        e.survivorName !== null
      ) {
        head = {
          id: e.survivorId,
          kind: e.survivorKind,
          name: e.survivorName,
          objectId: e.survivorObjectId,
        }
        mergedInto.set(e.id, e.survivorId)
      } else continue
      landsOn.set(e.id, head.id)
      names.set(head.id, head.name)
      if (head.objectId !== null) objectOf.set(head.id, head.objectId)
      const ids = byKind.get(head.kind) ?? new Set<string>()
      ids.add(head.id)
      byKind.set(head.kind, ids)
    }
  }

  // the names a person knows these by, over the entity's canonical name
  const docIds = [...(byKind.get('document') ?? [])]
  if (docIds.length > 0)
    for (const d of yield* query(() =>
      db
        .select({ id: document.entityId, filename: document.filename })
        .from(document)
        .where(inArray(document.entityId, docIds)),
    ))
      if (d.filename) names.set(d.id, d.filename)
  const noteIds = [...(byKind.get('note') ?? [])]
  if (noteIds.length > 0)
    for (const n of yield* query(() =>
      db
        .select({ id: note.entityId, title: note.title })
        .from(note)
        .where(inArray(note.entityId, noteIds)),
    ))
      if (n.title) names.set(n.id, n.title)
  const termIds = [...(byKind.get('term') ?? [])]
  if (termIds.length > 0)
    for (const t of yield* query(() =>
      db
        .select({ id: term.entityId, name: term.name })
        .from(term)
        .where(inArray(term.entityId, termIds)),
    ))
      names.set(t.id, t.name)

  // mandate → its note entity, for the name and for where the citation lands
  const mandateNote = new Map<string, string>()
  if (mandateIds.size > 0)
    for (const m of yield* query(() =>
      db
        .select({
          id: mandate.id,
          noteId: entity.id,
          name: entity.canonicalName,
        })
        .from(mandate)
        .innerJoin(entity, eq(entity.id, mandate.noteEntityId))
        .where(inArray(mandate.id, [...mandateIds])),
    )) {
      names.set(m.id, m.name)
      mandateNote.set(m.id, m.noteId)
    }

  // attribute display names, on the objects an attr ref's record belongs to
  const objectIds = new Set<string>()
  for (const id of attrEntityIds) {
    const at = landsOn.get(id)
    const objectId = at === undefined ? undefined : objectOf.get(at)
    if (objectId !== undefined) objectIds.add(objectId)
  }
  const attrNames = new Map<string, string>()
  if (objectIds.size > 0)
    for (const a of yield* query(() =>
      db
        .select({
          objectId: attribute.objectId,
          slug: attribute.slug,
          name: attribute.name,
        })
        .from(attribute)
        .where(inArray(attribute.objectId, [...objectIds])),
    ))
      attrNames.set(`${a.objectId}:${a.slug}`, a.name)

  return {
    landsOn,
    mandateNote,
    lookup: {
      name: (id) => names.get(id),
      mergedInto: (id) => mergedInto.get(id),
      attribute: (entityId, slug) => {
        const objectId = objectOf.get(entityId)
        return objectId === undefined
          ? undefined
          : attrNames.get(`${objectId}:${slug}`)
      },
    },
  }
})

/**
 * Resolve every ref, in input order (duplicates kept), in a bounded number of
 * queries. Fails only on the database — never on a target that is gone.
 */
export const resolveRefsProgram = Effect.fn('resolveRefsProgram')(function* (
  refs: ReadonlyArray<string>,
): Effect.fn.Return<Array<ResolvedRef>, ContextQueryFailed> {
  if (refs.length === 0) return []
  const { lookup, landsOn, mandateNote } = yield* loadRefNames(refs)
  const landed = (r: string, entityId: string | undefined): ResolvedRef =>
    entityId === undefined
      ? { ref: r, entityId: null, label: MISSING_LABEL, missing: true }
      : { ref: r, entityId, label: cite(r, lookup), missing: false }
  const unlanded = (r: string): ResolvedRef => ({
    ref: r,
    entityId: null,
    label: cite(r, lookup),
    missing: false,
  })
  return refs.map((r) => {
    const p = parseRef(r)
    if (p === null) return unlanded(r)
    switch (p.kind) {
      case 'attr':
      case 'note':
      case 'memo':
      case 'doc':
      case 'term':
        return landed(r, landsOn.get(p.entityId))
      case 'mandate':
        return landed(r, mandateNote.get(p.id))
      case 'event':
      case 'interaction':
      case 'task':
        return unlanded(r)
    }
  })
})
