import { eq, inArray } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { account, session, user, verification } from '@spaces/db/schema/auth'

/**
 * The admin-issued reset link against the real Better Auth instance: a real
 * admin session mints the link, Better Auth's own `/reset-password` spends
 * it, and the member's sessions go with it. Only the request the server fns
 * read is stubbed, carrying the admin's session cookie.
 */

const request = vi.hoisted(() => {
  // A fixed secret keeps the auth module off the master-key file in CI.
  process.env.BETTER_AUTH_SECRET ??=
    'reset-link-test-secret-reset-link-test-secret'
  return { cookie: '' }
})

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () =>
    new Request('http://localhost/settings/members', {
      headers: { cookie: request.cookie },
    }),
  setCookie: () => undefined,
}))

const { auth } = await import('#/lib/auth')
const { createResetLinkHandler, resetPreviewHandler } =
  await import('./reset-link')

const ADMIN = { id: 'spa382-admin', email: 'spa382-admin@spaces.test' }
const MEMBER = { id: 'spa382-member', email: 'spa382-member@spaces.test' }
const SUSPENDED = { id: 'spa382-gone', email: 'spa382-gone@spaces.test' }
const NO_PASSWORD = { id: 'spa382-oauth', email: 'spa382-oauth@spaces.test' }
const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'staple battery horse correct'

async function withPassword(id: string, password: string) {
  const ctx = await auth.$context
  await db.insert(account).values({
    id: `${id}-credential`,
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await ctx.password.hash(password),
  })
}

/** Signs in for real and returns the `cookie` header the session rides on. */
async function signIn(email: string, password: string): Promise<string> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  })
  return headers
    .getSetCookie()
    .map((c) => c.split(';').at(0) ?? '')
    .join('; ')
}

const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? ''

const sessionsOf = async (userId: string) =>
  (await db.select().from(session).where(eq(session.userId, userId))).length

beforeAll(async () => {
  await db.insert(user).values([
    { ...ADMIN, name: 'Admin', role: 'admin' },
    { ...MEMBER, name: 'Member' },
    { ...SUSPENDED, name: 'Suspended', banned: true },
    { ...NO_PASSWORD, name: 'Oauth only' },
  ])
  await withPassword(ADMIN.id, PASSWORD)
  await withPassword(MEMBER.id, PASSWORD)
  await withPassword(SUSPENDED.id, PASSWORD)
  request.cookie = await signIn(ADMIN.email, PASSWORD)
})

describe('admin-issued reset link', () => {
  it('sets the password once, revokes the old sessions, and fails the second time', async () => {
    await signIn(MEMBER.email, PASSWORD)
    await signIn(MEMBER.email, PASSWORD)
    expect(await sessionsOf(MEMBER.id)).toBe(2)

    const { url } = await createResetLinkHandler({ userId: MEMBER.id })
    expect(url).toMatch(/\/reset\?token=[\w-]{32}$/)
    const token = tokenOf(url)

    // Only the hash is stored: no row carries the token in the clear.
    const rows = await db
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(eq(verification.value, MEMBER.id))
    expect(rows).toHaveLength(1)
    expect(rows.at(0)?.identifier).not.toContain(token)
    expect(await resetPreviewHandler({ token })).toEqual({ valid: true })

    await auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } })
    expect(await sessionsOf(MEMBER.id)).toBe(0)
    expect(await resetPreviewHandler({ token })).toEqual({ valid: false })
    await expect(
      auth.api.resetPassword({ body: { newPassword: PASSWORD, token } }),
    ).rejects.toThrow()

    await expect(signIn(MEMBER.email, PASSWORD)).rejects.toThrow()
    expect(await signIn(MEMBER.email, NEW_PASSWORD)).toContain('session_token')
  })

  it('retires the earlier link when a new one is sent', async () => {
    const first = tokenOf(
      (await createResetLinkHandler({ userId: MEMBER.id })).url,
    )
    const second = tokenOf(
      (await createResetLinkHandler({ userId: MEMBER.id })).url,
    )
    expect(await resetPreviewHandler({ token: first })).toEqual({
      valid: false,
    })
    expect(await resetPreviewHandler({ token: second })).toEqual({
      valid: true,
    })
  })

  it('refuses the admin themselves, a suspended member, and a user with no password', async () => {
    await expect(createResetLinkHandler({ userId: ADMIN.id })).rejects.toThrow(
      'You cannot send yourself a reset link.',
    )
    await expect(
      createResetLinkHandler({ userId: SUSPENDED.id }),
    ).rejects.toThrow('Restore their access before sending a reset link.')
    await expect(
      createResetLinkHandler({ userId: NO_PASSWORD.id }),
    ).rejects.toThrow('there is none to reset')
    const minted = await db
      .select()
      .from(verification)
      .where(
        inArray(verification.value, [ADMIN.id, SUSPENDED.id, NO_PASSWORD.id]),
      )
    expect(minted).toEqual([])
  })

  it('refuses a member who is not an admin', async () => {
    const admin = request.cookie
    request.cookie = await signIn(MEMBER.email, NEW_PASSWORD)
    try {
      await expect(
        createResetLinkHandler({ userId: SUSPENDED.id }),
      ).rejects.toThrow('Admins only')
    } finally {
      request.cookie = admin
    }
  })

  it('reads a made-up token as not valid', async () => {
    expect(await resetPreviewHandler({ token: 'not-a-token' })).toEqual({
      valid: false,
    })
  })
})
