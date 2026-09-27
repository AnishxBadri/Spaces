import { and, count, eq, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { session, user } from '@spaces/db/schema/auth'
import { requireAdmin } from '#/lib/server/shared'

/**
 * `setMemberBanned`'s body — Settings → Members' "Suspend access" and
 * "Restore access" — out of `lib/server/` so a test can call it with the
 * request stubbed (CLAUDE.md, SPA-155). Suspension is how a member leaves
 * the workspace: the `user` row stays (their notes, events and suggestions
 * still name an author), `banned` flips, and every live session is deleted.
 * The ban is what every credential checks — Better Auth's admin plugin at
 * login, and `authenticateBearerProgram` for an MCP token (SPA-28 tests the
 * token half through here).
 */
export async function setMemberBannedHandler(data: {
  userId: string
  banned: boolean
}): Promise<{ ok: true }> {
  const admin = await requireAdmin()
  if (data.userId === admin.id) {
    throw new Error('You cannot ban yourself.')
  }
  if (data.banned) {
    // Same lockout as demotion: banning the last active admin bricks
    // the workspace just as surely.
    const target = (
      await db
        .select({ role: user.role })
        .from(user)
        .where(eq(user.id, data.userId))
    ).at(0)
    if (target?.role === 'admin') {
      const [{ value: otherAdmins }] = await db
        .select({ value: count() })
        .from(user)
        .where(
          and(
            eq(user.role, 'admin'),
            eq(user.banned, false),
            ne(user.id, data.userId),
          ),
        )
      if (otherAdmins === 0) {
        throw new Error('Cannot ban the only active admin.')
      }
    }
  }
  await db
    .update(user)
    .set({ banned: data.banned, updatedAt: new Date() })
    .where(eq(user.id, data.userId))
  if (data.banned) {
    await db.delete(session).where(eq(session.userId, data.userId))
  }
  return { ok: true }
}
