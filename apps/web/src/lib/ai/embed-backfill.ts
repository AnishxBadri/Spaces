import { Clock, Effect, Schema } from 'effect'
import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { chunk } from '@spaces/db/schema'
import { estimateTokens } from '@spaces/core/ai/caps'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import { capMessage, readAiCapsProgram } from './caps'
import type { CapReadFailed } from './caps'
import { embedMessage, embedProgram } from './embed'
import { EMBED_BATCH } from './embed-chunks'
import { readEmbeddingPinProgram } from './embedding-pin'
import type { EmbeddingPinReadFailed } from './embedding-pin'
import { sensitivityFor } from './sensitivity-for'
import type { SensitivityReadFailed } from './sensitivity-for'
import {
  backfillCostLabel,
  findEmbeddingModel,
  pricingOf,
} from './providers/embed/ids'
import type { BackfillEstimate, EmbeddingPinView } from './providers/embed/ids'

/**
 * The corpus backfill (SPA-136, ai-13; `docs/spec-ai-substrate.md` §9) —
 * the one recorded exception to "never forced, automatic once enabled": it
 * embeds every chunk that does not yet carry the pinned model's vector, and
 * it **asks first**, with a token and cost estimate read from the database
 * alone. Nothing here calls a provider until the admin has confirmed and
 * the worker has picked the job up.
 *
 * **What it embeds.** Every `chunk` whose `embedding_model` is null or is
 * not the pin's — a keyless install's lexical-only chunks, a sensitive
 * record's chunks once a local model can take them, and after a same-width
 * swap (`./embedding-pin.ts`) every chunk the old model embedded. Rows whose
 * `sensitive` stamp is set are left out of the count and the run, and every
 * batch still resolves sensitivity **live** per record before a byte leaves
 * (`sensitivityFor`): the column is a cache, and a cache is not an egress
 * decision.
 *
 * **Resumable by construction.** The run walks the pending set in `id`
 * order, `EMBED_BATCH` at a time (SPA-121's 96), and commits each batch's
 * vectors before it asks for the next. Nothing records progress but the
 * rows themselves: a re-queued run — after a worker restart, an expiry, or
 * the cap's reset — selects what is still pending and so never re-embeds a
 * chunk already carrying the pinned model.
 *
 * **It sets vectors in place; it does not re-cut.** SPA-132's
 * `replaceChunks` (`./embed-chunks.ts`) is the writer for a source whose
 * *text* changed: it cuts, embeds the whole source all or nothing, and
 * replaces its rows. The backfill's text has not changed — only which model
 * embedded it — so it updates `embedding` and `embedding_model` on the rows
 * that exist, by id, and commits per batch across sources. Going through
 * `replaceChunks` would make a cap hit halfway through a large document
 * discard the batches of that document already paid for, and rewrite its
 * rows with no vectors at all. Sensitivity is not restamped: the backfill
 * never changes it.
 *
 * **The cap is the shared one.** Every batch goes through `embed()`, which
 * calls `checkCapProgram` — `workspace.settings.ai_caps` read by the one
 * helper, `ai_usage` counted by the one aggregate (SPA-73). The day's cap
 * stops the run mid-corpus with `BackfillCapped`, the batches before it
 * intact; the job re-sends itself for the next UTC midnight
 * (`worker/jobs/embed-backfill.ts`). The per-run cap is honoured by sizing
 * batches under it, so it only stops a run on a single chunk larger than
 * the cap itself.
 */

/** The one run: the backfill queue is `exclusive` and every send carries this key. */
export const EMBED_BACKFILL_KEY = 'embed-backfill'

