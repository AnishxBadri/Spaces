import { Effect } from 'effect'
import { embedMany } from 'ai'
import type { EmbeddingModel, JSONValue } from 'ai'
import { ProviderCallFailed } from '../../complete'
import type { ProviderMeta } from '../meta'
import type { EmbeddingProvider } from './ids'

/**
 * What every embedding adapter takes and gives (`docs/spec-ai-substrate.md`
 * §9, `ai/providers/embed/`). The input is the LLM adapters' shape plus the
 * width to ask for; the output is one `EmbedCall` — texts in, vectors and a
 * token count out, as an Effect — so the AI SDK adapters (OpenAI, Google)
 * and the plain-fetch one (Voyage, which has no SDK provider) are one type
 * to `embed()`. Width checking is not the adapter's: `embed()` asserts it
 * against the pin, whatever the adapter asked for.
 */
export type EmbedAdapterInput = {
  secret: string
  meta: Pick<ProviderMeta, 'baseUrl' | 'headers'>
  modelId: string
  /** The width to request — always the pin's. */
  dims: number
  /** The transport; a test hands in a stub, production uses global `fetch`. */
  fetch?: typeof fetch
}

export type EmbedAnswer = {
  embeddings: Array<Array<number>>
  /** As the provider reported it; null when it reported none. */
  tokens: number | null
}

export type EmbedCall = (
  texts: ReadonlyArray<string>,
) => Effect.Effect<EmbedAnswer, ProviderCallFailed>

export type EmbedProviderOptions = Record<string, Record<string, JSONValue>>

/**
 * How each SDK provider is asked for a width: OpenAI's `dimensions`, Google's
 * `outputDimensionality`, each under the provider's own options key. Voyage's
 * `output_dimension` is spelled in its adapter's request body instead.
 */
export function sdkDimensionOptions(
  provider: EmbeddingProvider,
  dims: number,
): EmbedProviderOptions {
  switch (provider) {
    case 'openai':
      return { openai: { dimensions: dims } }
    case 'google':
      return { google: { outputDimensionality: dims } }
    case 'voyage':
      return {}
  }
}

/** An AI SDK `EmbeddingModel` as an `EmbedCall`, through `embedMany`. */
export function sdkEmbedCall(
  provider: EmbeddingProvider,
  model: EmbeddingModel,
  providerOptions: EmbedProviderOptions,
  maxRetries?: number,
): EmbedCall {
  return (texts) =>
    Effect.tryPromise({
      try: async (): Promise<EmbedAnswer> => {
        const r = await embedMany({
          model,
          values: [...texts],
          providerOptions,
          ...(maxRetries === undefined ? {} : { maxRetries }),
        })
        // The SDK reports a provider that gave no usage as `NaN`.
        const tokens = Number.isFinite(r.usage.tokens) ? r.usage.tokens : null
        return { embeddings: r.embeddings, tokens }
      },
      catch: (cause) => new ProviderCallFailed({ provider, cause }),
    })
}
