import { createServerFn } from '@tanstack/react-start'
import { mailboxInput } from '../arrival/input'

/**
 * Settings → Email forwarding: the forwarding mailbox. The writes are
 * admin-only and the read is any member's, the password redacted (D81); the
 * bodies live in `lib/arrival/settings.ts` and are imported inside the handler so the vault and
 * imapflow never reach the client bundle — this module is re-exported by the
 * client-imported `server-fns` barrel.
 */

export const getMailboxSettings = createServerFn().handler(async () => {
  const { getMailboxSettingsHandler } = await import('../arrival/settings')
  return getMailboxSettingsHandler()
})

/** Saves the mailbox (and a new app password, when typed) and polls it once. */
export const saveMailbox = createServerFn({ method: 'POST' })
  .validator(mailboxInput)
  .handler(async ({ data }) => {
    const { saveMailboxHandler } = await import('../arrival/settings')
    return saveMailboxHandler(data)
  })

/**
 * Logs in and opens the folder; `{ok: false, message}` carries the server's
 * words. Takes the save's shape, so an unsaved form can be tried first.
 */
export const testMailbox = createServerFn({ method: 'POST' })
  .validator(mailboxInput)
  .handler(async ({ data }) => {
    const { testMailboxHandler } = await import('../arrival/settings')
    return testMailboxHandler(data)
  })
