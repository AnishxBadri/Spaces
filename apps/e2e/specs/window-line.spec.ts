import { Client } from 'pg'
import type { Locator } from '@playwright/test'
import { ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A window's text stands on one 16px line (E3), measured in a real Chromium
 * at 1280px: the meeting window's head, its Linked records label, the
 * linked record's row and the pin row all start 16px inside the sheet's 1px
 * frame; a head or a row led by a mark stands the mark on the line. The
 * company and the meeting are written straight into the instance's own
 * database, since this suite imports nothing internal.
 */

async function addLinkedMeeting(
  company: string,
  subject: string,
): Promise<{ companyId: string; meetingId: string }> {
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
    const met = await client.query<{ id: string }>(
      `insert into interaction (kind, subject, occurred_at)
       values ('meeting', $1::text, now() - interval '1 day')
       returning id`,
      [subject],
    )
    const meetingId = met.rows.at(0)?.id
    if (meetingId === undefined) throw new Error('no meeting made')
    await client.query(
      'insert into interaction_entity (interaction_id, entity_id) values ($1, $2)',
      [meetingId, companyId],
    )
    return { companyId, meetingId }
  } finally {
    await client.end()
  }
}

async function leftOf(box: Locator): Promise<number> {
  const rect = await box.boundingBox()
  if (rect === null) throw new Error('not on screen')
  return rect.x
}

test.use({ viewport: { width: 1280, height: 900 } })

test('the meeting window stands its head and its rows on one line', async ({
  adminPage,
  main,
}) => {
  const { companyId, meetingId } = await addLinkedMeeting(
    'Line Co',
    'Partner sync',
  )
  await adminPage.goto(
    `${main.url}/companies/${companyId}?tab=interactions&modal=meeting&id=${meetingId}`,
  )
  const win = adminPage.locator('[data-slot="dialog-content"]')
  await expect(win).toBeVisible()
  const linked = win.locator('section[aria-label="Linked records"]')
  await expect(linked).toContainText('Line Co')

  const line = (await leftOf(win)) + 1 + 16
  const head = win.locator('[data-slot="dialog-header"] > *').first()
  const label = linked.locator('[data-label-head] h2')
  // The row's leading kind mark stands on the line, its name after it.
  const row = linked.locator('li').first().locator('> *').first()
  const pin = linked.locator('li').last().locator('span').first()
  const boxes = { head, label, row, pin }
  for (const [name, box] of Object.entries(boxes))
    expect(Math.round((await leftOf(box)) - line), name).toBe(0)
})
