import { createServerFn } from '@tanstack/react-start'
import { providerAppInput } from '../connections/input'

export type { ProviderAppInput, ProviderAppRow } from '../connections/input'

/**
 * Settings → Connections: the providers' OAuth apps. Admin-only; the bodies
 * open with `requireAdmin()` and are imported inside the handler so the
 * vault never reaches the client bundle.
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
