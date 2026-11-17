import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * Logging an interaction on a record, against `main`: an empty
 * Interactions tab is its toolbar, a call logged with a summary and
 * `Write it up next` opens its write-up in the note window over the record
 * with the path unchanged, and once the window closes the new row reads
 * the summary as its second line. The company is written straight into the
 * instance's own database, since this suite imports nothing internal.
 */

async function addCompany(name: string): Promise<string> {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    const made = await client.query<{ id: string }>(
      `insert into entity (kind, object_id, canonical_name, "values")
       select 'company', o.id, $1::text, jsonb_build_object('name', $1::text)
       from object o where o.slug = 'companies'
       returning id`,
      [name],
    )
    const id = made.rows.at(0)?.id
    if (id === undefined) throw new Error('no company made')
    await client.query('insert into company (entity_id) values ($1)', [id])
    return id
  } finally {
    await client.end()
  }
}

const pathOf = (page: Page) => new URL(page.url()).pathname

test.use({ viewport: { width: 1440, height: 900 } })

test('a call logged with a summary opens its write-up over the record', async ({
  adminPage,
  main,
}) => {
  const id = await addCompany('Logbook Co')
  await adminPage.goto(`${main.url}/companies/${id}?tab=interactions`)
  const empty = adminPage.locator('[data-interactions-empty]')
  await expect(empty).toContainText('No interactions yet')
  const path = pathOf(adminPage)

  await empty.getByRole('button', { name: 'Log interaction' }).click()
  const log = adminPage.getByRole('dialog', { name: 'Log interaction' })
  await expect(log).toBeVisible()
  await log.getByRole('radio', { name: 'Call' }).click()
  await log.getByLabel('About').fill('Pricing call')
  await log.getByLabel('Summary').fill('Wants a lead by March.')
  await log.getByRole('checkbox').click()
  await log.getByRole('button', { name: 'Log call' }).click()

  const win = adminPage.locator('[data-note-window]')
  await expect(win).toBeVisible()
  await expect(win.getByLabel('Note title')).toHaveValue('Pricing call')
  expect(pathOf(adminPage)).toBe(path)

  await adminPage.keyboard.press('Escape')
  await expect(win).toHaveCount(0)
  const row = adminPage.locator('li[data-thread]', { hasText: 'Pricing call' })
  await expect(row).toBeVisible()
  await expect(row.locator('[data-summary]')).toHaveText(
    'Wants a lead by March.',
  )
})
