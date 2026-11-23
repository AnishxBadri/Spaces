import { Client } from 'pg'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * The Email page at 1440, against `main`: a thread of two messages filed on
 * a company lists once under This week, and selecting it reads its cards in
 * the right pane, the newest open, with the thread's `···` and Reply in the
 * pane's head and no window over the page. The rows are written straight
 * into the instance's own database, since this suite imports nothing
 * internal.
 */

async function addThread(company: string, subject: string): Promise<string> {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    const made = await client.query<{ id: string }>(
      `insert into entity (kind, object_id, canonical_name, "values")
       select 'company', o.id, $1::text, jsonb_build_object('name', $1::text)
       from object o where o.slug = 'companies'
       returning id`,
      [company],
    )
    const companyId = made.rows.at(0)?.id
    if (companyId === undefined) throw new Error('no company made')
    await client.query('insert into company (entity_id) values ($1)', [
      companyId,
    ])
    const thread = `e2e-${String(Date.now())}`
    let newest = ''
    for (const [s, ago] of [
      [subject, '3 hours'],
      [`Re: ${subject}`, '1 hour'],
    ] as const) {
      const sent = await client.query<{ id: string }>(
        `insert into interaction (kind, subject, occurred_at, thread_id)
         values ('email', $1::text, now() - $2::interval, $3::text)
         returning id`,
        [s, ago, thread],
      )
      const id = sent.rows.at(0)?.id
      if (id === undefined) throw new Error('no email made')
      await client.query(
        'insert into interaction_entity (interaction_id, entity_id) values ($1, $2)',
        [id, companyId],
      )
      newest = id
    }
    return newest
  } finally {
    await client.end()
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

test('selects a thread and reads its cards in the pane', async ({
  adminPage,
  main,
}) => {
  const newest = await addThread('Paned Co', 'Data room access')
  await adminPage.goto(`${main.url}/email`)
  const row = adminPage.locator(`li[data-thread="${newest}"]`)
  await expect(row).toContainText('Re: Data room access')
  await expect(row.locator('[data-messages]')).toHaveText('2')
  await expect(row.locator('[data-records]')).toContainText('Paned Co')

  await row.getByRole('button').click()
  await expect(row).toHaveAttribute('data-selected', '')
  const pane = adminPage.locator('[data-email-pane]')
  await expect(pane.locator('[data-pane-head] h2')).toHaveText(
    'Re: Data room access',
  )
  await expect(pane.locator('[data-card]')).toHaveCount(2)
  await expect(pane.locator(`[data-message="${newest}"]`)).toBeVisible()
  await expect(
    pane.locator('[data-pane-head]').getByRole('button', { name: 'Reply' }),
  ).toBeVisible()
  await expect(adminPage.getByRole('dialog')).toHaveCount(0)
})
