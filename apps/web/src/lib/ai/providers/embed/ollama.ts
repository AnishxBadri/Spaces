import { createOllama } from 'ollama-ai-provider-v2'
import type { OllamaProviderSettings } from 'ollama-ai-provider-v2'
import { ollamaApiRoot } from '../llm/ollama'
import { EMBEDDING_PROVIDER_INFO } from './ids'
import { sdkDimensionOptions, sdkEmbedCall } from './adapter'
import type { EmbedAdapterInput, EmbedCall } from './adapter'

/**
 * The Ollama embedding adapter: `POST /api/embed` through
 * `ollama-ai-provider-v2`'s embedding model.
 * - Reads the LLM keyless credential: the secret is empty and unread; the
 *   base URL goes through `ollamaApiRoot`.
 * - No width is requested: `nomic-embed-text` is 768 natively, and `embed()`
 *   asserts every vector's width anyway.
 */
export function ollamaEmbedCall(input: EmbedAdapterInput): EmbedCall {
  const settings: OllamaProviderSettings = {
    baseURL: ollamaApiRoot(
      input.meta.baseUrl ?? EMBEDDING_PROVIDER_INFO.ollama.defaultBaseUrl,
    ),
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return sdkEmbedCall(
    'ollama',
    createOllama(settings).textEmbeddingModel(input.modelId),
    sdkDimensionOptions('ollama', input.dims),
    input.maxRetries,
  )
}
