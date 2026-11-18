import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { account, rateLimit, user } from '@spaces/db/schema/auth'
import { CLIENT_IP_HEADER, clientIp, withClientIp } from './client-ip'

/**
 * Sign-in's rate limit against the real Better Auth instance and its
 * Postgres store: requests go through `auth.handler` exactly as
 * `/api/auth/$` hands them on, the client address in `CLIENT_IP_HEADER`.
 */

vi.hoisted(() => {
  // A fixed secret keeps the auth module off the master-key file in CI.
  process.env.BETTER_AUTH_SECRET ??=
    'rate-limit-test-secret-rate-limit-test-secret'
})

const { auth } = await import('#/lib/auth')

const MEMBER = { id: 'rl-member', email: 'rl-member@spaces.test' }
const PASSWORD = 'correct horse battery'

let base = ''

beforeAll(async () => {
  const ctx = await auth.$context
  base = ctx.baseURL
  await db.insert(user).values({ ...MEMBER, name: 'Member' })
  await db.insert(account).values({
    id: `${MEMBER.id}-credential`,
    accountId: MEMBER.id,
    providerId: 'credential',
    userId: MEMBER.id,
    password: await ctx.password.hash(PASSWORD),
  })
})

async function signIn(
  ip: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const request = new Request(`${base}/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(base).origin,
      ...headers,
    },
    body: JSON.stringify({ email: MEMBER.email, password }),
  })
  return (await auth.handler(await withClientIp(request, ip))).status
}

describe('sign-in rate limit', () => {
  it('answers the sixth attempt from one address with 429, and lets another address in', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++)
      statuses.push(await signIn('203.0.113.7', 'wrong password!'))
    expect(statuses.slice(0, 5)).not.toContain(429)
    expect(statuses.at(5)).toBe(429)

    // The count lives in Postgres, keyed by address and path.
    const rows = await db
      .select()
      .from(rateLimit)
      .where(eq(rateLimit.key, '203.0.113.7|/sign-in/email'))
    expect(rows.at(0)?.count).toBe(5)

    expect(await signIn('203.0.113.8', PASSWORD)).toBe(200)
  })

  it('ignores a client address the client wrote itself', async () => {
    for (let i = 0; i < 5; i++) await signIn('198.51.100.4', 'wrong password!')
    expect(
      await signIn('198.51.100.4', PASSWORD, {
        [CLIENT_IP_HEADER]: '192.0.2.99',
      }),
    ).toBe(429)
  })
})

describe('clientIp', () => {
  it('is the socket address unless the install trusts its proxy', () => {
    expect(
      clientIp({
        forwardedFor: '192.0.2.1',
        socket: '10.0.0.5',
        trustProxy: false,
      }),
    ).toBe('10.0.0.5')
  })

  it('behind a trusted proxy, is the entry the nearest proxy appended', () => {
    expect(
      clientIp({
        forwardedFor: '192.0.2.1, 198.51.100.9',
        socket: '10.0.0.5',
        trustProxy: true,
      }),
    ).toBe('198.51.100.9')
    expect(
      clientIp({ forwardedFor: null, socket: '10.0.0.5', trustProxy: true }),
    ).toBe('10.0.0.5')
  })
})
