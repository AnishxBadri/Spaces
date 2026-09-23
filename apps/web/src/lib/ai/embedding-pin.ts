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
import type {
  EmbeddingModelInfo,
  EmbeddingPinView,
  EmbeddingTarget,
} from './providers/embed/ids'

/**
 * The embedding pin (SPA-51, `docs/spec-ai-substrate.md` §9):
 * `workspace.settings.embedding = {provider, model, dims, pinned_at}`.
 * Absent is "no embedding model", and then nothing anywhere changes —
 * search stays lexical + trigram, and `embed()` refuses `EmbeddingNotPinned`.
 *
 * **The width does not move; the model may (SPA-136).** Every stored vector
 * is `vector(768)`, and another model's vectors in the same column are
 * silently garbage to a query embedded by this one (CONTEXT.md, "the
 * dimension trap"). A swap to another model that also emits 768 needs no
 * DDL, only a re-embed, so it is allowed: the new pin is written and every
 * stored chunk is stale **by construction** — the semantic lane
 * (`lib/search/query.ts`) keeps only rows whose `embedding_model` is the
 * pin's, so no column is touched and search stops using the old vectors the
 * moment the pin changes. The backfill job (`./embed-backfill.ts`) is what
 * re-embeds them, and it is offered, not started: it costs money and asks
 * first.
 *
 * A change of **width** stays refused `PinLocked`. The unbuilt half of
 * re-pin is `ALTER TABLE chunk ALTER COLUMN embedding TYPE vector(N)` (every
 * stored vector nulled or dropped first, since no cast between widths
 * exists) plus rebuilding the HNSW index over the new column — DDL on the
 * largest table, one explicit job, not a settings click.
 *
 * Every write is conditional on the pin it replaces — absent for a first
 * pin, the model it read for a swap — so two admins pinning at once cannot
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

/** The pin cannot move to that model: a different width. The message says why. */
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

/** The catalogue row for `target`, or the refusal an unknown model gets. */
const knownModel = Effect.fn('pinEmbedding.knownModel')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<EmbeddingModelInfo, PinRefused> {
  const model = findEmbeddingModel(target.provider, target.model)
  if (!model)
    return yield* new PinRefused({
      message: `${EMBEDDING_PROVIDER_INFO[target.provider].label} ${target.model} is not an embedding model this version knows`,
    })
  return model
})

/** A pin names a provider whose embedding key is saved, or it is refused. */
const requireKey = Effect.fn('pinEmbedding.requireKey')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<void, PinRefused | EmbeddingPinReadFailed> {
  const key = yield* Effect.tryPromise({
    try: () =>
      readWorkspaceCredential(embeddingCredentialProvider(target.provider)),
    catch: (cause) => new EmbeddingPinReadFailed({ cause }),
  })
  if (!key || key.status !== 'active')
    return yield* new PinRefused({
      message: `Save a ${EMBEDDING_PROVIDER_INFO[target.provider].label} embedding key before pinning`,
    })
})

/**
 * Pins the workspace to one model at `PIN_DIMS`. Idempotent for the model
 * already pinned (it answers the stored pin, unchanged). With another model
 * pinned, a target that also emits `PIN_DIMS` **swaps** the pin (SPA-136) and
 * one that cannot is `PinLocked`; with none pinned, a model the catalogue
 * greys is `PinRefused`, as is any target whose provider has no embedding
 * key saved yet. Nothing here enqueues the backfill — the swap only offers
 * it.
 */
export const pinEmbeddingProgram = Effect.fn('pinEmbedding')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<
  EmbeddingPinView,
  PinLocked | PinRefused | EmbeddingPinReadFailed | EmbeddingPinWriteFailed
> {
  const existing = yield* readEmbeddingPinProgram()
  if (
    existing &&
    existing.provider === target.provider &&
    existing.model === target.model
  )
    return existing

  const model = yield* knownModel(target)
  if (existing && (!model.emitsPin || existing.dims !== PIN_DIMS))
    return yield* new PinLocked({
      provider: existing.provider,
      model: existing.model,
      message: pinLockedMessage(existing, model),
    })
  if (!model.emitsPin)
    return yield* new PinRefused({
      message: `${EMBEDDING_PROVIDER_INFO[target.provider].label} ${model.id} ${needsRepinNote(model)}`,
    })
  yield* requireKey(target)

  const pinnedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const setting: EmbeddingPinSetting = {
    provider: target.provider,
    model: model.id,
    dims: PIN_DIMS,
    pinned_at: pinnedAt,
  }
  // The pin this write replaces, exactly: absent for a first pin, the
  // provider and model read above for a swap.
  const replaces = existing
    ? sql`(${workspace.settings} -> 'embedding' ->> 'provider') = ${existing.provider}
        and (${workspace.settings} -> 'embedding' ->> 'model') = ${existing.model}`
    : sql`(${workspace.settings} -> 'embedding') is null`
  const written = yield* Effect.tryPromise({
    try: () =>
      db
        .update(workspace)
        .set({
          settings: sql`${workspace.settings} || ${JSON.stringify({ embedding: setting })}::jsonb`,
          updatedAt: new Date(pinnedAt),
        })
        .where(and(eq(workspace.id, 1), replaces))
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

  // Nothing matched: the singleton is missing, or another admin moved the
  // pin between the read above and this write. Read again to say which.
  const raced = yield* readEmbeddingPinProgram()
  if (raced === null)
    return yield* new EmbeddingPinWriteFailed({
      message: existing
        ? 'The pin changed while this was saved; choose again'
        : 'The workspace is not set up yet',
      cause: null,
    })
  if (raced.provider === target.provider && raced.model === target.model)
    return raced
  return yield* new EmbeddingPinWriteFailed({
    message: `The pin moved to ${EMBEDDING_PROVIDER_INFO[raced.provider].label} ${raced.model} while this was saved; choose again`,
    cause: null,
  })
})
