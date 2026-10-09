import { Effect } from 'effect'
import {
  readWorkspaceCredential,
  resolveCredential,
} from '@spaces/core/writes/vault'
import type { ResolvedCredential } from '@spaces/core/writes/vault'
import { CredentialReadFailed, NoCredential } from '../index'
import type { ResolveModelFailure } from '../index'
import { readProviderMeta } from '../meta'
import {
  embeddingCredentialKind,
  embeddingCredentialProvider,
  reusableModelsKey,
} from './ids'
import type { EmbeddingKeySource, EmbeddingProvider } from './ids'
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

/**
 * The credential an embedding call uses, in the vault's order (user key →
 * workspace key): the provider's own embedding key, else the Models key it
 * may reuse (`reusableModelsKey`). Null when neither is stored. (D81)
 */
export async function resolveEmbeddingCredential(
  provider: EmbeddingProvider,
  userId?: string,
): Promise<(ResolvedCredential & { source: EmbeddingKeySource }) | null> {
  const own = await resolveCredential(
    embeddingCredentialProvider(provider),
    embeddingCredentialKind(provider),
    userId,
  )
  if (own) return { ...own, source: 'own' }
  const models = reusableModelsKey(provider)
  if (models === null) return null
  const reused = await resolveCredential(models, 'llm', userId)
  return reused ? { ...reused, source: 'models' } : null
}

/**
 * The workspace row Search draws and records its Test on, without the
 * secret: the active embedding row, else the active Models row it reuses,
 * else whatever embedding row is stored (an invalid one still shows).
 */
export async function readEmbeddingWorkspaceCredential(
  provider: EmbeddingProvider,
) {
  const own = await readWorkspaceCredential(
    embeddingCredentialProvider(provider),
    embeddingCredentialKind(provider),
  )
  const models = reusableModelsKey(provider)
  if (own?.status !== 'active' && models !== null) {
    const reused = await readWorkspaceCredential(models, 'llm')
    if (reused?.status === 'active')
      return { ...reused, source: 'models' as const }
  }
  return own ? { ...own, source: 'own' as const } : undefined
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
 * vault → adapter, through `resolveEmbeddingCredential`. A missing key fails
 * `NoCredential` naming the provider, not the vault id.
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
    try: () => resolveEmbeddingCredential(provider, opts.userId),
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
