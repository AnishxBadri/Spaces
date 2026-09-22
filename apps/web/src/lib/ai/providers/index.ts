import { Effect, Schema } from 'effect'
import type { LanguageModel } from 'ai'
import { resolveCredential } from '#/lib/vault'
import type { ResolvedCredential } from '#/lib/vault'
import type { LlmProvider } from './ids'
import type { AdapterInput } from './llm/adapter'
import { anthropicLanguageModel } from './llm/anthropic'
import { googleLanguageModel } from './llm/google'
import { ollamaLanguageModel } from './llm/ollama'
import { openaiLanguageModel } from './llm/openai'
import { openrouterLanguageModel } from './llm/openrouter'
import { readProviderMeta } from './meta'

/**
 * LLM providers: vault credential → adapter → AI SDK `LanguageModel`
 * (`docs/spec-ai-substrate.md` §9). The ids live in `./ids` (client-safe);
 * this module is server-only because it reads the vault.
 */
export { LLM_PROVIDERS, PROVIDERS } from './ids'
export type { LlmProvider } from './ids'

/** No active credential: the feature is hidden, not broken (CONTEXT.md, BYOK). */
export class NoCredential extends Schema.TaggedError<NoCredential>()(
  'NoCredential',
  { provider: Schema.String },
) {}

export class CredentialReadFailed extends Schema.TaggedError<CredentialReadFailed>()(
  'CredentialReadFailed',
  { cause: Schema.Defect() },
) {}

export type ResolveModelFailure = NoCredential | CredentialReadFailed

/** Each provider's adapter, keyed so a sixth id cannot compile without one. */
const ADAPTERS: Record<LlmProvider, (input: AdapterInput) => LanguageModel> = {
  anthropic: anthropicLanguageModel,
  openai: openaiLanguageModel,
  google: googleLanguageModel,
  openrouter: openrouterLanguageModel,
  ollama: ollamaLanguageModel,
}

/** The adapter for one provider, from an already-resolved credential. */
export function languageModelFor(
  provider: LlmProvider,
  credential: Pick<ResolvedCredential, 'secret' | 'meta'>,
  modelId?: string,
): LanguageModel {
  return ADAPTERS[provider]({
    secret: credential.secret,
    meta: readProviderMeta(credential.meta),
    ...(modelId ? { modelId } : {}),
  })
}

/**
 * vault → adapter. Resolution follows the vault's order (user key → workspace
 * key); without a `userId` only the workspace key is considered.
 */
export const resolveLanguageModel = Effect.fn('resolveLanguageModel')(
  function* (
    provider: LlmProvider,
    opts: { userId?: string; modelId?: string } = {},
  ): Effect.fn.Return<
    { model: LanguageModel; credentialId: string },
    ResolveModelFailure
  > {
    const credential = yield* Effect.tryPromise({
      try: () => resolveCredential(provider, opts.userId),
      catch: (cause) => new CredentialReadFailed({ cause }),
    })
    if (!credential) return yield* new NoCredential({ provider })
    const model = languageModelFor(provider, credential, opts.modelId)
    return { model, credentialId: credential.id }
  },
)
