import { z } from 'zod'
import { formatNumber } from '@spaces/core/format'
import { PROVIDERS } from '../ids'

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

export const EMBEDDING_PROVIDERS = [
  'openai',
  'google',
  'voyage',
  'ollama',
] as const
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number]

/** The providers that take a pasted key — every one but Ollama. */
export const KEYED_EMBEDDING_PROVIDERS = [
  'openai',
  'google',
  'voyage',
] as const satisfies ReadonlyArray<EmbeddingProvider>

/**
 * - `local` — runs on a box the operator runs (Ollama, SPA-83). A
 *   `sensitive` embed may go to a local provider and to nothing else: the
 *   pin itself when it is local, else the sensitive slot, else refused.
 * - `keyless` — authenticates nobody, and has no embedding key of its own:
 *   it reuses the LLM provider's credential (`embeddingCredentialProvider`).
 * - `defaultBaseUrl` — passed to the SDK explicitly, so an SDK's environment
 *   fallback never decides where text is sent.
 */
export type EmbeddingProviderDescriptor = {
  id: EmbeddingProvider
  label: string
  local: boolean
  keyless: boolean
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
    keyless: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-…',
  },
  google: {
    id: 'google',
    label: 'Google',
    local: false,
    keyless: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza…',
  },
  voyage: {
    id: 'voyage',
    label: 'Voyage',
    local: false,
    keyless: false,
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    keyPlaceholder: 'pa-…',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    local: true,
    keyless: true,
    defaultBaseUrl: PROVIDERS.ollama.defaultBaseUrl,
    keyPlaceholder: '',
  },
}

