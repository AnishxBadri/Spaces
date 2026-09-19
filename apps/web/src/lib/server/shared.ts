import { getRequest } from '@tanstack/react-start/server'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '@spaces/db'
import {
  attribute,
  document,
  entity,
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
 * canRead, as a predicate. Policy is deliberately trivial (2026-08): shared
 * unless private-and-not-yours. Private applies to note bodies (and later
 * interaction bodies) only. The point of the choke point is that it exists
 * — every read path routes through it before any richer policy needs it.
 */
export function canRead(
  user: { id: string },
  row: { visibility?: string | null; authorId?: string | null },
): boolean {
  if (row.visibility !== 'private') return true
  return row.authorId === user.id
}

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

/**
 * Who wrote a record, resolved to a word a reader recognises.
 *
 * The class alone is only half an answer for one of the eight values:
 * "integration" names no integration. `source_ref` is the other half, and
 * it is exactly the row the operator installed, so the label for a plugin
 * write is its capability id — "apollo", the word on the Integrations page
 * — and for the other seven classes it is the class itself. The left join
 * is a left join because a non-integration row's ref is null by
 * construction; `entity_source_ref_invariant` is what makes that a fact and
 * not a habit.
 *
 * Here rather than beside its one caller because `src/lib/server-fns.ts`
 * re-exports the domain files wholesale to the client (CLAUDE.md) and this
 * is a server helper, not a serverFn — which is also what makes it
 * directly testable.
 */
export async function provenanceOf(entityId: string): Promise<{
  sourceClass: SourceClass
  sourceCapability: string | null
  label: string
}> {
  const row = (
    await db
      .select({
        sourceClass: entity.sourceClass,
        sourceCapability: integration.capabilityId,
      })
      .from(entity)
      .leftJoin(integration, eq(integration.id, entity.sourceRef))
      .where(eq(entity.id, entityId))
  ).at(0)
  if (!row) throw new Error('Entity not found')
  return { ...row, label: row.sourceCapability ?? row.sourceClass }
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
 * The rows a filed document is made of — entity, document, the `tagged_in`
 * edge, the activity line — behind the `finalizeDocumentUpload` server fn,
 * and here for `writeInteraction`'s reason.
 *
 * `source_class: 'manual'` with no ref: a person dropped a file on the Files
 * tab, which is the plainest `manual` write in the product, and the
 * biconditional would reject a ref anyway. A connector filing the same bytes
 * would call this with the pair set the other way round — the point of the
 * collapse is that the two differ by a row id, not by an enum value nobody
 * outside core can add.
 */
export async function fileDocumentRow(input: {
  sha: string
  filename: string
  mime: string | null
  sizeBytes: number
  kind: DocumentKind
  attachTo: string
  actorId: string
}): Promise<{ id: string }> {
  const { activity } = await import('@spaces/db/schema/activity')
  return db.transaction(async (tx) => {
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

    // Attachment goes through `link` — document.entity_id is the document's
    // own identity, not the record it belongs to.
    await tx.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: input.attachTo,
      relation: 'tagged_in',
      source: 'manual',
      createdBy: input.actorId,
    })

    await tx.insert(activity).values({
      actorId: input.actorId,
      verb: 'document.filed',
      subjectEntityId: input.attachTo,
      objectEntityId: ent.id,
      meta: { filename: input.filename, kind: input.kind },
    })

    return { id: ent.id }
  })
}

/**
 * The interaction write behind the `logInteraction` server fn. Here rather
 * than beside it for `birthHolding`'s reason: `src/lib/server-fns.ts`
 * re-exports the domain files wholesale to the client (CLAUDE.md), so a
 * helper that is not a serverFn cannot live in `server/interactions.ts` —
 * and this is also what makes the write directly testable.
 *
 * `source_class: 'manual'` is written as a literal, not left to the column
 * default: a person filling in the Log-interaction dialog is the clearest
 * `manual` writer in the product, and a row whose provenance is whatever the
 * default happened to be is not a claim anyone checked.
 */
export async function writeInteraction(input: {
  kind: 'meeting' | 'call'
  subject: string
  occurredAt: Date
  attendeeIds: Array<string>
  actorId: string
}): Promise<{ id: string }> {
  const { activity } = await import('@spaces/db/schema/activity')
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(interaction)
      .values({
        kind: input.kind,
        sourceClass: 'manual',
        subject: input.subject,
        occurredAt: input.occurredAt,
      })
      .returning({ id: interaction.id })
    for (const entityId of new Set(input.attendeeIds)) {
      await tx
        .insert(interactionEntity)
        .values({ interactionId: row.id, entityId })
        .onConflictDoNothing()
    }
    await tx.insert(activity).values({
      actorId: input.actorId,
      verb: `interaction.${input.kind}`,
      subjectEntityId: input.attendeeIds[0],
      meta: { interactionId: row.id },
    })
    return { id: row.id }
  })
}
