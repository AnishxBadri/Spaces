import { createServerFn } from '@tanstack/react-start'
import { connectionIdInput, providerAppInput } from '../connections/input'

export type {
  AccountsView,
  ConnectionCustodyRow,
  ConnectionDisconnectResult,
  ConnectionIdInput,
  ConnectionListRow,
  ConnectionRevokeResult,
  ProviderAppInput,
  ProviderAppRow,
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

/** The providers a member can connect to: those with an active OAuth client. */
export const getConfiguredProviders = createServerFn().handler(async () => {
  const { getConfiguredProvidersHandler } =
    await import('../connections/provider-apps')
  return getConfiguredProvidersHandler()
})

/** Saves a provider's client id and, when given, its secret; returns the redacted row. */
export const setProviderApp = createServerFn({ method: 'POST' })
  .validator(providerAppInput)
  .handler(async ({ data }) => {
    const { setProviderAppHandler } =
      await import('../connections/provider-apps')
    return setProviderAppHandler(data)
  })

/** Forces a refresh of one of the session user's connections; never returns the token. */
export const refreshConnection = createServerFn({ method: 'POST' })
  .validator(connectionIdInput)
  .handler(async ({ data }) => {
    const { refreshConnectionHandler } = await import('../connections/custody')
    return refreshConnectionHandler(data)
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

/** Revokes one of the session user's connections at the provider and marks it revoked. */
export const revokeConnection = createServerFn({ method: 'POST' })
  .validator(connectionIdInput)
  .handler(async ({ data }) => {
    const { revokeConnectionHandler } = await import('../connections/custody')
    return revokeConnectionHandler(data)
  })
