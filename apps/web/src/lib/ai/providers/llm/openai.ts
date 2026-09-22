import { createOpenAI } from '@ai-sdk/openai'
import type { OpenAIProviderSettings } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { PROVIDERS } from '../ids'
import type { AdapterInput } from './adapter'

/**
 * The OpenAI LLM adapter (SPA-39). Chat Completions rather than the SDK's
 * default Responses API, on purpose: Responses keeps the conversation on
 * OpenAI's side unless told not to, and Chat Completions is the surface every
 * gateway an operator might point this at (LiteLLM, Helicone, Portkey)
 * speaks.
 */

export const OPENAI_DEFAULT_MODEL = PROVIDERS.openai.defaultModel

export function openaiLanguageModel(input: AdapterInput): LanguageModel {
  const settings: OpenAIProviderSettings = {
    apiKey: input.secret,
    baseURL: input.meta.baseUrl ?? PROVIDERS.openai.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createOpenAI(settings).chat(input.modelId ?? OPENAI_DEFAULT_MODEL)
}
