import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { PROVIDERS } from '../ids'
import type { AdapterInput } from './adapter'

/**
 * The OpenRouter LLM adapter (SPA-39), through OpenRouter's own AI SDK
 * provider. No `appName` / `appUrl`: those send attribution headers to
 * OpenRouter's dashboard, which is the operator's call to make through the
 * extra-headers field, not ours to make by default.
 */

export const OPENROUTER_DEFAULT_MODEL = PROVIDERS.openrouter.defaultModel

export function openrouterLanguageModel(input: AdapterInput): LanguageModel {
  const settings: OpenRouterProviderSettings = {
    apiKey: input.secret,
    baseURL: input.meta.baseUrl ?? PROVIDERS.openrouter.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createOpenRouter(settings)(input.modelId ?? OPENROUTER_DEFAULT_MODEL)
}
