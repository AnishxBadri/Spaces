import { expect, test } from '../harness/fixtures.ts'

/**
 * Once an admin exists, signup is closed for good: the only way in is an
 * invite. Against `main`, whose admin global setup created. The request goes
 * straight at Better Auth's public endpoint with neither token — the attack
 * the database hook exists for — and carries a same-origin `Origin`, so the
 * CSRF check lets it through to the hook. The server log is what proves the
 * hook refused it (see `logMark`).
 */
test('with an admin present, a bare signup POST is refused', async ({
  request,
  main,
}) => {
  const before = await main.userCount()
  expect(before).toBeGreaterThan(0)
  const since = await main.logMark()
  const res = await request.post(`${main.url}/api/auth/sign-up/email`, {
    headers: { origin: main.url },
    data: {
      name: 'Walk In',
      email: 'walk-in@e2e.spaces.test',
      password: 'walk in long passphrase',
    },
  })
  expect(res.ok()).toBe(false)
  expect(await res.json()).toMatchObject({ code: 'FAILED_TO_CREATE_USER' })
  await expect.poll(since).toMatch(/Error: Signup is closed/)
  expect(await main.userCount()).toBe(before)
})
