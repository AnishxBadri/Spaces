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