export class BackfillReadFailed extends Schema.TaggedError<BackfillReadFailed>()(
  'BackfillReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class BackfillWriteFailed extends Schema.TaggedError<BackfillWriteFailed>()(
  'BackfillWriteFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** No pin: there is no model to backfill with. */
export class BackfillRefused extends Schema.TaggedError<BackfillRefused>()(
  'BackfillRefused',
  { message: Schema.String },
) {}

/** The AI cap stopped the run; every batch before it is committed. */
export class BackfillCapped extends Schema.TaggedError<BackfillCapped>()(
  'BackfillCapped',
  {
    embedded: Schema.Number,
    kind: Schema.Literals(['daily', 'per_run']),
    /** The next UTC midnight, ISO; null for the per-run cap. */
    resetsAt: Schema.NullOr(Schema.String),
    reason: Schema.String,
  },
) {}

/** An embed call failed for a reason other than the cap. */
export class BackfillEmbedFailed extends Schema.TaggedError<BackfillEmbedFailed>()(
  'BackfillEmbedFailed',
  {
    embedded: Schema.Number,
    /** The embed failure's tag, e.g. `ProviderCallFailed`. */
    cause: Schema.String,
    /** `embedMessage`'s sentence for it. */
    reason: Schema.String,
  },
) {}

export type EmbedBackfillFailure =
  | BackfillReadFailed
  | BackfillWriteFailed
  | BackfillCapped
  | BackfillEmbedFailed
  | EmbeddingPinReadFailed
  | CapReadFailed
  | SensitivityReadFailed

const read = <T>(f: () => Promise<T>, message = 'Could not read the chunks') =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new BackfillReadFailed({ message, cause }),
  })

/** Chunks a backfill may send, i.e. not stamped sensitive. */
const eligible = eq(chunk.sensitive, false)

/** An eligible chunk not yet carrying `model`'s vector. */
const pendingFor = (model: string) =>
  and(
    eligible,
    or(isNull(chunk.embeddingModel), ne(chunk.embeddingModel, model)),
  )

type BackfillCounts = {
  /** Eligible chunks. */
  total: number
  /** Of those, the ones not on the pinned model. */
  pending: number
  /** Their characters, summed — the estimate's input. */
  pendingChars: number
}

const countChunks = Effect.fn('embedBackfill.count')(function* (
  model: string,
): Effect.fn.Return<BackfillCounts, BackfillReadFailed> {
  const isPending = sql`${chunk.embeddingModel} is distinct from ${model}`
  const row = (yield* read(() =>
    db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        pending: sql<number>`count(*) filter (where ${isPending})`.mapWith(
          Number,
        ),
        pendingChars:
          sql<number>`coalesce(sum(char_length(${chunk.text})) filter (where ${isPending}), 0)`.mapWith(
            Number,
          ),
      })
      .from(chunk)
      .where(eligible),
  )).at(0)
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    pendingChars: row?.pendingChars ?? 0,
  }
})

/**
 * The pre-flight estimate: pending chunks, their tokens by the cap's own
 * rule (characters ÷ 4, `estimateTokens`), and the pinned model's list
 * price over them — "free — local model" for a local provider. Two reads,
 * no provider call.
 */
export const backfillEstimateProgram = Effect.fn('backfillEstimate')(function* (
  pin: EmbeddingPinView,
): Effect.fn.Return<
  { counts: BackfillCounts; estimate: BackfillEstimate },
  BackfillReadFailed
> {
  const counts = yield* countChunks(pin.model)
  const model = findEmbeddingModel(pin.provider, pin.model)
  if (!model)
    return yield* new BackfillReadFailed({
      message: `${pin.model} is not in this version's catalogue`,
      cause: null,
    })
  const tokens = estimateTokens(counts.pendingChars)
  return {
    counts,
    estimate: {
      chunks: counts.pending,
      tokens,
      cost: backfillCostLabel(tokens, pricingOf(pin.provider, model)),
    },
  }
})

// ---------- the run (the worker's `chunk.embed-backfill` job) ----------

export type EmbedBackfillInput = {
  /** The test seam, passed straight to `embed()`; the pin and the cap still apply. */
  model?: EmbeddingModel
}

export type EmbedBackfillResult = {
  /** Chunks this run gave a vector. */
  embedded: number
  /** Chunks passed over because their record resolved sensitive, or is gone. */
  skipped: number
  /** The model the vectors came from; null when none were made. */
  model: string | null
}

type PendingChunk = { id: string; entityId: string; text: string }