export type EmbeddingModelInfo = {
  provider: EmbeddingProvider
  id: string
  /** What the model emits when asked for no particular width. */
  nativeDims: number
  /** Whether it can be made to emit `PIN_DIMS`, natively or by request. */
  emitsPin: boolean
  /**
   * The provider's list price per million input tokens, in US dollars — what
   * the backfill's pre-flight estimate multiplies by (SPA-136). An estimate,
   * never a bill: the catalogue's note says where each figure came from.
   */
  usdPerMillionTokens: number
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
 *
 * `usdPerMillionTokens` (SPA-136) is each provider's published list price
 * for input tokens **as of 2026-09-23**, written down by hand, and every
 * figure is an estimate: the backfill's pre-flight line is its only reader
 * and says so. None was read from an installed package — the provider SDKs
 * carry no pricing. OpenAI's three ($0.02, $0.13, $0.10) and Voyage's two
 * ($0.06, $0.02) are long-standing list prices; Google's
 * `gemini-embedding-001` ($0.15) is its paid-tier price. `text-embedding-004`
 * ($0.10) is **unverified** — the Gemini API has listed it free on some
 * tiers, so this errs high. A local model (SPA-83's slot) reads "free" by its
 * provider's `local` flag, not by a zero here.
 *
 * - Ollama (SPA-83) `nomic-embed-text` is 768 natively → pinnable, and the
 *   model a sensitive slot is built for. `mxbai-embed-large` is 1024 and
 *   Ollama truncates nothing for it → greyed. Their price is 0 only because
 *   the field is a number; the estimate never reads it for a local provider.
 */
export const EMBEDDING_MODELS: ReadonlyArray<EmbeddingModelInfo> = [
  {
    provider: 'openai',
    id: 'text-embedding-3-small',
    nativeDims: 1536,
    emitsPin: true,
    usdPerMillionTokens: 0.02,
  },
  {
    provider: 'openai',
    id: 'text-embedding-3-large',
    nativeDims: 3072,
    emitsPin: true,
    usdPerMillionTokens: 0.13,
  },
  {
    provider: 'openai',
    id: 'text-embedding-ada-002',
    nativeDims: 1536,
    emitsPin: false,
    usdPerMillionTokens: 0.1,
  },
  {
    provider: 'google',
    id: 'text-embedding-004',
    nativeDims: 768,
    emitsPin: true,
    usdPerMillionTokens: 0.1,
  },
  {
    provider: 'google',
    id: 'gemini-embedding-001',
    nativeDims: 3072,
    emitsPin: true,
    usdPerMillionTokens: 0.15,
  },
  {
    provider: 'voyage',
    id: 'voyage-3.5',
    nativeDims: 1024,
    emitsPin: false,
    usdPerMillionTokens: 0.06,
  },
  {
    provider: 'voyage',
    id: 'voyage-3.5-lite',
    nativeDims: 1024,
    emitsPin: false,
    usdPerMillionTokens: 0.02,
  },
  {
    provider: 'ollama',
    id: 'nomic-embed-text',
    nativeDims: 768,
    emitsPin: true,
    usdPerMillionTokens: 0,
  },
  {
    provider: 'ollama',
    id: 'mxbai-embed-large',
    nativeDims: 1024,
    emitsPin: false,
    usdPerMillionTokens: 0,
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
 *
 * **A keyless provider reuses the LLM row** (SPA-83): Ollama's credential
 * is a base URL and no secret, so there is no key to keep apart, and a
 * second `embed:ollama` row would be a second address for one server that
 * could drift from the first. The embedding adapter reads the row the
 * Providers section writes (`kind: 'llm'`, provider `ollama`), and nothing
 * here writes to it but the embed Test's own verdict keys.
 */
export const embeddingCredentialProvider = (provider: EmbeddingProvider) =>
  EMBEDDING_PROVIDER_INFO[provider].keyless ? provider : `embed:${provider}`

/**
 * Where to point an embedding provider's address, said once for the
 * Embeddings section: the three deployments Ollama is run in beside Spaces.
 */
export const OLLAMA_URL_GUIDANCE =
  'http://ollama:11434 for the compose sidecar, http://host.docker.internal:11434 for Ollama on the host, a LAN address for a shared box.'

/** No credential for `provider`: what to save, and where, before `doing`. */
export const missingCredentialMessage = (
  provider: EmbeddingProvider,
  doing: string,
): string =>
  EMBEDDING_PROVIDER_INFO[provider].keyless
    ? `Save the ${EMBEDDING_PROVIDER_INFO[provider].label} address under Settings → AI · Providers before ${doing}`
    : `Save a ${EMBEDDING_PROVIDER_INFO[provider].label} embedding key before ${doing}`

/**
 * Ollama answers 404 for a model the server has not pulled. The Test call
 * turns that into the one command that fixes it.
 */
export const ollamaNotPulledMessage = (model: string): string =>
  `${model} is not pulled on this Ollama server — run "ollama pull ${model}" there, then test again`

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

/**
 * Why an existing pin will not move to `target`: a different width. A
 * same-width swap is allowed since SPA-136 (`pinSwapNote`); a change of
 * width is the unbuilt half of re-pin, and the sentence says what it needs.
 */
export const pinLockedMessage = (
  pin: { provider: EmbeddingProvider; model: string; dims: number },
  target: EmbeddingModelInfo,
): string =>
  `Embeddings are pinned to ${EMBEDDING_PROVIDER_INFO[pin.provider].label} ${pin.model} at ${pin.dims} dimensions. ${target.id} emits ${target.emitsPin ? PIN_DIMS : target.nativeDims}; changing the width means altering the vector column and rebuilding its index, which this version cannot do yet.`

/** What a same-width swap does to what is stored, said before it is made. */
export const pinSwapNote = (
  pin: { model: string },
  target: { provider: EmbeddingProvider; model: string },
): string =>
  `Swapping to ${EMBEDDING_PROVIDER_INFO[target.provider].label} ${target.model} keeps the ${PIN_DIMS}-wide column. Every stored vector is ${pin.model}'s, so search leaves them out until a backfill re-embeds them.`

// The sensitive slot (SPA-83, D11): a local provider beside the pin, at the
// pin's width, that sensitive records are embedded through.

export type EmbeddingSlotView = {
  provider: EmbeddingProvider
  model: string
  dims: number
  /** ISO instant. */
  setAt: string
}

/** The width a catalogue model would store: the pin's, or its own. */
export const storedDims = (model: EmbeddingModelInfo): number =>
  model.emitsPin ? PIN_DIMS : model.nativeDims

export const NO_SLOT_HEADLINE =
  'No sensitive slot — sensitive records are left unembedded.'

export const LOCAL_PIN_HEADLINE =
  'The pin runs locally — sensitive records embed through it.'

export const slotHeadline = (slot: EmbeddingSlotView): string =>
  `Sensitive records embed through ${EMBEDDING_PROVIDER_INFO[slot.provider].label} ${slot.model} at ${slot.dims} dimensions.`

/** Why a slot model is refused: its width is not the pin's. Both numbers. */
export const slotDimsMessage = (
  pin: { dims: number },
  model: EmbeddingModelInfo,
): string =>
  `${EMBEDDING_PROVIDER_INFO[model.provider].label} ${model.id} emits ${storedDims(model)}; the pin stores ${pin.dims}. The sensitive slot must match the pin's width.`

/**
 * What search does with the slot's vectors. The semantic lane keeps rows
 * whose `embedding_model` is the pin's, and one model's vectors are noise to
 * another's query even at the same width — so a slot on another model
 * embeds sensitive records that semantic search then cannot reach.
 */
export const slotSearchNote = (
  pin: { model: string },
  slot: { model: string },
): string =>
  slot.model === pin.model
    ? `Search reads these vectors: the slot and the pin are both ${pin.model}.`
    : `Search reads only ${pin.model}'s vectors, so sensitive records embedded by ${slot.model} stay out of semantic search — the same width is not the same model.`

// The backfill's pre-flight estimate (SPA-136). The one place in the product
// that asks before it embeds, so the figure is shown before anything runs.

/** What the estimate needs to know about the pinned model. */
export type BackfillPricing = {
  /** The provider runs on the operator's box: nothing is billed. */
  local: boolean
  usdPerMillionTokens: number
}

export const pricingOf = (
  provider: EmbeddingProvider,
  model: EmbeddingModelInfo,
): BackfillPricing => ({
  local: EMBEDDING_PROVIDER_INFO[provider].local,
  usdPerMillionTokens: model.usdPerMillionTokens,
})

/**
 * The cost half of the estimate: "free — local model" for a local provider,
 * whatever its catalogue row says; otherwise tokens × the list price, never
 * compact, and a sub-cent figure said as one rather than rounded to $0.00.
 */
export function backfillCostLabel(
  tokens: number,
  pricing: BackfillPricing,
): string {
  if (pricing.local) return 'free — local model'
  const usd = (tokens / 1_000_000) * pricing.usdPerMillionTokens
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return 'under $0.01'
  return `~$${formatNumber(usd, 2)}`
}

export type BackfillEstimate = {
  /** Chunks not yet carrying the pinned model's vector. */
  chunks: number
  /** Their characters ÷ 4, the cap's own rule (`estimateTokens`). */
  tokens: number
  /** `backfillCostLabel`'s answer. */
  cost: string
}

export const backfillEstimateLine = (e: BackfillEstimate): string =>
  `${formatNumber(e.chunks, 0)} ${e.chunks === 1 ? 'chunk' : 'chunks'} · ~${formatNumber(e.tokens, 0)} tokens · ${e.cost}`

/** The sensitive half of the estimate: chunks only a local model may take. */
export const sensitiveEstimateLine = (e: BackfillEstimate): string =>
  `${formatNumber(e.chunks, 0)} sensitive ${e.chunks === 1 ? 'chunk' : 'chunks'} · ~${formatNumber(e.tokens, 0)} tokens · ${e.cost}`

export const backfillProgressLine = (embedded: number, total: number): string =>
  `embedded ${formatNumber(embedded, 0)} of ${formatNumber(total, 0)}`

// The server fns' inputs.

export const embeddingProviderInput = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
})

export const embeddingKeyInput = z.object({
  provider: z.enum(KEYED_EMBEDDING_PROVIDERS),
  key: z.string().trim().min(1).max(4000),
})
export type EmbeddingKeyInput = z.infer<typeof embeddingKeyInput>

export const embeddingTargetInput = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
  model: z.string().trim().min(1).max(200),
})
export type EmbeddingTarget = z.infer<typeof embeddingTargetInput>
