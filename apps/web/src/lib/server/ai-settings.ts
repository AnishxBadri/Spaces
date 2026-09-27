import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { aiKeyInput, aiProviderInput } from '../ai/providers/ids'
import { aiLaneInput, aiRouteInput } from '../ai/lanes'
import { aiCapsInput } from '../ai/caps-input'
import {
  embeddingKeyInput,
  embeddingTargetInput,
} from '../ai/providers/embed/ids'

/**
 * Settings → AI (SPA-29). Admin-only, every one but `isLaneRouted` and the
 * Usage reads (SPA-100), which say why where they stand: the bodies live in
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

/**
 * Settings → AI · Caps (SPA-73): the workspace token caps, admin-only like
 * the rest of Settings → AI. The bodies live in `lib/ai/caps.ts`, whose
 * handlers open with `requireAdmin()`.
 */
export const getAiCaps = createServerFn().handler(async () => {
  const { getAiCapsHandler } = await import('../ai/caps')
  return getAiCapsHandler()
})

/** Both ceilings at once; a null is no cap on that axis. */
export const setAiCaps = createServerFn({ method: 'POST' })
  .validator(aiCapsInput)
  .handler(async ({ data }) => {
    const { setAiCapsHandler } = await import('../ai/caps')
    return setAiCapsHandler(data)
  })

/** Tokens in + out recorded in `ai_usage` since 00:00 UTC. */
export const getAiUsageToday = createServerFn().handler(async () => {
  const { getAiUsageTodayHandler } = await import('../ai/caps')
  return getAiUsageTodayHandler()
})

/**
 * Settings → Usage (SPA-100): the run log, newest first, and the calls no
 * run owns. Any signed-in member may read it — it is provenance, and the
 * inbox's "produced by this run" opens it; the body lives in
 * `lib/ai/usage.ts`, whose handlers open with `requireUser()`.
 */
export const getAiUsage = createServerFn().handler(async () => {
  const { getAiUsageHandler } = await import('../ai/usage')
  return getAiUsageHandler()
})

/** One run opened: its steps, refs resolved, and what it proposed. */
export const getAiRun = createServerFn()
  .validator(z.object({ runId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { getAiRunHandler } = await import('../ai/usage')
    return getAiRunHandler(data.runId)
  })

/**
 * Settings → AI · Embeddings (SPA-51): the pin, the embedding keys, the Test
 * call. Admin-only like the rest of Settings → AI; the bodies live in
 * `lib/ai/providers/embed/settings.ts`, whose handlers open with
 * `requireAdmin()`.
 */
export const getEmbeddingSettings = createServerFn().handler(async () => {
  const { getEmbeddingSettingsHandler } =
    await import('../ai/providers/embed/settings')
  return getEmbeddingSettingsHandler()
})

/** Stores the workspace embedding key (`kind: 'embedding'`); returns only the redacted display. */
export const saveEmbeddingKey = createServerFn({ method: 'POST' })
  .validator(embeddingKeyInput)
  .handler(async ({ data }) => {
    const { saveEmbeddingKeyHandler } =
      await import('../ai/providers/embed/settings')
    return saveEmbeddingKeyHandler(data)
  })

/** Embeds "Spaces" with one model: the width, the first four values, the model id. */
export const testEmbedding = createServerFn({ method: 'POST' })
  .validator(embeddingTargetInput)
  .handler(async ({ data }) => {
    const { testEmbeddingHandler } =
      await import('../ai/providers/embed/settings')
    return testEmbeddingHandler(data)
  })

/**
 * Pins the workspace to one model at 768 dimensions, or swaps a pinned one
 * for another 768-wide model (SPA-136) — which offers the backfill and does
 * not start it. Refused — `PinLocked`, with the re-pin explanation — when the
 * new model would change the width.
 */
export const pinEmbedding = createServerFn({ method: 'POST' })
  .validator(embeddingTargetInput)
  .handler(async ({ data }) => {
    const { pinEmbeddingHandler } =
      await import('../ai/providers/embed/settings')
    return pinEmbeddingHandler(data)
  })

/**
 * Settings → Embeddings · Backfill (SPA-136): the pending count, the
 * pre-flight estimate and where the run stands — database reads and a queue
 * read, never a provider call. Admin-only; the body opens with
 * `requireAdmin()`.
 */
export const getEmbedBackfill = createServerFn().handler(async () => {
  const { getEmbedBackfillHandler } = await import('../ai/embed-backfill')
  return getEmbedBackfillHandler()
})

/**
 * Enqueues the one backfill run, keyed, once the admin has confirmed the
 * estimate. A second press while a run is queued, running or paused for the
 * cap's reset answers `already-queued`.
 */
export const startEmbedBackfill = createServerFn({ method: 'POST' }).handler(
  async () => {
    const { startEmbedBackfillHandler } = await import('../ai/embed-backfill')
    return startEmbedBackfillHandler()
  },
)

/**
 * Settings → Embeddings · Sensitive slot (SPA-83, D11): a local model beside
 * a cloud pin that sensitive records embed through. Refused — `SlotRefused`,
 * with the reason — unless the model is local, Test-green and the pin's
 * width. Admin-only; the bodies open with `requireAdmin()`.
 */
export const setSensitiveSlot = createServerFn({ method: 'POST' })
  .validator(embeddingTargetInput)
  .handler(async ({ data }) => {
    const { setSensitiveSlotHandler } =
      await import('../ai/providers/embed/settings')
    return setSensitiveSlotHandler(data)
  })

/** Clears the slot: sensitive records are refused again and left unembedded. */
export const clearSensitiveSlot = createServerFn({ method: 'POST' }).handler(
  async () => {
    const { clearSensitiveSlotHandler } =
      await import('../ai/providers/embed/settings')
    return clearSensitiveSlotHandler()
  },
)
