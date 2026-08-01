import { createHash, hkdfSync } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { db } from '#/db'
import { invite, user } from '#/db/schema/auth'
import { clearSetupToken, verifySetupToken } from '#/lib/setup-token'
import { loadMasterKey } from '#/lib/vault/key'

/**
 * Session-signing secret is derived from the master key (HKDF, distinct
 * info label) so the operator manages exactly one secret. BETTER_AUTH_SECRET
 * env still overrides for anyone who wants separate rotation.
 */
function authSecret(): string {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET
  return Buffer.from(
    hkdfSync('sha256', loadMasterKey(), '', 'dealos:better-auth-secret', 32),
  ).toString('base64')
}

/**
 * Auth per CONTEXT.md:
 * - DB-backed revocable sessions, httpOnly cookies.
 * - Roles: admin (settings, integrations, keys, user mgmt) and member.
 * - First run: signup open only while count(user) == 0, guarded server-side,
 *   not by config flag. After that, users arrive via invites (TODO) only.
 * - APP_URL drives baseURL, cookie security, and OAuth redirect URIs —
 *   the reverse-proxy trap (proxy terminates TLS, app sees http) is solved
 *   by trusting APP_URL, not the request.
 */
export const auth = betterAuth({
  baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  secret: authSecret(),
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (newUser, ctx) => {
          const header = (name: string) =>
            ctx?.request?.headers.get(name) ?? ctx?.headers?.get(name) ?? null

          const [{ value: existing }] = await db
            .select({ value: count() })
            .from(user)

          if (existing === 0) {
            // First run. The /setup one-time token is required here, in the
            // hook, because the public signup endpoint would happily bypass
            // any route-level check.
            const token = header('x-setup-token')
            if (!token || !verifySetupToken(token)) {
              throw new Error(
                'Setup token required. It is printed in the server logs.',
              )
            }
            return { data: { ...newUser, role: 'admin' } }
          }

          // Signup is permanently closed; the only way in is an invite.
          const raw = header('x-invite-token')
          if (!raw) {
            throw new Error('Signup is closed. Ask an admin for an invitation.')
          }
          const hash = createHash('sha256').update(raw.trim()).digest('hex')
          const [inv] = await db
            .select()
            .from(invite)
            .where(
              and(
                eq(invite.tokenHash, hash),
                isNull(invite.usedAt),
                gt(invite.expiresAt, new Date()),
              ),
            )
          if (!inv) {
            throw new Error('This invitation is invalid or has expired.')
          }
          if (
            inv.email &&
            inv.email.toLowerCase() !== newUser.email.toLowerCase()
          ) {
            throw new Error('This invitation is for a different email address.')
          }
          return { data: { ...newUser, role: inv.role } }
        },
        after: async (created, ctx) => {
          // First admin exists → the front door closes for good.
          clearSetupToken()
          const raw =
            ctx?.request?.headers.get('x-invite-token') ??
            ctx?.headers?.get('x-invite-token') ??
            null
          if (raw) {
            const hash = createHash('sha256').update(raw.trim()).digest('hex')
            await db
              .update(invite)
              .set({ usedAt: new Date(), usedBy: created.id })
              .where(eq(invite.tokenHash, hash))
          }
        },
      },
    },
  },
  plugins: [
    admin({ defaultRole: 'member', adminRoles: ['admin'] }),
    tanstackStartCookies(),
  ],
})
