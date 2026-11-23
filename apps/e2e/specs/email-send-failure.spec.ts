import { Client } from 'pg'
import { ADMIN, ENV, fromEnv } from '../harness/shared.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * A send that is refused, against `main` at 1440. The instance holds no
 * Google grant and runs no worker, so a stand-in mailbox and the Gmail
 * plugin bound to it are written straight into its own database (this
 * suite imports nothing internal): Review offers Send, and the send is
 * refused, since nothing serves the plugin's queue. The window stays with
 * `Not sent ·` and the reason, the primary is `Retry`, the draft leads
 * Email › Drafts with `Not sent`, and Today names it with `Open ›` back to
 * it. The stand-in rows are removed after.
 */

const MAILBOX = 'admin@e2e-mail.example'

const MANIFEST = {
  manifestVersion: 1,
  id: 'gmail',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Gmail',
  description: 'Mail.',
  settings: {},
  jobs: {
    send: {
      trigger: 'action',
      input: 'payload',
      interactive: true,
      retry: 0,
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
}

const db = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: fromEnv(ENV.mainDb) })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

/** What the spec wrote, to remove again. */
type Seeded = {
  companyId: string | null
  connectionId: string | null
  integrationId: string | null
  draftId: string | null
}

/** A sending mailbox for the admin, its Gmail plugin, and a draft. */
const seed = (subject: string, into: Seeded): Promise<string> =>
  db(async (client) => {
    const owner = (
      await client.query<{ id: string }>(
        'select id from "user" where email = $1',
        [ADMIN.email],
      )
    ).rows.at(0)?.id
    if (owner === undefined) throw new Error('no admin')
    // Today shows its notices once the workspace holds a company.
    into.companyId =
      (
        await client.query<{ id: string }>(
          `insert into entity (kind, object_id, canonical_name, "values")
           select 'company', o.id, 'Flent', jsonb_build_object('name', 'Flent')
           from object o where o.slug = 'companies'
           returning id`,
        )
      ).rows.at(0)?.id ?? null
    await client.query('insert into company (entity_id) values ($1)', [
      into.companyId,
    ])
    into.connectionId =
      (
        await client.query<{ id: string }>(
          `insert into account_connection
             (user_id, provider, product, external_email, tokens_enc, scopes)
           values ($1, 'google', 'gmail', $2, '\\x00'::bytea,
                   array['openid', 'email', 'gmail.readonly', 'gmail.send'])
           returning id`,
          [owner, MAILBOX],
        )
      ).rows.at(0)?.id ?? null
    into.integrationId =
      (
        await client.query<{ id: string }>(
          `insert into integration
             (capability_id, version, enabled, status, manifest, connection_id)
           values ('gmail', '0.1.0', true, 'enabled', $1::jsonb, $2)
           returning id`,
          [JSON.stringify(MANIFEST), into.connectionId],
        )
      ).rows.at(0)?.id ?? null
    into.draftId =
      (
        await client.query<{ id: string }>(
          `insert into email_draft (user_id, "to", subject, body_md)
           values ($1, $2::jsonb, $3, 'Thanks Dana, the terms are attached.')
           returning id`,
          [owner, JSON.stringify([{ email: 'dana@flent.example' }]), subject],
        )
      ).rows.at(0)?.id ?? null
    if (into.draftId === null) throw new Error('no draft')
    return into.draftId
  })

const unseed = (s: Seeded) =>
  db(async (client) => {
    await client.query('delete from email_draft where id = $1', [s.draftId])
    await client.query('delete from integration where id = $1', [
      s.integrationId,
    ])
    await client.query('delete from account_connection where id = $1', [
      s.connectionId,
    ])
    await client.query('delete from company where entity_id = $1', [
      s.companyId,
    ])
    await client.query('delete from entity where id = $1', [s.companyId])
  })

test.use({ viewport: { width: 1440, height: 900 } })

test('a refused send keeps the window with Not sent and Retry, and leads Drafts and Today', async ({
  adminPage,
  main,
}) => {
  test.setTimeout(90_000)
  const subject = `Pilot terms ${String(Date.now())}`
  const seeded: Seeded = {
    companyId: null,
    connectionId: null,
    integrationId: null,
    draftId: null,
  }
  try {
    const draftId = await seed(subject, seeded)
    await adminPage.goto(`${main.url}/email?tab=drafts&id=${draftId}`)
    const pane = adminPage.locator('[data-draft-pane]')
    await expect(pane).toBeVisible()
    await pane.getByRole('button', { name: 'Review', exact: true }).click()
    const send = pane.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    await send.click()

    await expect(pane.locator('[data-send-failed]')).toHaveText(
      /^Not sent · \S/,
    )
    await expect(
      pane.getByRole('button', { name: 'Retry', exact: true }),
    ).toBeEnabled()
    await expect(
      pane.getByRole('button', { name: 'Back to draft', exact: true }),
    ).toBeEnabled()

    // The failure is stored on the draft: it leads Drafts as not sent.
    const row = adminPage.locator(`li[data-draft="${draftId}"]`)
    await expect(row).toContainText('Not sent')
    await expect(adminPage.locator('li[data-draft]').first()).toHaveAttribute(
      'data-draft',
      draftId,
    )

    // And on Today, with Open › back to it under Drafts.
    await adminPage.goto(`${main.url}/today`)
    const notice = adminPage.locator('[data-notice]', {
      has: adminPage.locator(`[data-unsent="${draftId}"]`),
    })
    await expect(notice).toContainText(`${subject} · not sent`)
    await notice.getByRole('link', { name: 'Open ›' }).click()
    await expect(adminPage).toHaveURL(
      new RegExp(`/email\\?tab=drafts&id=${draftId}$`),
    )
    // Reopened, it says why it did not go.
    await expect(
      adminPage.locator('[data-draft-pane] [data-send-failed]'),
    ).toHaveText(/^Not sent · \S/)
  } finally {
    await unseed(seeded)
  }
})
