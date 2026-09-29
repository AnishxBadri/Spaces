import { ADMIN, ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * The login gate, against `main` — an instance whose admin global setup
 * created through the first-run flow.
 */
test.describe('the login gate', () => {
  test('signed out, /today redirects to /login', async ({ page, main }) => {
    await page.goto(`${main.url}/today`)
    await expect(page).toHaveURL(`${main.url}/login`)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('a wrong password is refused', async ({ page, main }) => {
    await page.goto(`${main.url}/login`)
    await page.getByLabel('Email', { exact: true }).fill(ADMIN.email)
    await page
      .getByLabel('Password', { exact: true })
      .fill('not the password at all')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Wrong email or password.')).toBeVisible()
    await expect(page).toHaveURL(`${main.url}/login`)
    // and still signed out
    await page.goto(`${main.url}/today`)
    await expect(page).toHaveURL(`${main.url}/login`)
  })

  test('the first-run admin signs in and lands on /today', async ({
    page,
    main,
  }) => {
    await page.goto(`${main.url}/login`)
    await page.getByLabel('Email', { exact: true }).fill(ADMIN.email)
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(`${main.url}/today`)
  })

  test('the session global setup saved is a real one', async ({
    browser,
    main,
  }) => {
    const context = await browser.newContext({
      storageState: fromEnv(ENV.adminStorage),
    })
    const page = await context.newPage()
    await page.goto(`${main.url}/today`)
    await expect(page).toHaveURL(`${main.url}/today`)
    await context.close()
  })
})
