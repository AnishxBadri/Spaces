import { createGoogle } from '@ai-sdk/google'
import type { GoogleProviderSettings } from '@ai-sdk/google'
import { EMBEDDING_PROVIDER_INFO } from './ids'
import { sdkDimensionOptions, sdkEmbedCall } from './adapter'
import type { EmbedAdapterInput, EmbedCall } from './adapter'

/**
 * The Google (Gemini API) embedding adapter (SPA-51), asking for the pin's
 * width with `outputDimensionality`. `text-embedding-004` is 768 already;
 * `gemini-embedding-001` truncates its 3072 on request. The key rides the
 * `x-goog-api-key` header, as the LLM adapter's does.
 */
export function googleEmbedCall(input: EmbedAdapterInput): EmbedCall {
  const settings: GoogleProviderSettings = {
    apiKey: input.secret,
    baseURL:
      input.meta.baseUrl ?? EMBEDDING_PROVIDER_INFO.google.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return sdkEmbedCall(
    'google',
    createGoogle(settings).embedding(input.modelId),
    sdkDimensionOptions('google', input.dims),
    input.maxRetries,
  )
}
