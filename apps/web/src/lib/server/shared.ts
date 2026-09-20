import { getRequest } from '@tanstack/react-start/server'
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '@spaces/db'
import {
  attribute,
  document,
  entity,
  entitySpace,
  integration,
  interaction,
  interactionEntity,
  link,
  objectDef,
  space,
} from '@spaces/db/schema'
import type { SourceClass } from '@spaces/db/schema'
import type { DocumentKind } from '@spaces/core/documents'

/** Closed JSON type — Start's serializer rejects `unknown`. */
export type { Json } from '#/lib/json'

export async function requireUser() {
  const session = await auth.api.getSession({
    headers: getRequest().headers,
  })
  if (!session) throw new Error('Unauthorized')
  return session.user
}

/**
 * canWrite's admin gate. Admin owns: settings, integrations, keys, user
 * management (CONTEXT.md). Everything else any member writes — a two-person
 * fund has no ceremony.
 */
export async function requireAdmin() {
  const u = await requireUser()
  if (u.role !== 'admin') throw new Error('Admins only')
  return u
}

/**
 * `canRead` and `provenanceOf` take no request context, so they live outside
 * `lib/server/` where the helpers that need them can import them without
 * dragging `getRequest` into the client bundle (SPA-155). Re-exported here so
 * the server-fn modules keep importing them from where they always did.
 */
