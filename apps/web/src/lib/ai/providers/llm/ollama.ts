import type { LanguageModel } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import type { OllamaProviderSettings } from 'ollama-ai-provider-v2'
import { PROVIDERS } from '../ids'
import type { AdapterInput } from './adapter'

/**
 * The Ollama LLM adapter (SPA-39), through `ollama-ai-provider-v2` against
 * Ollama's native `/api` rather than its OpenAI-compatible `/v1`.
 *
 * Keyless: the credential's secret is the empty string the settings save
 * stores for a keyless provider (see `saveAiKeyProgram`), and nothing here
 * reads it. A proxy in front of Ollama that wants a token gets it through the
 * extra-headers field, like any other gateway.
 */

export const OLLAMA_DEFAULT_MODEL = PROVIDERS.ollama.defaultModel

/**
 * The operator types the server's address (`http://localhost:11434`, what
 * `ollama serve` listens on); the SDK wants the API root under it. A base URL
 * that already ends in `/api` is taken as given.
 */
export function ollamaApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
}

export function ollamaLanguageModel(input: AdapterInput): LanguageModel {
  const settings: OllamaProviderSettings = {
    baseURL: ollamaApiRoot(
      input.meta.baseUrl ?? PROVIDERS.ollama.defaultBaseUrl,
    ),
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createOllama(settings)(input.modelId ?? OLLAMA_DEFAULT_MODEL)
}