export const embedBackfillProgram = Effect.fn('embedBackfill')(function* (
  input: EmbedBackfillInput = {},
): Effect.fn.Return<EmbedBackfillResult, EmbedBackfillFailure> {
  const caps = yield* readAiCapsProgram()
  // A batch's estimate must fit the per-run cap, or `embed()` refuses it.
  const charBudget =
    caps.perRunTokens === undefined
      ? Number.POSITIVE_INFINITY
      : caps.perRunTokens * 4
  let cursor: string | null = null
  let embedded = 0
  let skipped = 0
  let model: string | null = null

  for (;;) {
    // Read each batch, not once: the pin can move under a long run, and the
    // pending set is always "not on the pin as it is now".
    const pin = yield* readEmbeddingPinProgram()
    if (pin === null) return { embedded, skipped, model }
    const after = cursor
    const rows: Array<PendingChunk> = yield* read(() =>
      db
        .select({ id: chunk.id, entityId: chunk.entityId, text: chunk.text })
        .from(chunk)
        .where(
          and(
            pendingFor(pin.model),
            after === null ? undefined : gt(chunk.id, after),
          ),
        )
        .orderBy(asc(chunk.id))
        .limit(EMBED_BATCH),
    )
    if (rows.length === 0) return { embedded, skipped, model }

    // Live, per batch, per record: the egress decision is never the cache's.
    const normal = new Map<string, boolean>()
    const batch: Array<PendingChunk> = []
    let chars = 0
    for (const row of rows) {
      let ok = normal.get(row.entityId)
      if (ok === undefined) {
        ok = yield* sensitivityFor(row.entityId).pipe(
          Effect.map((s) => s.sensitivity === 'normal'),
          Effect.catchTag('SensitivityEntityNotFound', () =>
            Effect.succeed(false),
          ),
        )
        normal.set(row.entityId, ok)
      }
      if (!ok) {
        skipped += 1
        cursor = row.id
        continue
      }
      if (batch.length > 0 && chars + row.text.length > charBudget) break
      batch.push(row)
      chars += row.text.length
      cursor = row.id
    }
    if (batch.length === 0) continue

    const answer = yield* Effect.result(
      embedProgram(
        batch.map((c) => c.text),
        {
          caller: { type: 'system' },
          sensitivity: 'normal',
          ...(input.model === undefined ? {} : { model: input.model }),
        },
      ),
    )
    if (answer._tag === 'Failure') {
      const failure = answer.failure
      switch (failure._tag) {
        case 'EmbeddingNotPinned':
          return { embedded, skipped, model }
        case 'CapExceeded':
          return yield* new BackfillCapped({
            embedded,
            kind: failure.kind,
            resetsAt: failure.resetsAt,
            reason: capMessage(failure),
          })
        default:
          return yield* new BackfillEmbedFailed({
            embedded,
            cause: failure._tag,
            reason: embedMessage(failure),
          })
      }
    }

    const { vectors, target } = answer.success
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          for (const [i, c] of batch.entries())
            await tx
              .update(chunk)
              .set({ embedding: vectors[i], embeddingModel: target.model })
              .where(eq(chunk.id, c.id))
        }),
      catch: (cause) =>
        new BackfillWriteFailed({
          message: 'Could not write the vectors',
          cause,
        }),
    })
    embedded += batch.length
    model = target.model
  }
})

// ---------- trigger + status (the Embeddings section's two server fns) ----------

export type BackfillStarted =
  | { status: 'queued' }
  | { status: 'already-queued' }
  | { status: 'nothing-to-do' }
  | { status: 'queue-unavailable' }

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

const pinForServer = readEmbeddingPinProgram().pipe(
  Effect.catchTag('EmbeddingPinReadFailed', (e) =>
    Effect.fail(
      new BackfillReadFailed({
        message: 'Could not read the embedding pin',
        cause: e.cause,
      }),
    ),
  ),
)

/**
 * Confirmed: one job, keyed. The queue is `exclusive`, so a second press
 * while a run is queued, active or paused for the cap's reset is refused by
 * pg-boss and answered `already-queued`.
 */
