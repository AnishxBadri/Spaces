import { getRequest } from '@tanstack/react-start/server'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '@spaces/db'
import {
  attribute,
  document,
  documentRevision,
  entity,
  entitySpace,
  integration,
  link,
  objectDef,
  space,
} from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import type { RelationHalf } from '@spaces/core/writes/read/relations'

/** Closed JSON type — Start's serializer rejects `unknown`. */
export type { Json } from '@spaces/core/json'

export async function requireUser() {
  const session = await auth.api.getSession({
    headers: getRequest().headers,
  })
  if (!session) throw new Error('Unauthorized')
  return session.user
}

/**
 * canWrite's admin gate. Admin owns settings, integrations, keys and user
 * management. Everything else any member writes; a two-person fund has no
 * ceremony.
 */
export async function requireAdmin() {
  const u = await requireUser()
  if (u.role !== 'admin') throw new Error('Admins only')
  return u
}

/**
 * A settings page's read: any signed-in member may read an admin page, and
 * `isAdmin` says whether its secrets are shown or redacted. Its writes keep
 * `requireAdmin()`.
 */
export async function requireSettingsReader(): Promise<{ isAdmin: boolean }> {
  const u = await requireUser()
  return { isAdmin: u.role === 'admin' }
}

/**
 * `canRead` and `provenanceOf` take no request context, so they live outside
 * the server-fn modules, where helpers can import them without dragging
 * `getRequest` into the client bundle. Re-exported for the server fns.
 */
export { canRead } from '@spaces/core/read-policy'
export { provenanceOf } from '@spaces/core/writes/entities/provenance'

/** ltree labels: [a-z0-9_] only. */
export function toLabel(name: string): string {
  const label = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return label || 'space'
}

/**
 * Space creation, shared by the createSpace server fn and the scaffold
 * stamper. Slugs are unique per parent (two branches may both hold a
 * "Cooling"); only a genuine same-parent collision gets a suffix.
 */
export async function createSpaceRow(
  name: string,
  parentId: string | null,
  userId: string,
  /** An open transaction to create it inside; its own otherwise. */
  within: Pick<typeof db, 'transaction'> = db,
): Promise<string> {
  return within.transaction(async (tx) => {
    let parentPath: string | null = null
    if (parentId) {
      const parent = (
        await tx
          .select({ path: space.path })
          .from(space)
          .where(eq(space.entityId, parentId))
      ).at(0)
      if (!parent) throw new Error('Parent space not found')
      parentPath = parent.path
    }
    const base = toLabel(name)
    const siblingOf = parentId
      ? eq(space.parentId, parentId)
      : isNull(space.parentId)
    let slug = base
    for (let i = 2; ; i++) {
      const existing = await tx
        .select({ id: space.entityId })
        .from(space)
        .where(and(siblingOf, eq(space.slug, slug)))
      if (existing.length === 0) break
      slug = `${base}_${i}`
    }
    const [ent] = await tx
      .insert(entity)
      .values({
        kind: 'space',
        canonicalName: name,
        sourceClass: 'manual',
        createdBy: userId,
      })
      .returning({ id: entity.id })
    await tx.insert(space).values({
      entityId: ent.id,
      parentId,
      slug,
      path: parentPath ? `${parentPath}.${slug}` : slug,
    })
    return ent.id
  })
}

/**
 * The pipeline→portfolio seam. It lives outside this module because a deal
 * birth needs it inside its transaction and the import worker cannot reach
 * this module; re-exported for the server fns.
 */
export { birthHolding } from '#/lib/portfolio/holding'

/** One inbound `references` edge: the record pointing here, and its labels. */
export type ReferencedByRow = {
  fromId: string
  attrSlug: string
  attrName: string | null
  name: string
  kind: string
  objectSlug: string | null
  objectSingular: string | null
  objectPlural: string | null
}

