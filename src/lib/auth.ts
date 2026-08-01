import { hkdfSync } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { count } from 'drizzle-orm'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
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
        before: async (newUser) => {
          const [{ value: existing }] = await db
            .select({ value: count() })
            .from(user)
          if (existing > 0) {
            // Permanently closed after the first admin exists. Invites will
            // create users through a separate, token-gated path.
            throw new Error('Signup is closed. Ask an admin for an invitation.')
          }
          // First user is the admin.
          return { data: { ...newUser, role: 'admin' } }
        },
      },
    },
  },
  plugins: [
    admin({ defaultRole: 'member', adminRoles: ['admin'] }),
    tanstackStartCookies(),
  ],
})
