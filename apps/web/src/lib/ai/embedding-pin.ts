import { Clock, Effect, Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { workspace } from '@spaces/db/schema'
import type {
  EmbeddingPinSetting,
  EmbeddingSlotSetting,
} from '@spaces/db/schema/workspace'
import { readWorkspaceCredential } from '@spaces/core/writes/vault'
import { readProviderMeta } from './providers/meta'
import {
  EMBEDDING_PROVIDER_INFO,
  PIN_DIMS,
  embeddingCredentialProvider,
  findEmbeddingModel,
  isEmbeddingProvider,
  missingCredentialMessage,
  needsRepinNote,
  pinLockedMessage,
  slotDimsMessage,
  storedDims,
} from './providers/embed/ids'
import type {
  EmbeddingModelInfo,
  EmbeddingPinView,
  EmbeddingSlotView,
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
 *
 * **The sensitive slot** (SPA-83, D11, `docs/spec-ai-substrate.md` §9) is
 * `embedding.sensitive = {provider, model, dims, set_at}`: a local provider
 * beside a cloud pin, at the pin's width, so a sensitive record is embedded
 * on the operator's box instead of being left without vectors. It is
 * refused unless the provider is `local`, the model's width is the pin's
 * (the refusal names both numbers), the provider's credential exists, and
 * that model's last embed Test came back green. A pin swap merges into
 * `embedding` and so keeps it; `embed()` is what routes to it.
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

/**
 * The stored slot, decoded. Like the pin, a slot this build cannot honour —
 * a cloud provider, an unknown model, a width that is not the stored one —
 * reads as a failure, never as "no slot": a sensitive embed must not fall
 * back to anything on a guess.
 */
export function slotFromSetting(
  setting: EmbeddingSlotSetting | undefined,
): EmbeddingSlotView | null | 'unknown' {
  if (setting === undefined) return null
  const provider = setting.provider
  if (!isEmbeddingProvider(provider)) return 'unknown'
  if (!EMBEDDING_PROVIDER_INFO[provider].local) return 'unknown'
  const model = findEmbeddingModel(provider, setting.model)
  if (!model || storedDims(model) !== setting.dims) return 'unknown'
  return {
    provider,
    model: setting.model,
    dims: setting.dims,
    setAt: setting.set_at,
  }
}

/** The pin and the sensitive slot beside it, read once. */
export type EmbeddingSetup = {
  pin: EmbeddingPinView | null
  slot: EmbeddingSlotView | null
}

export const readEmbeddingSetupProgram = Effect.fn('readEmbeddingSetup')(
  function* (): Effect.fn.Return<EmbeddingSetup, EmbeddingPinReadFailed> {
    const settings = yield* readSettings
    const pin = pinFromSetting(settings.embedding)
    if (pin === 'unknown')
      return yield* new EmbeddingPinReadFailed({
        cause: new Error(
          'workspace.settings.embedding names a model this build has no adapter for',
        ),
      })
    const slot =
      pin === null ? null : slotFromSetting(settings.embedding?.sensitive)
    if (slot === 'unknown')
      return yield* new EmbeddingPinReadFailed({
        cause: new Error(
          'workspace.settings.embedding.sensitive names a slot this build cannot use',
        ),
      })
    return { pin, slot }
  },
)

export const readEmbeddingPinProgram = Effect.fn('readEmbeddingPin')(
  function* (): Effect.fn.Return<
    EmbeddingPinView | null,
    EmbeddingPinReadFailed
  > {
    return (yield* readEmbeddingSetupProgram()).pin
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
      message: missingCredentialMessage(target.provider, 'pinning'),
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
          // Merged into `embedding`, not written over it: the sensitive slot
          // beside the pin survives a swap (same width, so it stays valid).
          settings: sql`jsonb_set(${workspace.settings}, '{embedding}', coalesce(${workspace.settings} -> 'embedding', '{}'::jsonb) || ${JSON.stringify(setting)}::jsonb)`,
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

// ---------- the sensitive slot (SPA-83) ----------

/** The slot cannot be set to that model; the message says why. */
export class SlotRefused extends Schema.TaggedError<SlotRefused>()(
  'SlotRefused',
  { message: Schema.String },
) {}

/**
 * Whether `target`'s last embed Test through its provider's credential came
 * back green. The Test records its verdict on the credential's meta as
 * `embedTestOk` + `embedTestModel` — apart from the LLM Test's own keys,
 * since Ollama's embedding and LLM halves share one row.
 */
const testedGreen = Effect.fn('sensitiveSlot.testedGreen')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<boolean | 'no-credential', EmbeddingPinReadFailed> {
  const row = yield* Effect.tryPromise({
    try: () =>
      readWorkspaceCredential(embeddingCredentialProvider(target.provider)),
    catch: (cause) => new EmbeddingPinReadFailed({ cause }),
  })
  if (!row || row.status !== 'active') return 'no-credential'
  const meta = readProviderMeta(row.meta)
  return meta.embedTestOk === true && meta.embedTestModel === target.model
})

/**
 * Sets the sensitive slot, or refuses `SlotRefused` saying why: no pin to
 * sit beside, an unknown model, a cloud provider, a width that is not the
 * pin's (naming both numbers), no credential, or no green Test of that
 * model. Idempotent for the slot already set. The write is conditional on
 * the pin it was checked against, so a slot never lands beside a pin that
 * moved in between.
 */
export const setSensitiveSlotProgram = Effect.fn('setSensitiveSlot')(function* (
  target: EmbeddingTarget,
): Effect.fn.Return<
  EmbeddingSlotView,
  SlotRefused | EmbeddingPinReadFailed | EmbeddingPinWriteFailed
> {
  const { pin, slot } = yield* readEmbeddingSetupProgram()
  if (pin === null)
    return yield* new SlotRefused({
      message: 'Pin an embedding model before setting the sensitive slot',
    })
  if (slot && slot.provider === target.provider && slot.model === target.model)
    return slot

  const label = EMBEDDING_PROVIDER_INFO[target.provider].label
  const model = findEmbeddingModel(target.provider, target.model)
  if (!model)
    return yield* new SlotRefused({
      message: `${label} ${target.model} is not an embedding model this version knows`,
    })
  if (!EMBEDDING_PROVIDER_INFO[target.provider].local)
    return yield* new SlotRefused({
      message: `${label} is a cloud provider; the sensitive slot takes only a model that runs on a box you run`,
    })
  if (storedDims(model) !== pin.dims)
    return yield* new SlotRefused({ message: slotDimsMessage(pin, model) })
  const green = yield* testedGreen(target)
  if (green === 'no-credential')
    return yield* new SlotRefused({
      message: missingCredentialMessage(
        target.provider,
        'setting the sensitive slot',
      ),
    })
  if (!green)
    return yield* new SlotRefused({
      message: `Test ${label} ${model.id} before setting it as the sensitive slot`,
    })

  const setAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const setting: EmbeddingSlotSetting = {
    provider: target.provider,
    model: model.id,
    dims: pin.dims,
    set_at: setAt,
  }
  const written = yield* Effect.tryPromise({
    try: () =>
      db
        .update(workspace)
        .set({
          settings: sql`jsonb_set(${workspace.settings}, '{embedding,sensitive}', ${JSON.stringify(setting)}::jsonb)`,
          updatedAt: new Date(setAt),
        })
        .where(
          and(
            eq(workspace.id, 1),
            sql`(${workspace.settings} -> 'embedding' ->> 'provider') = ${pin.provider}
              and (${workspace.settings} -> 'embedding' ->> 'model') = ${pin.model}`,
          ),
        )
        .returning({ id: workspace.id }),
    catch: (cause) =>
      new EmbeddingPinWriteFailed({
        message: 'Could not save the sensitive slot',
        cause,
      }),
  })
  if (written.length === 0)
    return yield* new EmbeddingPinWriteFailed({
      message: 'The pin changed while this was saved; choose again',
      cause: null,
    })
  return {
    provider: target.provider,
    model: model.id,
    dims: pin.dims,
    setAt,
  }
})

/** Clears the slot: sensitive records are refused again and left unembedded. */
export const clearSensitiveSlotProgram = Effect.fn('clearSensitiveSlot')(
  function* (): Effect.fn.Return<void, EmbeddingPinWriteFailed> {
    const at = new Date(yield* Clock.currentTimeMillis)
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(workspace)
          .set({
            settings: sql`${workspace.settings} #- '{embedding,sensitive}'`,
            updatedAt: at,
          })
          .where(eq(workspace.id, 1)),
      catch: (cause) =>
        new EmbeddingPinWriteFailed({
          message: 'Could not clear the sensitive slot',
          cause,
        }),
    })
  },
)
