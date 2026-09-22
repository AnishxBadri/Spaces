import { z } from 'zod'

/**
 * Provider ids, their descriptors and the settings inputs, with nothing
 * server-side imported — the server-fn module's validators are evaluated in
 * the client bundle too, so what they read has to be safe to ship there.
 *
 * Five providers, each one file under `llm/` and one arm in
 * `languageModelFor` (SPA-29 built Anthropic, SPA-39 the other four).
 */
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/**
 * What the Providers ledger and its form know about a provider — the whole
 * of the per-provider difference in the UI, so a row and its form are drawn
 * from this and never from a branch on the id.
 *
 * - `keyless` — the provider authenticates nobody (a local Ollama): the form
 *   has no key field and saves with a base URL alone.
 * - `defaultBaseUrl` — where the adapter sends when the credential names no
 *   base URL. Passed to the SDK explicitly, so an SDK's own environment
 *   fallback (`OPENAI_BASE_URL`) never decides where a prompt goes.
 * - `defaultModel` — the model the Test call and any caller that names none
 *   gets. The one place each id is spelled; routing (`ai-4b`) picks per lane
 *   later.
 */
export type ProviderDescriptor = {
  id: LlmProvider
  label: string
  keyless: boolean
  defaultBaseUrl: string
  defaultModel: string
  keyPlaceholder: string
}

export const PROVIDERS: Record<LlmProvider, ProviderDescriptor> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyless: false,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-5',
    keyPlaceholder: 'sk-ant-…',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyless: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    keyPlaceholder: 'sk-…',
  },
  google: {
    id: 'google',
    label: 'Google',
    keyless: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.5-flash',
    keyPlaceholder: 'AIza…',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyless: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    keyPlaceholder: 'sk-or-…',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    keyless: true,
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.2',
    keyPlaceholder: '',
  },
}

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: PROVIDERS.anthropic.label,
  openai: PROVIDERS.openai.label,
  google: PROVIDERS.google.label,
  openrouter: PROVIDERS.openrouter.label,
  ollama: PROVIDERS.ollama.label,
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
