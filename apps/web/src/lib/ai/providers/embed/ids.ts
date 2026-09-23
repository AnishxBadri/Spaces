import { z } from 'zod'

/**
 * Embedding providers, their models and the pin's copy, with nothing
 * server-side imported — the Embeddings section and the server-fn validators
 * both read this, and the validators are evaluated in the client bundle too
 * (SPA-51, `docs/spec-ai-substrate.md` §9, CONTEXT.md "Embeddings — the
 * dimension trap").
 *
 * The workspace pins a **dimension**, not only a model: `chunk.embedding` is
 * `vector(768)`, so a model is pinnable only if it can emit exactly 768
 * floats — natively, or because its API takes a width and 768 is one it
 * accepts. Anything else is listed greyed as "needs re-pin" and cannot be
 * chosen: re-pin (ALTER COLUMN TYPE, index rebuild, full re-embed) is not
 * built, and a vector of another width would be silently garbage.
 */

/** The width every stored vector has. `chunk.embedding` is `vector(768)`. */
export const PIN_DIMS = 768

export const EMBEDDING_PROVIDERS = ['openai', 'google', 'voyage'] as const
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number]

/**
 * - `local` — runs on the operator's box. None does yet: the local slot
 *   (Ollama, transformers.js) is SPA-83's, so today a `sensitive` embed has
 *   nowhere to go and is refused.
 * - `defaultBaseUrl` — passed to the SDK explicitly, so an SDK's environment
 *   fallback never decides where text is sent.
 */
export type EmbeddingProviderDescriptor = {
  id: EmbeddingProvider
  label: string
  local: boolean
  defaultBaseUrl: string
  keyPlaceholder: string
}

export const EMBEDDING_PROVIDER_INFO: Record<
  EmbeddingProvider,
  EmbeddingProviderDescriptor
> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-…',
  },
  google: {
    id: 'google',
    label: 'Google',
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza…',
  },
  voyage: {
    id: 'voyage',
    label: 'Voyage',
    local: false,
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    keyPlaceholder: 'pa-…',
  },
}

export type EmbeddingModelInfo = {
  provider: EmbeddingProvider
  id: string
  /** What the model emits when asked for no particular width. */
  nativeDims: number
  /** Whether it can be made to emit `PIN_DIMS`, natively or by request. */
  emitsPin: boolean
}

/**
 * The catalogue, static. Each row's `emitsPin` is the provider's documented
 * contract for that model:
 *
 * - OpenAI `text-embedding-3-small` (1536) and `-3-large` (3072) take a
 *   `dimensions` parameter and truncate to 768 on request → pinnable.
 *   `text-embedding-ada-002` has no such parameter: 1536 only → greyed.
 * - Google `text-embedding-004` is 768 natively; `gemini-embedding-001`
 *   (3072) takes `outputDimensionality: 768` → both pinnable.
 * - Voyage `voyage-3.5` and `voyage-3.5-lite` (1024) take `output_dimension`,
 *   but only one of 256, 512, 1024 or 2048 — 768 is not among them → greyed.
 *   Listed anyway so the admin sees why rather than wondering where Voyage
 *   went; the adapter is built so a same-width model is a table row away.
 */
export const EMBEDDING_MODELS: ReadonlyArray<EmbeddingModelInfo> = [
  {
    provider: 'openai',
    id: 'text-embedding-3-small',
    nativeDims: 1536,
    emitsPin: true,
  },
  {
    provider: 'openai',
    id: 'text-embedding-3-large',
    nativeDims: 3072,
    emitsPin: true,
  },
  {
    provider: 'openai',
    id: 'text-embedding-ada-002',
    nativeDims: 1536,
    emitsPin: false,
  },
  {
    provider: 'google',
    id: 'text-embedding-004',
    nativeDims: 768,
    emitsPin: true,
  },
  {
    provider: 'google',
    id: 'gemini-embedding-001',
    nativeDims: 3072,
    emitsPin: true,
  },
  { provider: 'voyage', id: 'voyage-3.5', nativeDims: 1024, emitsPin: false },
  {
    provider: 'voyage',
    id: 'voyage-3.5-lite',
    nativeDims: 1024,
    emitsPin: false,
  },
]

export const modelsFor = (
  provider: EmbeddingProvider,
): ReadonlyArray<EmbeddingModelInfo> =>
  EMBEDDING_MODELS.filter((m) => m.provider === provider)

export const findEmbeddingModel = (
  provider: string,
  model: string,
): EmbeddingModelInfo | undefined =>
  EMBEDDING_MODELS.find((m) => m.provider === provider && m.id === model)

export const isEmbeddingProvider = (
  value: string,
): value is EmbeddingProvider => EMBEDDING_PROVIDERS.some((p) => p === value)

/**
 * The vault's provider id for an embedding key. Not the bare `openai`: a
 * workspace credential is one row per `(scope, provider)`, so an embedding
 * key stored as `openai` would overwrite the OpenAI LLM key in place. The
 * prefix gives the embedding key its own row — and its own AAD, which is
 * `scope:provider` — while `kind: 'embedding'` says what the row holds.
 */
export const embeddingCredentialProvider = (provider: EmbeddingProvider) =>
  `embed:${provider}`

// The copy. The wording is the safety mechanism (SPA-51), so each sentence
// is spelled once, here, and the server and the section both read it.

/** A greyed row's note, with the model's real width. */
export const needsRepinNote = (model: EmbeddingModelInfo): string =>
  `needs re-pin — emits ${model.nativeDims}, this workspace stores ${PIN_DIMS}`

export const NO_PIN_HEADLINE =
  'No embedding model — search matches words, not meaning.'

export type EmbeddingPinView = {
  provider: EmbeddingProvider
  model: string
  dims: number
  /** ISO instant. */
  pinnedAt: string
}

export const pinHeadline = (pin: EmbeddingPinView): string =>
  `Pinned to ${EMBEDDING_PROVIDER_INFO[pin.provider].label} ${pin.model} at ${pin.dims} dimensions since ${pin.pinnedAt.slice(0, 10)}.`

/** Why an existing pin will not move. */
export const pinLockedMessage = (pin: {
  provider: EmbeddingProvider
  model: string
}): string =>
  `Embeddings are pinned to ${EMBEDDING_PROVIDER_INFO[pin.provider].label} ${pin.model}. Switching models means re-embedding every chunk, which this version cannot do yet. A swap to another ${PIN_DIMS}-wide model arrives with the backfill job.`

// The server fns' inputs.

export const embeddingProviderInput = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
})

export const embeddingKeyInput = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
  key: z.string().trim().min(1).max(4000),
})
export type EmbeddingKeyInput = z.infer<typeof embeddingKeyInput>

export const embeddingTargetInput = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
  model: z.string().trim().min(1).max(200),
})
export type EmbeddingTarget = z.infer<typeof embeddingTargetInput>
