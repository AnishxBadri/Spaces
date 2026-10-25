import { randomBytes } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { account, user, verification } from '@spaces/db/schema/auth'
import { auth } from '#/lib/auth'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'

/**
 * Settings → Members' "Send a reset link…": an admin mints a one-use link
 * that sets a member's password, shown once, because there is no mail.
 * - Better Auth's own `/reset-password` consumes the row, so the link is a
 *   `reset-password:<token>` verification value — stored hashed (the
 *   `verification.storeIdentifier` override), single use by
 *   `consumeVerificationValue`, and every session of the user is revoked on
 *   use (`revokeSessionsOnPasswordReset`).
 * - Outside the server-fn barrel so a test drives it with a real session; it
 *   imports `node:crypto` and the auth instance, so the server fns import it
 *   inside their handlers.
 */

const RESET_TTL_MS = 24 * 60 * 60 * 1000
const PREFIX = 'reset-password:'

export class ResetLinkRefused extends Schema.TaggedError<ResetLinkRefused>()(
  'ResetLinkRefused',
  { message: Schema.String },
) {}

export class ResetLinkQueryFailed extends Schema.TaggedError<ResetLinkQueryFailed>()(
  'ResetLinkQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ResetLinkQueryFailed({ cause }),
  })

function resetUrl(token: string): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/reset?token=${token}`
}

/**
 * Mints the link for `userId`, retiring any earlier one. Refuses the admin
 * themselves (they change their own password signed in), a suspended
 * member, and a user with no password to replace.
 */
export const createResetLinkProgram = Effect.fn('createResetLinkProgram')(
  function* (input: {
    adminId: string
    userId: string
  }): Effect.fn.Return<
    { url: string },
    ResetLinkRefused | ResetLinkQueryFailed
  > {
    if (input.userId === input.adminId)
      return yield* new ResetLinkRefused({
        message: 'You cannot send yourself a reset link.',
      })
    const target = (yield* query(() =>
      db
        .select({ banned: user.banned })
        .from(user)
        .where(eq(user.id, input.userId)),
    )).at(0)
    if (!target)
      return yield* new ResetLinkRefused({ message: 'No such member.' })
    if (target.banned)
      return yield* new ResetLinkRefused({
        message: 'Restore their access before sending a reset link.',
      })
    const credential = (yield* query(() =>
      db
        .select({ id: account.id })
        .from(account)
        .where(
          and(
            eq(account.userId, input.userId),
            eq(account.providerId, 'credential'),
          ),
        ),
    )).at(0)
    if (!credential)
      return yield* new ResetLinkRefused({
        message: 'They sign in without a password, so there is none to reset.',
      })

    // The hashed identifier keeps no `reset-password:` prefix, so a user's
    // earlier links are found by value: a bare user id is the value of reset
    // rows and of nothing else Better Auth stores here.
    yield* query(() =>
      db.delete(verification).where(eq(verification.value, input.userId)),
    )
    const token = randomBytes(24).toString('base64url')
    const ctx = yield* query(() => auth.$context)
    yield* query(() =>
      ctx.internalAdapter.createVerificationValue({
        identifier: `${PREFIX}${token}`,
        value: input.userId,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      }),
    )
    return { url: resetUrl(token) }
  },
)

/**
 * Whether a link still works, without spending it: unexpired, unconsumed,
 * and its user not suspended. Says nothing about whose it is.
 */
export const resetPreviewProgram = Effect.fn('resetPreviewProgram')(function* (
  token: string,
): Effect.fn.Return<{ valid: boolean }, ResetLinkQueryFailed> {
  const ctx = yield* query(() => auth.$context)
  const row = yield* query(() =>
    ctx.internalAdapter.findVerificationValue(`${PREFIX}${token.trim()}`),
  )
  if (!row || row.expiresAt.getTime() <= Date.now()) return { valid: false }
  const target = (yield* query(() =>
    db.select({ banned: user.banned }).from(user).where(eq(user.id, row.value)),
  )).at(0)
  return { valid: target !== undefined && !target.banned }
})

/** `createResetLink`'s body: the session's admin mints the link. */
export async function createResetLinkHandler(data: {
  userId: string
}): Promise<{ url: string }> {
  const admin = await requireAdmin()
  return effectFn(createResetLinkProgram)({
    adminId: admin.id,
    userId: data.userId,
  })
}

/** `getResetPreview`'s body — public, the /reset page runs signed out. */
export function resetPreviewHandler(data: {
  token: string
}): Promise<{ valid: boolean }> {
  return effectFn(resetPreviewProgram)(data.token)
}
