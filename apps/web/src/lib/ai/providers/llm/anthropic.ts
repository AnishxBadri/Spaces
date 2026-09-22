import { createAnthropic } from '@ai-sdk/anthropic'
import type { AnthropicProviderSettings } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { ProviderMeta } from '../meta'

/**
 * The Anthropic LLM adapter (`docs/spec-ai-substrate.md` §9): a vault
 * credential in, an AI SDK `LanguageModel` out. The key comes from the vault
 * and only from the vault — `apiKey` is always passed, so the SDK's
 * `ANTHROPIC_API_KEY` environment fallback can never engage.
 */

/**
 * The model the settings Test call and any caller that names none gets. The
 * one place the id is spelled; routing (`ai-4b`) picks per lane later.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

export type AnthropicAdapterInput = {
  secret: string
  meta: Pick<ProviderMeta, 'baseUrl' | 'headers'>
  modelId?: string
  /**
   * The transport. Omitted in production (global `fetch`); a test hands in a
   * stub that records the request, so the constructed client can be asserted
   * against with no network.
   */
  fetch?: AnthropicProviderSettings['fetch']
}

export function anthropicLanguageModel(
  input: AnthropicAdapterInput,
): LanguageModel {
  const settings: AnthropicProviderSettings = { apiKey: input.secret }
  if (input.meta.baseUrl) settings.baseURL = input.meta.baseUrl
  if (input.meta.headers) settings.headers = input.meta.headers
  if (input.fetch) settings.fetch = input.fetch
  return createAnthropic(settings)(input.modelId ?? ANTHROPIC_DEFAULT_MODEL)
}
