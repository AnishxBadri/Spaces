import { createOpenAI } from '@ai-sdk/openai'
import type { OpenAIProviderSettings } from '@ai-sdk/openai'
import { EMBEDDING_PROVIDER_INFO } from './ids'
import { sdkDimensionOptions, sdkEmbedCall } from './adapter'
import type { EmbedAdapterInput, EmbedCall } from './adapter'

/**
 * The OpenAI embedding adapter (SPA-51): `/v1/embeddings` through the AI
 * SDK, asking for the pin's width with `dimensions` — which the
 * `text-embedding-3-*` models honour by truncating, and `ada-002` rejects,
 * which is why the catalogue greys it.
 */
export function openaiEmbedCall(input: EmbedAdapterInput): EmbedCall {
  const settings: OpenAIProviderSettings = {
    apiKey: input.secret,
    baseURL:
      input.meta.baseUrl ?? EMBEDDING_PROVIDER_INFO.openai.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return sdkEmbedCall(
    'openai',
    createOpenAI(settings).embedding(input.modelId),
    sdkDimensionOptions('openai', input.dims),
    input.maxRetries,
  )
}
