import { Clock, Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { workspace } from '@spaces/db/schema'
import type { EmbeddingPinSetting } from '@spaces/db/schema/workspace'
import { readWorkspaceCredential } from '#/lib/vault'
import {
  EMBEDDING_PROVIDER_INFO,
  PIN_DIMS,
  embeddingCredentialProvider,
  findEmbeddingModel,
  isEmbeddingProvider,
  needsRepinNote,
  pinLockedMessage,
} from './providers/embed/ids'
import type { EmbeddingPinView, EmbeddingTarget } from './providers/embed/ids'

/**
 * The embedding pin (SPA-51, `docs/spec-ai-substrate.md` §9):
 * `workspace.settings.embedding = {provider, model, dims, pinned_at}`, set
 * once. Absent is "no embedding model", and then nothing anywhere changes —
 * search stays lexical + trigram, and `embed()` refuses `EmbeddingNotPinned`.
 *
 * **A pin does not move.** Every stored vector is the pinned model's; another
 * model's vectors in the same column are silently garbage (CONTEXT.md,
 * "the dimension trap"). Re-pin — ALTER COLUMN TYPE, index rebuild, full
 * re-embed — is not built, and even a same-width swap needs the backfill job
 * (ai-13) to re-embed what is stored. So a second pin naming another model
 * fails `PinLocked` with the sentence the section shows, and the write is
 * conditional on the key's absence, so two admins pinning at once cannot
 * both win.
 */

export class EmbeddingPinReadFailed extends Schema.TaggedError<EmbeddingPinReadFailed>()(
  'EmbeddingPinReadFailed',
  { cause: Schema.Defect() },
) {}

export class EmbeddingPinWriteFailed extends Schema.TaggedError<EmbeddingPinWriteFailed>()(
  'EmbeddingPinWriteFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The workspace is already pinned to another model; the message says why it stays. */
export class PinLocked extends Schema.TaggedError<PinLocked>()('PinLocked', {
  provider: Schema.String,
  model: Schema.String,
  message: Schema.String,
}) {}

/** The requested model cannot be pinned — unknown, the wrong width, or no key saved. */
export class PinRefused extends Schema.TaggedError<PinRefused>()('PinRefused', {
  message: Schema.String,
}) {}

/**
 * The stored pin, decoded. The column is typed, but a row edited by hand can
 * still name a model this build has no adapter for; that reads as a failure,
 * not as "no pin" — a pin nobody can honour must not look like permission to
 * pin again.
 */
export function pinFromSetting(
  setting: EmbeddingPinSetting | undefined,
): EmbeddingPinView | null | 'unknown' {
  if (setting === undefined) return null
  const provider = setting.provider
  if (!isEmbeddingProvider(provider)) return 'unknown'
  if (!findEmbeddingModel(provider, setting.model)) return 'unknown'
  return {
    provider,
    model: setting.model,
    dims: setting.dims,
    pinnedAt: setting.pinned_at,
  }
}

const readSettings = Effect.tryPromise({
  try: () =>
    db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, 1)),
  catch: (cause) => new EmbeddingPinReadFailed({ cause }),
}).pipe(Effect.map((rows) => rows.at(0)?.settings ?? {}))

export const readEmbeddingPinProgram = Effect.fn('readEmbeddingPin')(
  function* (): Effect.fn.Return<
    EmbeddingPinView | null,
    EmbeddingPinReadFailed
  > {
    const settings = yield* readSettings
    const pin = pinFromSetting(settings.embedding)
    if (pin === 'unknown')
      return yield* new EmbeddingPinReadFailed({
        cause: new Error(
          'workspace.settings.embedding names a model this build has no adapter for',
        ),
      })
    return pin
  },
)

/**
 * Pins the workspace to one model at `PIN_DIMS`. Idempotent for the model
 * already pinned (it answers the stored pin, unchanged); `PinLocked` for any
 * other; `PinRefused` for a model the catalogue greys, or one whose provider
 * has no embedding key saved yet.
 */
export const pinEmbeddingProgram = Effect.fn('pinEmbedding')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<
  EmbeddingPinView,
  PinLocked | PinRefused | EmbeddingPinReadFailed | EmbeddingPinWriteFailed
> {
  const existing = yield* readEmbeddingPinProgram()
  if (existing) {
    if (
      existing.provider === target.provider &&
      existing.model === target.model
    )
      return existing
    return yield* new PinLocked({
      provider: existing.provider,
      model: existing.model,
      message: pinLockedMessage(existing),
    })
  }

  const label = EMBEDDING_PROVIDER_INFO[target.provider].label
  const model = findEmbeddingModel(target.provider, target.model)
  if (!model)
    return yield* new PinRefused({
      message: `${label} ${target.model} is not an embedding model this version knows`,
    })
  if (!model.emitsPin)
    return yield* new PinRefused({
      message: `${label} ${model.id} ${needsRepinNote(model)}`,
    })

  const key = yield* Effect.tryPromise({
    try: () =>
      readWorkspaceCredential(embeddingCredentialProvider(target.provider)),
    catch: (cause) => new EmbeddingPinReadFailed({ cause }),
  })
  if (!key || key.status !== 'active')
    return yield* new PinRefused({
      message: `Save a ${label} embedding key before pinning`,
    })

  const pinnedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const setting: EmbeddingPinSetting = {
    provider: target.provider,
    model: model.id,
    dims: PIN_DIMS,
    pinned_at: pinnedAt,
  }
  const written = yield* Effect.tryPromise({
    try: () =>
      db
        .update(workspace)
        .set({
          settings: sql`${workspace.settings} || ${JSON.stringify({ embedding: setting })}::jsonb`,
          updatedAt: new Date(pinnedAt),
        })
        .where(
          and(
            eq(workspace.id, 1),
            sql`(${workspace.settings} -> 'embedding') is null`,
          ),
        )
        .returning({ id: workspace.id }),
    catch: (cause) =>
      new EmbeddingPinWriteFailed({
        message: 'Could not save the embedding pin',
        cause,
      }),
  })
  if (written.length > 0)
    return {
      provider: target.provider,
      model: model.id,
      dims: PIN_DIMS,
      pinnedAt,
    }

  // Nothing matched: the singleton is missing, or another admin pinned
  // between the read above and this write. Read again to say which.
  const raced = yield* readEmbeddingPinProgram()
  if (raced === null)
    return yield* new EmbeddingPinWriteFailed({
      message: 'The workspace is not set up yet',
      cause: null,
    })
  if (raced.provider === target.provider && raced.model === target.model)
    return raced
  return yield* new PinLocked({
    provider: raced.provider,
    model: raced.model,
    message: pinLockedMessage(raced),
  })
})
