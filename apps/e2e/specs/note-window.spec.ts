import { Client } from 'pg'
import type { Page } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A note opened from a record's Notes tab opens in a window over the
 * record, against `main`: a new note is born there with the caret in its
 * title, typing saves it, Esc and Back close the window, the path never
 * changes, and `Open as page ↗` lands on the same note with nothing lost.
 * The company is written straight into the instance's own database, since
 * this suite imports nothing internal.
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

test('a note opens, saves and closes over its record', async ({
  adminPage,
  main,
}) => {
  const id = await addCompany('Window Co')
  await adminPage.goto(`${main.url}/companies/${id}?tab=notes`)
  const toolbar = adminPage.locator('[data-notes-toolbar]')
  await expect(toolbar).toContainText('No notes yet')
  const path = pathOf(adminPage)

  await toolbar.getByRole('button', { name: 'New note', exact: true }).click()
  const win = adminPage.locator('[data-note-window]')
  await expect(win).toBeVisible()
  const title = win.getByLabel('Note title')
  await expect(title).toBeFocused()
  await title.fill('Window note')
  await expect(win.locator('[data-note-window-foot]')).toContainText('Saved')
  expect(pathOf(adminPage)).toBe(path)

  await adminPage.keyboard.press('Escape')
  await expect(win).toHaveCount(0)
  expect(pathOf(adminPage)).toBe(path)
  const row = adminPage.locator('li[data-note]', { hasText: 'Window note' })
  await expect(row).toBeVisible()

  // A row opens the window over the tab; Back takes it away again.
  await row.locator('a').click()
  await expect(win).toBeVisible()
  await expect(row).toHaveAttribute('data-highlighted', '')
  await expect(win.getByLabel('Note title')).toHaveValue('Window note')

  // The editor's floating menus mount inside the window and take clicks
  // through its focus trap.
  const portal = win.locator('[data-note-window-portal]')
  await win.locator('.bn-editor').click()
  await adminPage.keyboard.press('Control+End')
  await adminPage.keyboard.press('Meta+ArrowDown')
  await adminPage.keyboard.press('Enter')
  const slash = portal.locator('.bn-suggestion-menu')
  // Escape closes an open menu and leaves the window standing.
  await adminPage.keyboard.type('/')
  await expect(slash).toBeVisible()
  await adminPage.keyboard.press('Escape')
  await expect(slash).toBeHidden()
  await expect(win).toBeVisible()
  await adminPage.keyboard.press('Backspace')
  await adminPage.keyboard.type('/heading')
  await expect(slash).toBeVisible()
  await slash.getByText('Heading 1', { exact: true }).click()
  await expect(win).toBeVisible()
  await adminPage.keyboard.type('Window heading')
  await expect(win.locator('[data-note-window-body] h1')).toHaveText(
    'Window heading',
  )
  await adminPage.keyboard.press('Shift+Home')
  await expect(portal.locator('.bn-formatting-toolbar')).toBeVisible()

  await adminPage.goBack()
  await expect(win).toHaveCount(0)
  expect(pathOf(adminPage)).toBe(path)
  await expect(
    adminPage.getByRole('tab', { name: /^Notes/, selected: true }),
  ).toBeVisible()

  // Open as page lands on the same note.
  await row.locator('a').click()
  await expect(win).toBeVisible()
  await win.getByRole('button', { name: 'Open as page ↗' }).click()
  await expect(adminPage).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
  await expect(adminPage.getByLabel('Note title')).toHaveValue('Window note')
  await expect(adminPage.locator('.bn-editor h1')).toHaveText('Window heading')
})
