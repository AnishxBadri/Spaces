import { Client } from 'pg'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A new email started from a company's Interactions tab, against `main`:
 * `New email` opens the composer as a window over the record with To
 * filled with the person last emailed there, what is typed is saved, and
 * after Esc the draft is under Email › Drafts. The company and its person
 * are written straight into the instance's own database, since this suite
 * imports nothing internal.
 */

async function addCompanyWithContact(
  name: string,
  contact: { name: string; email: string },
): Promise<string> {
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
    const companyId = made.rows.at(0)?.id
    if (companyId === undefined) throw new Error('no company made')
    await client.query('insert into company (entity_id) values ($1)', [
      companyId,
    ])
    const born = await client.query<{ id: string }>(
      `insert into entity (kind, object_id, canonical_name, "values")
       select 'person', o.id, $1::text,
              jsonb_build_object('name', $1::text, 'companies', jsonb_build_array($2::text))
       from object o where o.slug = 'people'
       returning id`,
      [contact.name, companyId],
    )
    const personId = born.rows.at(0)?.id
    if (personId === undefined) throw new Error('no person made')
    await client.query('insert into person (entity_id) values ($1)', [personId])
    await client.query(
      `insert into entity_alias (entity_id, kind, value, value_norm, is_identity)
       values ($1, 'email', $2::text, lower($2::text), true)`,
      [personId, contact.email],
    )
    await client.query(
      `insert into link (from_entity_id, to_entity_id, relation, attr_slug)
       values ($1, $2, 'references', 'companies')`,
      [personId, companyId],
    )
    await client.query(
      `insert into interaction_stat (entity_id, kind, last_at)
       values ($1, 'email', now() - interval '2 days')`,
      [personId],
    )
    return companyId
  } finally {
    await client.end()
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

test('starts an email from a company’s Interactions tab and finds the draft under Email › Drafts', async ({
  adminPage,
  main,
}) => {
  const id = await addCompanyWithContact('Composer Co', {
    name: 'Dev Shah',
    email: 'dev@composer.example',
  })
  await adminPage.goto(`${main.url}/companies/${id}?tab=interactions`)
  const path = new URL(adminPage.url()).pathname
  const empty = adminPage.locator('[data-interactions-empty]')
  await empty.getByRole('button', { name: 'New email', exact: true }).click()

  const win = adminPage.locator('[data-compose-window]')
  await expect(win).toBeVisible()
  await expect(win.getByRole('heading', { name: 'New email' })).toBeVisible()
  await expect(win.locator('[data-chip="dev@composer.example"]')).toBeVisible()
  const url = new URL(adminPage.url())
  expect(url.pathname).toBe(path)
  expect(url.searchParams.get('modal')).toBe('email')
  expect(url.searchParams.get('new')).toBe('1')

  await win.getByLabel('Subject').fill('Diligence next steps')
  await expect(
    win.getByRole('heading', { name: 'Diligence next steps' }),
  ).toBeVisible()
  await win.getByLabel('Message').fill('Hi Dev, three things before Friday.')
  await expect(win.locator('[data-saved]')).toHaveText(/^Saved \d\d:\d\d$/)

  await adminPage.keyboard.press('Escape')
  await expect(win).toHaveCount(0)
  expect(new URL(adminPage.url()).searchParams.get('tab')).toBe('interactions')

  await adminPage.goto(`${main.url}/email?tab=drafts`)
  const draft = adminPage.locator('li[data-draft]', {
    hasText: 'Diligence next steps',
  })
  await expect(draft).toBeVisible()
  await expect(draft).toContainText('Dev Shah')
})
