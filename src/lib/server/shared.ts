import { getRequest } from '@tanstack/react-start/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '#/db'
import { entity, interaction, interactionEntity, space } from '#/db/schema'

/** Closed JSON type — Start's serializer rejects `unknown`. */
export type Json =
  string | number | boolean | null | Array<Json> | { [k: string]: Json }

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
        source: 'manual',
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
  openedAt?: string
}): Promise<{ id: string; created: boolean }> {
  const { holding } = await import('#/db/schema/portfolio')
  const { activity } = await import('#/db/schema/activity')
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
