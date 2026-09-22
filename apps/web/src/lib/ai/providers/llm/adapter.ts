import type { ProviderMeta } from '../meta'

/**
 * What every LLM adapter takes (`docs/spec-ai-substrate.md` §9): the vault
 * credential's secret and its non-secret `meta`, an optional model id, and an
 * optional transport. Every adapter passes `baseURL` (and, where the provider
 * has a key, `apiKey`) explicitly, so an SDK's environment fallback
 * (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, …) can never decide whose key is spent
 * or where a prompt goes.
 */
export type AdapterInput = {
  secret: string
  meta: Pick<ProviderMeta, 'baseUrl' | 'headers'>
  modelId?: string
  /**
   * The transport. Omitted in production (global `fetch`); a test hands in a
   * stub that records the request, so the constructed client can be asserted
   * against with no network.
   */
  fetch?: typeof fetch
}
