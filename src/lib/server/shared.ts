import { getRequest } from '@tanstack/react-start/server'
import { eq, sql } from 'drizzle-orm'
import { auth } from '../auth'
import { db } from '#/db'
import { interaction, interactionEntity } from '#/db/schema'

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

/** Latest interaction per entity — the "last touched" signal for tables. */
export async function lastTouchedMap(): Promise<Record<string, string>> {
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
