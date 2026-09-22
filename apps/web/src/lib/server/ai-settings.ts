import { createServerFn } from '@tanstack/react-start'
import { aiKeyInput, aiProviderInput } from '../ai/providers/ids'
import { aiRouteInput } from '../ai/lanes'

/**
 * Settings → AI (SPA-29). Admin-only, every one: the bodies live in
 * `lib/ai/providers/settings.ts`, whose handlers open with `requireAdmin()`,
 * and are imported inside the handler so the AI SDK and the vault never
 * reach the client bundle — this module is re-exported by the client-imported
 * `server-fns` barrel.
 */

export const listAiProviders = createServerFn().handler(async () => {
  const { listAiProvidersHandler } = await import('../ai/providers/settings')
  return listAiProvidersHandler()
})

/** Stores (or replaces) the workspace key for a provider; returns only the redacted display. */
export const saveAiKey = createServerFn({ method: 'POST' })
  .validator(aiKeyInput)
  .handler(async ({ data }) => {
    const { saveAiKeyHandler } = await import('../ai/providers/settings')
    return saveAiKeyHandler(data)
  })

/**
 * One tiny prompt through the saved key. `{ok: false, message}` carries the
 * provider's own error text (a wrong key reads its 401), not a generic one.
 */
export const testAiProvider = createServerFn({ method: 'POST' })
  .validator(aiProviderInput)
  .handler(async ({ data }) => {
    const { testAiProviderHandler } = await import('../ai/providers/settings')
    return testAiProviderHandler(data)
  })

/**
 * One cell of the lane × sensitivity routing grid (SPA-42), upserted. The
 * seed path until the Routing grid lands (SPA-69): the demo's "set the
 * classify lane to Anthropic" is this fn with
 * `{lane: 'classify', sensitivity: 'normal', provider: 'anthropic', model}`.
 */
export const setAiRoute = createServerFn({ method: 'POST' })
  .validator(aiRouteInput)
  .handler(async ({ data }) => {
    const { setAiRouteHandler } = await import('../ai/route')
    return setAiRouteHandler(data)
  })
