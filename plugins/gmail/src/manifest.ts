import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Gmail's manifest: a syncer.
 * - One `schedule` job. `uses` is a syncer's grant: the connection's token
 *   (Secrets), the provider (Http), the mail lane (Content) and Log — never
 *   Facts, Identity or Ai. Participants become records host-side.
 * - The connection asks `gmail.readonly` only; sending is a later job's.
 * - The settings are the connection's, edited on its account page, and read
 *   by the host: whether bodies are shared (D67) and the exclude list. The
 *   defaults are the host's `DEFAULT_MAIL_EXCLUDE`, asserted equal.
 * - `sdk: '^1.4'` until the SDK release that carries `logEmail`,
 *   `connectedAt`, `CursorInvalid` and `ConnectionRefused` is cut, as
 *   google-calendar does.
 */
export const DEFAULT_EXCLUDE_SENDERS = [
  'noreply@',
  'no-reply@',
  'notifications@',
  'mailer-daemon@',
  'calendar-notification@google.com',
  'mcsv.net',
  'mcdlv.net',
  'rsgsv.net',
  'mandrillapp.com',
  'sendgrid.net',
  'amazonses.com',
  'mailgun.org',
  'sparkpostmail.com',
]

export const DEFAULT_EXCLUDE_LABELS = [
  'Promotions',
  'Social',
  'Updates',
  'Forums',
  'Spam',
]

export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'gmail',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Gmail',
  roles: ['email-calendar'],
  description:
    'Adds your mail to the timelines of the people and companies in it, from the day you connect, with its attachments. Bodies stay visible to you alone unless you share them; subject, participants and date are visible to the workspace. Promotions, machine senders and anything you exclude are never synced.',
  requires: {
    connection: { provider: 'google', scopes: ['gmail.readonly'] },
  },
  settings: z.object({
    shareBodies: z
      .boolean()
      .default(false)
      .describe('Show the bodies of this mailbox’s emails to the workspace.'),
    excludeSenders: z
      .array(z.string())
      .default(DEFAULT_EXCLUDE_SENDERS)
      .describe('Domains, addresses or local parts (noreply@) never synced.'),
    excludeLabels: z
      .array(z.string())
      .default(DEFAULT_EXCLUDE_LABELS)
      .describe('Gmail labels never synced.'),
  }),
  jobs: {
    sync: {
      trigger: 'schedule',
      schedule: '*/5 * * * *',
      uses: ['Secrets', 'Http', 'Content', 'Log'],
    },
  },
})