/**
 * Backlinks, the incoming half: every record whose record-reference attribute
 * points at this entity, for every entity kind. `getObjectRecord` renders it
 * flat; the person page groups it with `groupReferencedBy`.
 * - A server helper, not a serverFn, so it is testable without a request.
 * - Merged-away referrers are excluded: the survivor carries the link.
 */
export async function referencedByRows(
  entityId: string,
): Promise<Array<ReferencedByRow>> {
  return (
    db
      .select({
        fromId: link.fromEntityId,
        attrSlug: link.attrSlug,
        attrName: attribute.name,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
        objectSingular: objectDef.singular,
        objectPlural: objectDef.plural,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      // The attribute that made the edge, on the referrer's own object: its
      // display name is the only thing a heading needs that the link lacks.
      .leftJoin(
        attribute,
        and(
          eq(attribute.objectId, entity.objectId),
          eq(attribute.slug, link.attrSlug),
        ),
      )
      .where(
        and(
          eq(link.toEntityId, entityId),
          eq(link.relation, 'references'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(link.attrSlug), asc(entity.canonicalName))
  )
}

/** Inbound references under one attribute, ready to render as a section. */
export type ReferencedByGroup = {
  attrSlug: string
  /** The referring object's plural — the section title ("Deals"). */
  label: string
  /** The attribute that made the link — the head's meta ("Referred by"). */
  via: string
  items: Array<{
    id: string
    name: string
    kind: string
    objectSlug: string | null
    objectSingular: string | null
  }>
}

/**
 * A backlink group's heading, from data alone: the referring object's plural
 * is the title, the attribute's display name the `via`. No sentence is built
 * from the two, so any attribute name reads right ("People", "Champion").
 * A link whose attribute has since been deleted falls back to the slug.
 */
function backlinkLabel(row: ReferencedByRow): { label: string; via: string } {
  const plural = row.objectPlural ?? `${row.kind}s`
  return {
    label: plural.charAt(0).toUpperCase() + plural.slice(1),
    via: row.attrName ?? row.attrSlug.replace(/_/g, ' '),
  }
}

/**
 * Inbound references grouped by the object and attribute that made them, so
 * a second record-reference attribute pointing at the same record gets its
 * own section for free. Never a hard-coded slug.
 */
export function groupReferencedBy(
  rows: Array<ReferencedByRow>,
): Array<ReferencedByGroup> {
  const groups = new Map<string, ReferencedByGroup>()
  for (const row of rows) {
    const key = `${row.objectSlug ?? row.kind}:${row.attrSlug}`
    const existing = groups.get(key)
    const group = existing ?? {
      attrSlug: row.attrSlug,
      ...backlinkLabel(row),
      items: [],
    }
    group.items.push({
      id: row.fromId,
      name: row.name,
      kind: row.kind,
      objectSlug: row.objectSlug,
      objectSingular: row.objectSingular,
    })
    if (!existing) groups.set(key, group)
  }
  return [...groups.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.via.localeCompare(b.via),
  )
}

/**
 * Backlinks less the ones a relationship's inverse half already shows: an
 * owner's link to this record reads under the derived attribute.
 */
export function withoutRelations(
  rows: Array<ReferencedByRow>,
  halves: ReadonlyArray<RelationHalf>,
): Array<ReferencedByRow> {
  const shown = new Set(
    halves
      .filter((h) => h.derived)
      .flatMap((h) => h.items.map((i) => `${i.id}:${h.linkSlug}`)),
  )
  return rows.filter((r) => !shown.has(`${r.fromId}:${r.attrSlug}`))
}

/**
 * `provenanceOf` for documents, in bulk (the Files tab reads a list).
 * - A document carries its own provenance pair, not its entity row's: the
 *   bytes and the record can be two different arrivals.
 * - Left join: every non-integration document's ref is null, which
 *   `document_source_ref_invariant` guarantees.
 */
export async function documentProvenance(
  documentIds: Array<string>,
): Promise<
  Map<string, { sourceClass: SourceClass; sourceCapability: string | null }>
> {
  if (documentIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: document.entityId,
      sourceClass: document.sourceClass,
      sourceCapability: integration.capabilityId,
    })
    .from(document)
    .leftJoin(integration, eq(integration.id, document.sourceRef))
    .where(inArray(document.entityId, documentIds))
  return new Map(
    rows.map((r) => [
      r.id,
      { sourceClass: r.sourceClass, sourceCapability: r.sourceCapability },
    ]),
  )
}

/**
 * Every edge one document is filed by, from both tables. It arrives with the
 * row so the Files tab's chips need no round trip per document.
 * `objectSlug` is there because `recordPath` needs it to route a custom record.
 */
export type DocumentFilingEdge =
  | {
      kind: 'record'
      id: string
      name: string
      entityKind: string
      objectSlug: string | null
    }
  | { kind: 'space'; id: string; name: string }

/**
 * Bulk, like `documentProvenance` and for the same reason. A merged-away
 * target is left out: it has a surviving record, and a chip pointing at the
 * tombstone would route to a page the merge redirects away from.
 */
export async function documentFilingEdges(
  documentIds: Array<string>,
): Promise<Map<string, Array<DocumentFilingEdge>>> {
  const edges = new Map<string, Array<DocumentFilingEdge>>()
  if (documentIds.length === 0) return edges

  const [records, spaces] = await Promise.all([
    db
      .select({
        documentId: link.fromEntityId,
        id: entity.id,
        name: entity.canonicalName,
        entityKind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          inArray(link.fromEntityId, documentIds),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
    db
      .select({
        documentId: entitySpace.entityId,
        id: entity.id,
        name: entity.canonicalName,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
      .where(inArray(entitySpace.entityId, documentIds))
      .orderBy(asc(entity.canonicalName)),
  ])

  const push = (documentId: string, edge: DocumentFilingEdge) => {
    const list = edges.get(documentId)
    if (list) list.push(edge)
    else edges.set(documentId, [edge])
  }
  for (const r of records) {
    push(r.documentId, {
      kind: 'record',
      id: r.id,
      name: r.name,
      entityKind: r.entityKind,
      objectSlug: r.objectSlug,
    })
  }
  for (const s of spaces) {
    push(s.documentId, { kind: 'space', id: s.id, name: s.name })
  }
  return edges
}

/**
 * Where a document is filed, and why a target refuses a filing. Pure;
 * re-exported for the server fns, re-file and the upload dialog.
 */
export { documentFilingRefusal } from '@spaces/core/documents/filing'
export type { DocumentFilingTarget } from '@spaces/core/documents/filing'

/**
 * Delete one document and, if nothing else points at its bytes, the blob.
 * - The rows are `deleteEntityProgram`'s answer, which walks `ENTITY_REFS`;
 *   never hand-list tables here.
 * - Outside the server fn so a test can delete without a request.
 */
export async function deleteDocumentWithBlobGc(
  id: string,
): Promise<{ ok: true }> {
  const row = (
    await db
      .select({ blobSha: document.blobSha })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)
  if (!row) return { ok: true }
  // Its prior revisions go with it, so their bytes are candidates too.
  const revisions = await db
    .select({ blobSha: documentRevision.blobSha })
    .from(documentRevision)
    .where(eq(documentRevision.documentId, id))

  const { deleteEntityProgram } =
    await import('@spaces/core/writes/entities/delete')
  const { effectFn } = await import('./effect')
  await effectFn(deleteEntityProgram)(id)

  // Content addressing means one file can back several rows: the deck sent
  // to both partners, or the same deck filed on a company and a space.
  // `blobIsReferenced` is the one definition of "still referenced", shared
  // with the orphan sweep; the reclaim takes the blob's derived rows with it.
  const shas = new Set(revisions.map((r) => r.blobSha))
  if (row.blobSha) shas.add(row.blobSha)
  if (shas.size > 0) {
    const { reclaimBlobIfOrphaned } = await import('#/lib/documents/blob-refs')
    for (const sha of shas) await reclaimBlobIfOrphaned(sha)
  }
  return { ok: true }
}
