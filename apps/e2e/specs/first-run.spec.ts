import { printedSetupTokens } from '../harness/instance.ts'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * The first-run window (CONTEXT.md, self-host auth trap 2), against
 * `firstRun` — an empty database nobody has signed up to. Between compose up
 * and the first admin, /setup is open to anyone who can reach the port; the
 * one-time token printed to the server log is what closes it. The token is
 * checked in the Better Auth database hook, not the route, so these tests
 * drive the real form in a real browser *and* hit the public endpoint
 * directly — a route-level check would pass the first and fail the second.
 *
 * Serial: each test leaves the server in the state the next one starts from.
 */
test.describe.configure({ mode: 'serial' })

const OWNER = {
  name: 'First Owner',
  email: 'owner@e2e.spaces.test',
  password: 'first owner long passphrase',
}

async function fillSetup(page: Page, token: string) {
  await page.getByLabel('Setup token').fill(token)
  await page.getByLabel('Workspace name').fill('First Run Capital')
  await page.getByLabel('Your name').fill(OWNER.name)
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email)
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

test.describe('the first-run window', () => {
  let token = ''

  test('an empty database sends /login to /setup and prints a token', async ({
    page,
    firstRun,
  }) => {
    expect(await firstRun.userCount()).toBe(0)
    await page.goto(`${firstRun.url}/login`)
    await expect(page).toHaveURL(`${firstRun.url}/setup`)
    const printed = await printedSetupTokens(fromEnv(ENV.firstrunLog))
    expect(printed.length).toBeGreaterThan(0)
    // Re-printed on every ask, but always the same token until it is used.
    expect(new Set(printed).size).toBe(1)
    token = printed.at(-1) ?? ''
  })

  // The form shows Better Auth's generic "Failed to create user" for every
  // hook refusal; the hook's own sentence reaches the server log only, which
  // is where these assert which check refused.
  test('signup without the token is refused', async ({ page, firstRun }) => {
    await page.goto(`${firstRun.url}/setup`)
    const since = await firstRun.logMark()
    await fillSetup(page, '')
    await expect(page.getByRole('alert')).toBeVisible()
    await expect.poll(since).toMatch(/Error: Setup token required/)
    await expect(page.getByText('Start with demo data?')).toHaveCount(0)
    expect(await firstRun.userCount()).toBe(0)
  })

  test('a wrong token is refused', async ({ page, firstRun }) => {
    await page.goto(`${firstRun.url}/setup`)
    const since = await firstRun.logMark()
    await fillSetup(page, 'f'.repeat(32))
    await expect(page.getByRole('alert')).toBeVisible()
    await expect.poll(since).toMatch(/Error: Setup token required/)
    expect(await firstRun.userCount()).toBe(0)
  })

  test('the token from the log is accepted once', async ({
    page,
    firstRun,
  }) => {
    await page.goto(`${firstRun.url}/setup`)
    await fillSetup(page, token)
    await expect(page.getByText('Start with demo data?')).toBeVisible()
    expect(await firstRun.userCount()).toBe(1)
  })

  test('a second use of the same token is refused', async ({
    request,
    firstRun,
  }) => {
    // Straight at the public endpoint, from a client with no session: the
    // form is not the only way in, which is why the check is in the hook.
    const since = await firstRun.logMark()
    // This is the fourth signup attempt on this server in a few seconds, and
    // Better Auth's limiter allows three per path per window — a 429 is a
    // refusal too, but not the one under test. Wait it out, so the answer
    // asserted below is the hook's.
    const claim = () =>
      request.post(`${firstRun.url}/api/auth/sign-up/email`, {
        headers: { origin: firstRun.url, 'x-setup-token': token },
        data: {
          name: 'Second Claimant',
          email: 'second@e2e.spaces.test',
          password: 'second claimant passphrase',
        },
      })
    let res = await claim()
    for (let i = 0; i < 12 && res.status() === 429; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      res = await claim()
    }
    expect(res.ok()).toBe(false)
    expect(await res.json()).toMatchObject({ code: 'FAILED_TO_CREATE_USER' })
    // With an admin present the hook closes signup before it looks at a
    // token at all; the token file itself was deleted inside the hook the
    // moment the first admin was created (apps/web/src/lib/auth.ts).
    await expect.poll(since).toMatch(/Error: Signup is closed/)
    expect(await firstRun.userCount()).toBe(1)
  })
})