export const startEmbedBackfillProgram = Effect.fn('startEmbedBackfill')(
  function* (): Effect.fn.Return<
    BackfillStarted,
    BackfillRefused | BackfillReadFailed
  > {
    const pin = yield* pinForServer
    if (pin === null)
      return yield* new BackfillRefused({
        message: 'Pin an embedding model before backfilling',
      })
    const counts = yield* countChunks(pin.model)
    if (counts.pending === 0) return { status: 'nothing-to-do' }
    const jobId = yield* read(
      () =>
        enqueue(QUEUES.embedBackfill, {}, { singletonKey: EMBED_BACKFILL_KEY }),
      'Could not reach the worker queue',
    )
    if (jobId !== null) return { status: 'queued' }
    const jobs = yield* read(
      () => jobsByKey(QUEUES.embedBackfill, EMBED_BACKFILL_KEY),
      'Could not reach the worker queue',
    )
    return jobs !== null && jobs.some(inFlight)
      ? { status: 'already-queued' }
      : { status: 'queue-unavailable' }
  },
)

export type BackfillRun =
  | { state: 'idle' }
  | { state: 'queued' }
  | { state: 'running' }
  /** Stopped by the day's cap, re-sent for `resumesAt`. */
  | { state: 'paused'; resumesAt: string; reason: string | null }
  | { state: 'failed'; reason: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
function reasonOf(output: object | null): string | null {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** Where the run stands, from the keyed jobs pg-boss holds. */
export function backfillRunOf(
  jobs: ReadonlyArray<QueuedJob>,
  now: Date,
): BackfillRun {
  const newest = [...jobs].sort(
    (a, b) => b.createdOn.getTime() - a.createdOn.getTime(),
  )
  if (newest.some((j) => j.state === 'active')) return { state: 'running' }
  const pending = newest.find(
    (j) => j.state === 'created' || j.state === 'retry',
  )
  if (pending) {
    if (
      pending.state === 'created' &&
      pending.startAfter !== undefined &&
      pending.startAfter.getTime() > now.getTime()
    ) {
      const stopped = newest.find((j) => j.state === 'completed')
      return {
        state: 'paused',
        resumesAt: pending.startAfter.toISOString(),
        reason: stopped === undefined ? null : reasonOf(stopped.output),
      }
    }
    return { state: 'queued' }
  }
  const latest = newest.at(0)
  if (latest === undefined || latest.state === 'completed')
    return { state: 'idle' }
  return {
    state: 'failed',
    reason: reasonOf(latest.output) ?? 'The backfill stopped',
  }
}

export type EmbedBackfillView =
  | { pin: null }
  | {
      pin: EmbeddingPinView
      /** Chunks a backfill may embed (not stamped sensitive). */
      total: number
      /** Of those, the ones carrying the pinned model's vector. */
      embedded: number
      estimate: BackfillEstimate
      run: BackfillRun
    }

/** The Backfill row: progress, the estimate, and where the run stands. */
export const embedBackfillStatusProgram = Effect.fn('embedBackfillStatus')(
  function* (): Effect.fn.Return<EmbedBackfillView, BackfillReadFailed> {
    const pin = yield* pinForServer
    if (pin === null) return { pin: null }
    const { counts, estimate } = yield* backfillEstimateProgram(pin)
    const jobs = yield* read(
      () => jobsByKey(QUEUES.embedBackfill, EMBED_BACKFILL_KEY),
      'Could not reach the worker queue',
    )
    const now = new Date(yield* Clock.currentTimeMillis)
    return {
      pin,
      total: counts.total,
      embedded: counts.total - counts.pending,
      estimate,
      run: jobs === null ? { state: 'idle' } : backfillRunOf(jobs, now),
    }
  },
)

// The server fns' bodies. `requireAdmin()` first, always.

export async function getEmbedBackfillHandler(): Promise<EmbedBackfillView> {
  await requireAdmin()
  return effectFn(embedBackfillStatusProgram)()
}

export async function startEmbedBackfillHandler(): Promise<BackfillStarted> {
  await requireAdmin()
  return effectFn(startEmbedBackfillProgram)()
}
