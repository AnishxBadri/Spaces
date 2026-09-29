import { Effect } from 'effect'
import { resolveCredential } from '@spaces/core/writes/vault'
import type { ResolvedCredential } from '@spaces/core/writes/vault'
import { CredentialReadFailed, NoCredential } from '../index'
import type { ResolveModelFailure } from '../index'
import { readProviderMeta } from '../meta'
import { embeddingCredentialProvider } from './ids'
import type { EmbeddingProvider } from './ids'
import type { EmbedAdapterInput, EmbedCall } from './adapter'
import { googleEmbedCall } from './google'
import { ollamaEmbedCall } from './ollama'
import { openaiEmbedCall } from './openai'
import { voyageEmbedCall } from './voyage'

/**
 * Embedding providers: vault credential (`kind: 'embedding'`, stored under
 * `embed:<provider>`; for keyless Ollama, the LLM row `ollama` — see
 * `embeddingCredentialProvider`) → adapter → `EmbedCall`. Server-only: it reads the
 * vault. The ids and the model catalogue live in `./ids`, client-safe.
 */

/** Each provider's adapter, keyed so a fourth id cannot compile without one. */
const ADAPTERS: Record<
  EmbeddingProvider,
  (input: EmbedAdapterInput) => EmbedCall
> = {
  openai: openaiEmbedCall,
  google: googleEmbedCall,
  voyage: voyageEmbedCall,
  ollama: ollamaEmbedCall,
}

/** The adapter for one provider, from an already-resolved credential. */
export function embedCallFor(
  provider: EmbeddingProvider,
  credential: Pick<ResolvedCredential, 'secret' | 'meta'>,
  modelId: string,
  dims: number,
  fetch?: typeof globalThis.fetch,
  maxRetries?: number,
): EmbedCall {
  const meta = readProviderMeta(credential.meta)
  return ADAPTERS[provider]({
    secret: credential.secret,
    meta: {
      ...(meta.baseUrl === undefined ? {} : { baseUrl: meta.baseUrl }),
      ...(meta.headers === undefined ? {} : { headers: meta.headers }),
    },
    modelId,
    dims,
    ...(fetch === undefined ? {} : { fetch }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  })
}

/**
 * vault → adapter, in the vault's order (user key → workspace key). A
 * missing key fails `NoCredential` naming the provider, not the vault id.
 */
export const resolveEmbedCall = Effect.fn('resolveEmbedCall')(function* (
  provider: EmbeddingProvider,
  opts: {
    modelId: string
    dims: number
    userId?: string
    maxRetries?: number
  },
): Effect.fn.Return<
  { call: EmbedCall; credentialId: string },
  ResolveModelFailure
> {
  const credential = yield* Effect.tryPromise({
    try: () =>
      resolveCredential(embeddingCredentialProvider(provider), opts.userId),
    catch: (cause) => new CredentialReadFailed({ cause }),
  })
  if (!credential) return yield* new NoCredential({ provider })
  return {
    call: embedCallFor(
      provider,
      credential,
      opts.modelId,
      opts.dims,
      undefined,
      opts.maxRetries,
    ),
    credentialId: credential.id,
  }
})
