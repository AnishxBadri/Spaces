import { createServerFn } from '@tanstack/react-start'
import { mailboxInput, mailboxTestInput } from '../arrival/input'

/**
 * Settings → Arrival (SPA-56): the forwarding mailbox. Admin-only, every one;
 * the bodies live in `lib/arrival/settings.ts`, whose handlers open with
 * `requireAdmin()`, and are imported inside the handler so the vault and
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

/** Logs in and opens the folder; `{ok: false, message}` carries the server's words. */
export const testMailbox = createServerFn({ method: 'POST' })
  .validator(mailboxTestInput)
  .handler(async ({ data }) => {
    const { testMailboxHandler } = await import('../arrival/settings')
    return testMailboxHandler(data)
  })
