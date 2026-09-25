import { createOllama } from 'ollama-ai-provider-v2'
import type { OllamaProviderSettings } from 'ollama-ai-provider-v2'
import { ollamaApiRoot } from '../llm/ollama'
import { EMBEDDING_PROVIDER_INFO } from './ids'
import { sdkDimensionOptions, sdkEmbedCall } from './adapter'
import type { EmbedAdapterInput, EmbedCall } from './adapter'

/**
 * The Ollama embedding adapter (SPA-83): `POST /api/embed` through
 * `ollama-ai-provider-v2`'s own embedding model — the package already
 * installed for the LLM adapter ships one at 4.0.1, so no new dependency
 * and no hand-rolled transport.
 *
 * It reads the LLM adapter's keyless credential (`embeddingCredentialProvider`
 * answers `ollama` for it): the secret is the empty string and nothing here
 * reads it; the base URL is the one the operator typed under Providers,
 * resolved to the API root by the same `ollamaApiRoot`. Because Ollama is an
 * HTTP server, the web process (a search query) and the worker (a document's
 * chunks) both reach it with this one call — no in-process model, no seam.
 *
 * No width is requested (`sdkDimensionOptions` answers nothing for Ollama):
 * the one pinnable model, `nomic-embed-text`, is 768 natively, and `embed()`
 * asserts every vector's width whatever the adapter asked for.
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
