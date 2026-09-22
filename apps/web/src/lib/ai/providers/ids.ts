import { z } from 'zod'

/**
 * Provider ids and the settings inputs, with nothing server-side imported —
 * the server-fn module's validators are evaluated in the client bundle too,
 * so what they read has to be safe to ship there.
 *
 * The five ids are the ones the settings form accepts. Anthropic is the one
 * with an adapter (SPA-29); the other four land with SPA-39, each as one file
 * under `llm/`, one arm in `languageModelFor` and one entry in
 * `BUILT_LLM_PROVIDERS`.
 */
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/** Providers whose adapter exists — what the settings ledger draws a row for. */
export const BUILT_LLM_PROVIDERS = [
  'anthropic',
] as const satisfies readonly LlmProvider[]

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
}

/**
 * The Providers form. `key` is optional because a configured provider can
 * change its base URL or headers without re-pasting the key; an empty
 * `baseUrl` clears it, and `headers` is the raw `Name: value` lines, parsed
 * server-side by `parseHeaderLines` so the refusal names the line.
 */
export const aiKeyInput = z.object({
  provider: z.enum(LLM_PROVIDERS),
  key: z.string().trim().max(4000).optional(),
  baseUrl: z.union([z.literal(''), z.string().trim().url()]).default(''),
  headers: z.string().max(4000).default(''),
})
export type AiKeyInput = z.infer<typeof aiKeyInput>

export const aiProviderInput = z.object({ provider: z.enum(LLM_PROVIDERS) })
