import { createGoogle } from '@ai-sdk/google'
import type { GoogleProviderSettings } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { PROVIDERS } from '../ids'
import type { AdapterInput } from './adapter'

/**
 * The Google (Gemini API) LLM adapter (SPA-39). The key rides the
 * `x-goog-api-key` header, never the query string, so a gateway's request
 * log does not capture it in a URL.
 */

export const GOOGLE_DEFAULT_MODEL = PROVIDERS.google.defaultModel

export function googleLanguageModel(input: AdapterInput): LanguageModel {
  const settings: GoogleProviderSettings = {
    apiKey: input.secret,
    baseURL: input.meta.baseUrl ?? PROVIDERS.google.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createGoogle(settings)(input.modelId ?? GOOGLE_DEFAULT_MODEL)
}
