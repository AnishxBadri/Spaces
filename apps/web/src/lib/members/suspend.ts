import { Effect, Schema } from 'effect'
import { and, count, eq, ne } from 'drizzle-orm'
import { db } from '@spaces/db'
import { session, user } from '@spaces/db/schema/auth'
import { requireAdminProgram } from '#/lib/server/shared'
import { membersQuery } from './query'

/** A suspension the workspace refuses: oneself, or the last active admin. */
export class SuspendRefused extends Schema.TaggedError<SuspendRefused>()(
  'SuspendRefused',
  { message: Schema.String },
) {}

/**
 * `setMemberBanned`'s body (Settings → Members' Suspend/Restore access),
 * outside the server-fn barrel so a test calls it with the request stubbed.
 * - Suspension is how a member leaves: the `user` row stays (authorship),
 *   `banned` flips, and every live session is deleted.
 * - Every credential checks the ban: Better Auth at login, and
 *   `authenticateBearerProgram` for an MCP token.
 */
export const setMemberBannedProgram = Effect.fn('setMemberBannedProgram')(
  function* (data: { userId: string; banned: boolean }) {
    const admin = yield* requireAdminProgram()
    if (data.userId === admin.id) {
      return yield* new SuspendRefused({ message: 'You cannot ban yourself.' })
    }
    if (data.banned) {
      // Same lockout as demotion: banning the last active admin bricks
      // the workspace just as surely.
      const target = (yield* membersQuery(() =>
        db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, data.userId)),
      )).at(0)
      if (target?.role === 'admin') {
        const [{ value: otherAdmins }] = yield* membersQuery(() =>
          db
            .select({ value: count() })
            .from(user)
            .where(
              and(
                eq(user.role, 'admin'),
                eq(user.banned, false),
                ne(user.id, data.userId),
              ),
            ),
        )
        if (otherAdmins === 0) {
          return yield* new SuspendRefused({
            message: 'Cannot ban the only active admin.',
          })
        }
      }
    }
    yield* membersQuery(() =>
      db
        .update(user)
        .set({ banned: data.banned, updatedAt: new Date() })
        .where(eq(user.id, data.userId)),
    )
    if (data.banned) {
      yield* membersQuery(() =>
        db.delete(session).where(eq(session.userId, data.userId)),
      )
    }
    return { ok: true as const }
  },
)

/** `setMemberBannedProgram` for a caller that is not Effect. */
export async function setMemberBannedHandler(data: {
  userId: string
  banned: boolean
}): Promise<{ ok: true }> {
  return Effect.runPromise(setMemberBannedProgram(data))
}