export { canRead } from '#/lib/notes/visibility'
export { provenanceOf } from '#/lib/entities/provenance'

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
): Promise<string> {
  return db.transaction(async (tx) => {
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
 * The pipeline→portfolio seam: a deal reaching Invested births a holding
 * (CONTEXT.md phase 15). Idempotent — one holding per company, follow-ons
 * land on the existing row. Lives here (not server/portfolio.ts) because
 * the deal-stage write path needs it and the barrel must never export
 * non-serverFn helpers.
 */
export async function birthHolding(opts: {
  companyId: string
  actorId: string
  openedAt?: string | undefined
}): Promise<{ id: string; created: boolean }> {
  const { holding } = await import('@spaces/db/schema/portfolio')
  const { activity } = await import('@spaces/db/schema/activity')
  const openedAt = opts.openedAt ?? new Date().toISOString().slice(0, 10)
  const inserted = await db
    .insert(holding)
    .values({ companyId: opts.companyId, openedAt, createdBy: opts.actorId })
    .onConflictDoNothing()
    .returning({ id: holding.id })
  if (inserted.length > 0) {
    await db.insert(activity).values({
      actorId: opts.actorId,
      verb: 'holding.created',
      subjectEntityId: opts.companyId,
    })
    return { id: inserted[0].id, created: true }
  }
  const [existing] = await db
    .select({ id: holding.id })
    .from(holding)
    .where(eq(holding.companyId, opts.companyId))
  return { id: existing.id, created: false }
}

/** Latest interaction per entity — the "last touched" signal for tables. */
export async function lastTouchedMap(): Promise<
  Record<string, string | undefined>
> {
  const rows = await db
    .select({
      entityId: interactionEntity.entityId,
      last: sql<string>`max(${interaction.occurredAt})`,
    })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .groupBy(interactionEntity.entityId)
  return Object.fromEntries(
    rows.map((r) => [r.entityId, new Date(r.last).toISOString()]),
  )
}

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
 * Backlinks both ways (§9), the incoming half: every record whose
 * record-reference attribute points at this entity. One query for every
 * entity kind — `getObjectRecord` renders it flat as "Referenced by", the
 * person page groups it by attribute (`groupReferencedBy`). It lives here
 * rather than beside either caller because `src/lib/server-fns.ts`
 * re-exports the domain files wholesale to the client (CLAUDE.md) and this
 * is a server helper, not a serverFn — which is also what makes it directly
 * testable. Merged-away referrers are excluded: a backlink to a tombstone
 * is noise, and the survivor already carries the repointed link.
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
  label: string
  items: Array<{
    id: string
    name: string
    kind: string
    objectSlug: string | null
    objectSingular: string | null
  }>
}

/**
 * A backlink group's heading, from data alone: the attribute's display name
 * carries the verb, the referring object's plural the noun. "Referred by"
 * on deals reads "Referred deals"; a later `champion` reads "Champion
 * deals" — no page edit, and no slug in the markup. The trailing "by" is
 * the only word of English in it; a link whose attribute has since been
 * deleted falls back to the slug.
 */
function backlinkLabel(row: ReferencedByRow): string {
  const verb = (row.attrName ?? row.attrSlug.replace(/_/g, ' '))
    .replace(/\s+by$/i, '')
    .trim()
  const noun = (row.objectPlural ?? `${row.kind}s`).toLowerCase()
  return verb ? `${verb} ${noun}` : noun
}

/**
 * Inbound references grouped by the attribute that made them, so a second
 * record-reference attribute pointing at the same record gets its own
 * heading for free. The grouping is `attr_slug`, never a hard-coded slug.
 */
export function groupReferencedBy(
  rows: Array<ReferencedByRow>,
): Array<ReferencedByGroup> {
  const groups = new Map<string, ReferencedByGroup>()
  for (const row of rows) {
    const existing = groups.get(row.attrSlug)
    const group = existing ?? {
      attrSlug: row.attrSlug,
      label: backlinkLabel(row),
      items: [],
    }
    group.items.push({
      id: row.fromId,
      name: row.name,
      kind: row.kind,
      objectSlug: row.objectSlug,
      objectSingular: row.objectSingular,
    })
    if (!existing) groups.set(row.attrSlug, group)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The same question for documents, asked in bulk (SPA-137).
 *
 * A document carries its own provenance pair rather than borrowing its
 * entity row's: the bytes and the record are two different arrivals — a deck
 * a connector filed against a company a human created — and
 * `docs/spec-storage-sources.md` §2 lists provenance as an axis of the
 * document, not of its entity.
 *
 * Bulk because the Files tab reads a list, and one row at a time would be
 * one query per file. Left join for the same reason `provenanceOf` uses one:
 * every non-integration document's ref is null, and
 * `document_source_ref_invariant` is what makes that a fact.
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
 * Every edge one document is filed by — the two tables together (SPA-50).
 *
 * The Files tab's filing control renders chips for both kinds, so the list
 * has to arrive with the row rather than behind a second round trip per
 * document: a tab with twelve files would otherwise open twelve requests to
 * draw twelve popovers nobody has clicked yet.
 *
 * `objectSlug` rides along for the same reason every other record list
 * carries it — `recordPath` needs a custom record's object to route, and the
 * client has nowhere else to get it.
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
 * Where a document is filed (SPA-19). Two mechanisms, never mixed, exactly
 * the split notes already carry (CONTEXT.md → Sources are documents): a
 * record files through `link(tagged_in)`, a space files through
 * `entity_space`, which is what gives a space-filed document the
 * source/confidence provenance every other member of a space has.
 *
 * It is a discriminated union rather than a bare uuid because the old
 * `attachTo: string` made "a space is a link target" expressible, and the
 * whole of migration 0008 was undoing that for notes. Here the caller has to
 * say which mechanism it means, and the writer checks the entity agrees.
 */
export type DocumentFilingTarget =
  { kind: 'record'; entityId: string } | { kind: 'space'; entityId: string }

/**
 * Why this entity may not take this filing, or `null` if it may. Pure and
 * shared, so the server fn's early refusal and the writer's own guard cannot
 * drift apart — the server fn refuses before the storage probe's cost is
 * spent, the writer refuses whoever calls it without one.
 *
 * `space` and `document` are the two refusals on the record side: a space is
 * filed *into*, and a document filed against a document is a mention.
 */
export function documentFilingRefusal(
  target: DocumentFilingTarget,
  entityKind: string,
): string | null {
  if (target.kind === 'space') {
    return entityKind === 'space'
      ? null
      : `A document files into a space through entity_space — that target is a ${entityKind}.`
  }
  if (entityKind === 'space')
    return 'A space is filed into, not against — file the document into it.'
  if (entityKind === 'document')
    return 'A document is filed against a record, not against another document.'
  return null
}

/**
 * The document already filed at this target with these bytes, if there is
 * one — the dedupe guard behind `finalizeDocumentUpload`. Same file, same
 * target, twice is one row: a second drop is almost always a double-click.
 *
 * It reads the edge table the filing *would* write, which is the half that
 * had to change with the union. Keyed on `link` alone it could never dedupe
 * a space, so a space-filed deck re-dropped would have become a second
 * document row sharing the blob — the §3.4 rule read backwards.
 *
 * Filed on a company and then into a space is the other side of that rule
 * and stays two rows on one blob: different target, different filing.
 */
export async function existingDocumentFiling(
  sha: string,
  target: DocumentFilingTarget,
): Promise<string | null> {
  const rows =
    target.kind === 'record'
      ? await db
          .select({ id: document.entityId })
          .from(document)
          .innerJoin(link, eq(link.fromEntityId, document.entityId))
          .where(
            and(
              eq(document.blobSha, sha),
              eq(link.toEntityId, target.entityId),
              eq(link.relation, 'tagged_in'),
            ),
          )
      : await db
          .select({ id: document.entityId })
          .from(document)
          .innerJoin(entitySpace, eq(entitySpace.entityId, document.entityId))
          .where(
            and(
              eq(document.blobSha, sha),
              eq(entitySpace.spaceId, target.entityId),
            ),
          )
  return rows.at(0)?.id ?? null
}

/**
 * The rows a filed document is made of — entity, document, the filing edge,
 * the activity line — behind the `finalizeDocumentUpload` server fn, and
 * here for `birthHolding`'s reason: `src/lib/server-fns.ts` re-exports the
 * domain files wholesale to the client (CLAUDE.md), so a helper that is not
 * a serverFn cannot live beside the server fn that calls it.
 *
 * `source_class: 'manual'` with no ref: a person dropped a file on the Files
 * tab, which is the plainest `manual` write in the product, and the
 * biconditional would reject a ref anyway. A connector filing the same bytes
 * would call this with the pair set the other way round — the point of the
 * collapse is that the two differ by a row id, not by an enum value nobody
 * outside core can add.
 *
 * The activity row says `document.filed` with the *target* as subject for
 * both kinds: the record's timeline and the space's read the same verb, and
 * a second verb per mechanism would buy nothing but a join rule.
 */
export async function fileDocumentRow(input: {
  sha: string
  filename: string
  mime: string | null
  sizeBytes: number
  kind: DocumentKind
  fileAgainst: DocumentFilingTarget
  actorId: string
}): Promise<{ id: string }> {
  const { activity } = await import('@spaces/db/schema/activity')
  const target = input.fileAgainst
  return db.transaction(async (tx) => {
    // Read inside the transaction: the kind decides which table the edge
    // goes in, so a target that is not what the caller said it was must
    // take the whole insert down with it rather than leave a half-filed row.
    const targetRow = (
      await tx
        .select({ kind: entity.kind })
        .from(entity)
        .where(eq(entity.id, target.entityId))
    ).at(0)
    if (!targetRow) throw new Error('Record not found')
    const refusal = documentFilingRefusal(target, targetRow.kind)
    if (refusal) throw new Error(refusal)

    const [ent] = await tx
      .insert(entity)
      .values({
        kind: 'document',
        canonicalName: input.filename,
        createdBy: input.actorId,
      })
      .returning({ id: entity.id })

    await tx.insert(document).values({
      entityId: ent.id,
      blobSha: input.sha,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      kind: input.kind,
      sourceClass: 'manual',
      uploadedBy: input.actorId,
    })

    if (target.kind === 'record') {
      // Attachment goes through `link` — document.entity_id is the
      // document's own identity, not the record it belongs to.
      await tx.insert(link).values({
        fromEntityId: ent.id,
        toEntityId: target.entityId,
        relation: 'tagged_in',
        source: 'manual',
        createdBy: input.actorId,
      })
    } else {
      // `source: 'manual'` and a `created_by`: a person dropped this file
      // into this space, which is the same provenance an AI-suggested tag
      // would carry with `source: 'ai'` and a confidence.
      await tx.insert(entitySpace).values({
        entityId: ent.id,
        spaceId: target.entityId,
        source: 'manual',
        createdBy: input.actorId,
      })
    }

    await tx.insert(activity).values({
      actorId: input.actorId,
      verb: 'document.filed',
      subjectEntityId: target.entityId,
      objectEntityId: ent.id,
      meta: { filename: input.filename, kind: input.kind },
    })

    return { id: ent.id }
  })
}

/**
 * Delete one document and, if nothing else points at its bytes, the blob.
 *
 * The rows are the registry's answer, not this file's: `deleteEntityProgram`
 * walks `ENTITY_REFS`, which is what already clears `entity_space` alongside
 * `document_chunk`, `link` and `activity` — the hand-list that used to live
 * in `deleteDocument` missed exactly that table, which is why a
 * space-filed document could not be deleted before SPA-77.
 *
 * It lives here rather than in the server fn so a test can delete without a
 * request (SPA-155): the server fn is the auth check and nothing else.
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

  const { deleteEntityProgram } = await import('#/lib/entities/delete')
  const { effectFn } = await import('./effect')
  await effectFn(deleteEntityProgram)(id)

  if (row.blobSha) {
    // Content addressing means one file can back several rows: the deck sent
    // to both partners, or the same deck filed on a company and a space.
    const [{ value: remaining }] = await db
      .select({ value: count() })
      .from(document)
      .where(eq(document.blobSha, row.blobSha))
    if (remaining === 0) {
      const { storage } = await import('#/lib/storage')
      await storage().delete(row.blobSha)
    }
  }
  return { ok: true }
}
