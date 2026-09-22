import { createServerFn } from '@tanstack/react-start'
import { aiKeyInput, aiProviderInput } from '../ai/providers/ids'
import { aiLaneInput, aiRouteInput } from '../ai/lanes'

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
 * One cell of the lane × sensitivity routing grid (SPA-42), upserted — or,
 * with `provider: null`, cleared (SPA-69). The Routing ledger writes through
 * it; so does a seed: "set the classify lane to Anthropic" is
 * `{lane: 'classify', sensitivity: 'normal', provider: 'anthropic', model}`.
 */
export const setAiRoute = createServerFn({ method: 'POST' })
  .validator(aiRouteInput)
  .handler(async ({ data }) => {
    const { setAiRouteHandler } = await import('../ai/route')
    return setAiRouteHandler(data)
  })

/**
 * The Routing ledger's read (SPA-69): every stored cell. Admin-only, like the
 * rest of Settings → AI.
 */
export const listAiRoutes = createServerFn().handler(async () => {
  const { listAiRoutesHandler } = await import('../ai/route')
  return listAiRoutesHandler()
})

/**
 * Whether a lane can run, per sensitivity — the gate every AI trigger on a
 * record page hides itself on. Any signed-in member may ask; it never
 * throws, and a lane with no route, or routed to a provider whose credential
 * is gone, reads `false`.
 */
export const isLaneRouted = createServerFn()
  .validator(aiLaneInput)
  .handler(async ({ data }) => {
    const { isLaneRoutedHandler } = await import('../ai/route')
    return isLaneRoutedHandler(data)
  })
