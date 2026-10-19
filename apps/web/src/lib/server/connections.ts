import { createServerFn } from '@tanstack/react-start'
import {
  connectionIdInput,
  mailboxSyncInput,
  providerAppInput,
  recorderKeyInput,
  recorderSettingsInput,
} from '../connections/input'

export type {
  AccountsView,
  ConnectionDisconnectResult,
  ConnectionIdInput,
  ConnectionListRow,
  MailboxSyncInput,
  MailboxSyncResult,
  MailboxSyncView,
  ProviderAppInput,
  ProviderAppRow,
  MeetingNotesView,
  RecorderAccountView,
  RecorderKeyInput,
  RecorderOffer,
  RecorderSettingsInput,
} from '../connections/input'

/**
 * Settings → Connection apps: the providers' OAuth apps — written by an
 * admin, read by any member with the secret redacted (D81) — and the
 * reader's own accounts under You.
 * Bodies are imported inside the handler so the vault never reaches the
 * client bundle.
 */

/** Each provider's OAuth app: configured or not, client id, redacted secret, redirect URI. */
export const getProviderApps = createServerFn().handler(async () => {
  const { getProviderAppsHandler } =
    await import('../connections/provider-apps')
  return getProviderAppsHandler()
})

/** Saves a provider's client id and, when given, its secret; returns the redacted row. */
export const setProviderApp = createServerFn({ method: 'POST' })
  .validator(providerAppInput)
  .handler(async ({ data }) => {
    const { setProviderAppHandler } =
      await import('../connections/provider-apps')
    return setProviderAppHandler(data)
  })

/**
 * The accounts pages under You: the session user's own connections (never
 * another member's, no tokens), the providers with a client, and which
 * plugins are installed or offered.
 */
export const getMyAccounts = createServerFn().handler(async () => {
  const { listAccountsHandler } = await import('../connections/list')
  return listAccountsHandler()
})

/** Disconnect one product: deletes the row; revokes when it was the account's last product. */
export const disconnectConnection = createServerFn({ method: 'POST' })
  .validator(connectionIdInput)
  .handler(async ({ data }) => {
    const { disconnectConnectionHandler } =
      await import('../connections/custody')
    return disconnectConnectionHandler(data)
  })

/**
 * A synced mailbox's settings on its account page — whether its bodies are
 * shared and its exclude list (D67). The connection's owner only; null when
 * no mail sync is bound to it.
 */
export const getMailboxSync = createServerFn()
  .validator(connectionIdInput)
  .handler(async ({ data }) => {
    const { mailboxSyncHandler } = await import('../arrival/mailbox-sync')
    return mailboxSyncHandler(data)
  })

/** Saves them; mail the list now names is taken out, and bodies follow the toggle. */
export const saveMailboxSync = createServerFn({ method: 'POST' })
  .validator(mailboxSyncInput)
  .handler(async ({ data }) => {
    const { saveMailboxSyncHandler } = await import('../arrival/mailbox-sync')
    return saveMailboxSyncHandler(data)
  })

/** You → Meeting notes: the reader's recorder keys with their folders, and what they can add (D78). */
export const getMeetingNotes = createServerFn().handler(async () => {
  const { meetingNotesHandler } = await import('../connections/recorders')
  return meetingNotesHandler()
})

/** A key the reader pasted: checked with the provider, then one connection row. */
export const connectRecorderKey = createServerFn({ method: 'POST' })
  .validator(recorderKeyInput)
  .handler(async ({ data }) => {
    const { connectRecorderKeyHandler } =
      await import('../connections/recorders')
    return connectRecorderKeyHandler(data)
  })

/** The reader's folder ticks and private opt-ins, applied at once. */
export const saveRecorderSettings = createServerFn({ method: 'POST' })
  .validator(recorderSettingsInput)
  .handler(async ({ data }) => {
    const { saveRecorderSettingsHandler } =
      await import('../connections/recorders')
    return saveRecorderSettingsHandler(data)
  })
