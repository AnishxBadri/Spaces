import { createAnthropic } from '@ai-sdk/anthropic'
import type { AnthropicProviderSettings } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { PROVIDERS } from '../ids'
import type { AdapterInput } from './adapter'

/**
 * The Anthropic LLM adapter (`docs/spec-ai-substrate.md` §9): a vault
 * credential in, an AI SDK `LanguageModel` out. The key comes from the vault
 * and only from the vault — `apiKey` is always passed, so the SDK's
 * `ANTHROPIC_API_KEY` environment fallback can never engage.
 */

export const ANTHROPIC_DEFAULT_MODEL = PROVIDERS.anthropic.defaultModel

export type AnthropicAdapterInput = AdapterInput

export function anthropicLanguageModel(input: AdapterInput): LanguageModel {
  const settings: AnthropicProviderSettings = {
    apiKey: input.secret,
    baseURL: input.meta.baseUrl ?? PROVIDERS.anthropic.defaultBaseUrl,
  }
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createAnthropic(settings)(input.modelId ?? ANTHROPIC_DEFAULT_MODEL)
}
