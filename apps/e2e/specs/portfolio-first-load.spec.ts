import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * Portfolio's first paint carries its data: the server renders `/portfolio`
 * and a holding from the query cache it dehydrates into the page, and the
 * browser hydrates that cache without asking the server again. A read is
 * told apart by what its server-function response carries, since a built
 * function's id is a hash: the list's answer names `excludedForMissingRates`,
 * a holding's names `distributions`. Each test also makes the read happen
 * once on purpose, so a check that saw nothing could not pass by being blind.
 *
 * Serial: the tests share the holding the first one writes.
 */
test.describe.configure({ mode: 'serial' })

const COMPANY = 'Hydrate Holding Co'

/** A company with a holding and one check, straight into the database. */
async function addHolding(): Promise<string> {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    const made = await client.query<{ id: string }>(
      `insert into entity (kind, object_id, canonical_name, "values")
       select 'company', o.id, $1::text, jsonb_build_object('name', $1::text)
       from object o where o.slug = 'companies'
       returning id`,
      [COMPANY],
    )
    const companyId = made.rows.at(0)?.id
    if (companyId === undefined) throw new Error('no company made')
    await client.query('insert into company (entity_id) values ($1)', [
      companyId,
    ])
    const held = await client.query<{ id: string }>(
      `insert into holding (company_id, opened_at) values ($1, '2025-03-01')
       returning id`,
      [companyId],
    )
    const holdingId = held.rows.at(0)?.id
    if (holdingId === undefined) throw new Error('no holding made')
    await client.query(
      `insert into investment (holding_id, date, amount, currency, instrument)
       values ($1, '2025-03-01', 250000, 'USD', 'priced')`,
      [holdingId],
    )
    return holdingId
  } finally {
    await client.end()
  }
}

type Reads = { list: number; holding: number }

/** Counts the Portfolio reads the page makes from now on. */
function watchReads(page: Page): Reads {
  const reads: Reads = { list: 0, holding: 0 }
  page.on('response', (res) => {
    if (!res.url().includes('/_serverFn/')) return
    void res
      .text()
      .then((body) => {
        if (body.includes('excludedForMissingRates')) reads.list += 1
        if (body.includes('distributions')) reads.holding += 1
      })
      .catch(() => {})
  })
  return reads
}

/** Hydrated, and every request a mount would have fired has come back. */
async function settled(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
}

let holdingId = ''

test('the list paints with its data and asks for it no second time', async ({
  adminPage,
  main,
}) => {
  holdingId = await addHolding()
  const reads = watchReads(adminPage)
  await adminPage.goto(`${main.url}/portfolio`)
  await expect(adminPage.getByRole('link', { name: COMPANY })).toBeVisible()
  await settled(adminPage)
  expect(reads).toEqual({ list: 0, holding: 0 })

  // The read the first paint saved: a holding opened in the browser asks.
  await adminPage.getByRole('link', { name: COMPANY }).click()
  await expect(adminPage).toHaveURL(new RegExp(`/portfolio/${holdingId}`))
  await expect.poll(() => reads.holding).toBe(1)
})

test('the holding paints with its data and asks for it no second time', async ({
  adminPage,
  main,
}) => {
  const reads = watchReads(adminPage)
  await adminPage.goto(`${main.url}/portfolio/${holdingId}`)
  await expect(adminPage.getByRole('heading', { name: COMPANY })).toBeVisible()
  await settled(adminPage)
  expect(reads).toEqual({ list: 0, holding: 0 })

  // The read the first paint saved: the list opened in the browser asks.
  await adminPage
    .getByRole('navigation', { name: 'Primary' })
    .locator('a[href="/portfolio"]')
    .click()
  await expect(adminPage).toHaveURL(/\/portfolio$/)
  await expect.poll(() => reads.list).toBe(1)
})
