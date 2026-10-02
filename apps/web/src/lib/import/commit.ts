import { Effect } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  importBatch,
  importRow,
  jobRun,
  objectDef,
} from '@spaces/db/schema'
import {
  coreKindOf,
  IDENTITY_KEY_ATTRIBUTES,
} from '@spaces/core/attributes/registry'
import { fitMapping } from '@spaces/core/import/mapping'
import {
  commitOutcomeOf,
  createKeysOf,
  emptyRun,
  foldMerged,
  runLinePrefix,
  SKIP_BOTH_REASON,
} from '@spaces/core/import/commit'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import { resolveEntityInTx } from '@spaces/core/writes/entities/resolve'
import { sweepNameSimilarity } from '@spaces/core/writes/entities/sweep'
import {
  AttributeValidationError,
  EntityNotFound,
  setValuesInTx,
} from '@spaces/core/writes/attributes/values'
import {
  ObjectRejected,
  createRecordInTxProgram,
  sweepRecordName,
} from '@spaces/core/writes/attributes/object-registry'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { birthDealProgram } from '#/lib/deals/birth'
import { emitDomainEvent } from '#/lib/events/emit'
import { recordPath } from '#/lib/record-path'
import { mappingObjectOf } from './mapping'
import { commitLedgerProgram, loadLedgerReceiptProgram } from './ledger-commit'
import { ImportFailed, ImportNotFound, ImportRefused } from './stage'
import type { LedgerReceipt } from './ledger-commit'
import type { Tx } from '@spaces/core/writes/attributes/values'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import type {
  CoreIdentityKey,
  ObjectKind,
} from '@spaces/core/attributes/registry'
import type {
  CommitCounts,
  CommitOutcome,
  CommitRun,
} from '@spaces/core/import/commit'
import type { ImportAlsoCreate, RowPlan } from '@spaces/core/import/plan'
import type { Mapping, MappingAttribute } from '@spaces/core/import/mapping'
import type { ImportBatchStatus, ImportVerdict } from '@spaces/db/schema'
import type { JobRunStatus } from '@spaces/db/schema/jobs'
import type { ImportFailure } from './stage'
import type { MappingObject } from './mapping'

/**
 * **Idempotent commit** (SPA-169, import-7; CONTEXT.md phase 15 item 9 —
 * per-row errors, never all-or-nothing). The `import.commit` job replays the
 * stored plan row by row, **each row in its own transaction**: its secondary
 * creates first (`alsoCreates`), then its own record through the creator the
 * plan named — `resolveEntity` for people and companies, `birthDealProgram`
 * for deals, `createRecordProgram` for a custom record — then its references,
 * then its values through `setValues`, with the source `import`, the
 * importing human as actor and the batch id on every `attribute_event`. A
 * failure anywhere rolls that row back alone and leaves its reason on
 * `import_row.error`; the next row carries on.
 *
 * **Re-run writes nothing.** A row that holds an `entity_id` is passed over,
 * so committing a batch twice changes no row count anywhere, and a failed
 * row can be re-run on its own once its cause is fixed (`onlyFailed`).
 *
 * **The plan is intent; the creators are truth.** Each row is resolved again
 * inside its transaction — someone may have created the record since the
 * preview — and when the creator's answer differs from the stored verdict
 * both are kept on the plan (`committedAs`).
 *
 * Near-identical names reach the review inbox through the creators' own
 * sweeps (`resolveEntity`'s for people and companies, the object-scoped one
 * for a custom record), run once the row has committed. An import is a human
 * write: it writes values directly and never proposes.
 *
 * A ledger batch (SPA-171) goes through the same request, job, refusals and
 * receipt, and its rows through `./ledger-commit` — portfolio events
 * appended through the portfolio write path, not records.
 *
 * Outside `lib/server/` for the barrel's reason (CLAUDE.md → Traps).
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

/** The sentence a caller shows for a commit refusal. */
export function commitMessage(failure: unknown): string {
  if (failure instanceof ImportRefused) return failure.reason
  if (failure instanceof ImportNotFound) return 'This import no longer exists'
  return 'Could not commit this import'
}

// ---------------------------------------------------------------------------
// Requesting a commit
// ---------------------------------------------------------------------------

export type CommitRequest = {
  batchId: string
  /** The human committing — the actor of every value the job writes. */
  userId: string
  /** Re-run only the rows whose last attempt failed. */
  onlyFailed: boolean
}

/** Rows still waiting on a collision decision. */
const undecidedOf = (batchId: string) =>
  query(() =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(importRow)
      .where(
        and(eq(importRow.batchId, batchId), eq(importRow.verdict, 'collide')),
      )
      .then((r) => r.at(0)?.n ?? 0),
  )

const failedOf = (batchId: string) =>
  query(() =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(importRow)
      .where(and(eq(importRow.batchId, batchId), isNotNull(importRow.error)))
      .then((r) => r.at(0)?.n ?? 0),
  )

/** What a batch must be before a commit may run, said as a refusal. */
const committableBatch = Effect.fn('committableBatch')(function* (
  batchId: string,
  onlyFailed: boolean,
) {
  const batch = yield* query(() =>
    db
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .then((rows) => rows.at(0)),
  )
  if (!batch) return yield* new ImportNotFound()
  if (batch.mode === 'records' && batch.targetObjectId === null)
    return yield* new ImportRefused({
      reason: 'Pick the object this import fills before committing it',
    })
  if (batch.status === 'staged')
    return yield* new ImportRefused({
      reason: 'Preview the import before committing it',
    })
  const undecided = yield* undecidedOf(batchId)
  if (undecided > 0)
    return yield* new ImportRefused({
      reason: `${undecided} rows collide — decide them before committing`,
    })
  if (onlyFailed && (yield* failedOf(batchId)) === 0)
    return yield* new ImportRefused({ reason: 'No failed rows to retry' })
  return batch
})

/**
 * The Commit button and Retry failed rows: refuse what cannot run, then
 * enqueue `import.commit` keyed by the batch, so a second press while one is
 * queued or running is refused by pg-boss (`queued: false`), not run twice.
 */
export const requestCommitProgram = Effect.fn('requestCommitProgram')(
  function* (
    input: CommitRequest,
  ): Effect.fn.Return<{ queued: boolean }, ImportFailure> {
    yield* committableBatch(input.batchId, input.onlyFailed)
    const id = yield* Effect.promise(() =>
      enqueue(
        QUEUES.importCommit,
        {
          batchId: input.batchId,
          userId: input.userId,
          onlyFailed: input.onlyFailed,
        },
        { singletonKey: input.batchId },
      ),
    )
    if (id !== null) return { queued: true }
    const jobs = yield* Effect.promise(() =>
      jobsByKey(QUEUES.importCommit, input.batchId),
    )
    if (jobs?.some((j) => isLive(j.state))) return { queued: false }
    return yield* new ImportRefused({
      reason: 'The worker queue is unreachable — try again in a moment',
    })
  },
)

const isLive = (state: string) =>
  state === 'created' || state === 'retry' || state === 'active'

// ---------------------------------------------------------------------------
// The job's program
// ---------------------------------------------------------------------------

type LoadedRow = {
  rowNum: number
  cells: Array<string>
  plan: RowPlan
  entityId: string | null
  error: string | null
}

/** Everything one run reads once and every row shares. */
type RunContext = {
  batchId: string
  userId: string
  object: MappingObject
  /** Live attributes of the target object, by id. */
  attributes: Map<string, MappingAttribute>
  /** Identity key → the sheet column mapped to it. */
  identityColumns: Array<{ key: CoreIdentityKey; column: number }>
  /** Referenced objects a secondary create may land in, by id. */
  objects: Map<string, { kind: ObjectKind | null }>
  /** Every secondary create the plans carry, by key. */
  creates: Map<string, ImportAlsoCreate>
  /** Secondary creates already made — this run's and earlier runs'. */
  made: Map<string, string>
}

/** Work that must wait for the row's transaction to commit. */
type AfterCommit = () => Promise<void>

type RowWrite = {
  entityId: string
  action: 'attach' | 'create'
  alsoCreated: Record<string, string>
  after: Array<AfterCommit>
}

/** A row's failure reason, as the outcome lane prints it. */
function reasonOf(failure: unknown): string {
  const text =
    failure instanceof AttributeValidationError ||
    failure instanceof EntityNotFound ||
    failure instanceof ObjectRejected
      ? failure.message
      : failure instanceof ImportRefused
        ? failure.reason
        : failure instanceof Error && failure.message !== ''
          ? failure.message
          : 'Could not write this row'
  return text.slice(0, 300)
}

/** A committed row's embeddable values, queued once it has committed. */
const reembedAll =
  (sources: Array<EmbedSource>): AfterCommit =>
  async () => {
    for (const s of sources) await enqueueSourceEmbed(s)
  }

/** `resolveEntity`'s step 3, after the commit — never fatal to the row. */
const resolveSweep =
  (entityId: string, nameNorm: string): AfterCommit =>
  async () => {
    await sweepNameSimilarity(entityId, nameNorm).catch((err: unknown) =>
      console.error('[import] fuzzy sweep failed', err),
    )
  }

/** The object-scoped sweep a custom record's birth runs, after the commit. */
const recordSweep =
  (entityId: string, name: string): AfterCommit =>
  () =>
    Effect.runPromise(sweepRecordName(entityId, name))

const IMPORT_SOURCE = { class: 'import' } as const

/**
 * A secondary create (SPA-168's `alsoCreates`): a record of the referenced
 * object, through that object's own creator, inside the row's transaction.
 */
async function makeSecondary(
  tx: Tx,
  ctx: RunContext,
  entry: ImportAlsoCreate,
): Promise<{ id: string; after: Array<AfterCommit> }> {
  const plan = entry.plan
  const kind = ctx.objects.get(entry.objectId)?.kind ?? null
  if (plan.creator === 'resolveEntity') {
    if (kind !== 'company' && kind !== 'person')
      throw new Error('The referenced object is not a company or a person')
    const out = await resolveEntityInTx(tx, {
      kind,
      name: plan.name ?? undefined,
      keys: plan.identity,
      source: IMPORT_SOURCE,
      createdBy: ctx.userId,
      valuesSource: 'import',
      batchId: ctx.batchId,
    })
    const after = [reembedAll(out.reembed), () => emitDomainEvent(out.emit)]
    if (out.sweepName !== null)
      after.push(resolveSweep(out.entityId, out.sweepName))
    return { id: out.entityId, after }
  }
  if (plan.creator === 'createRecordProgram') {
    const values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(plan.identity))
      if (key === 'domain' || key === 'linkedin')
        values[IDENTITY_KEY_ATTRIBUTES[key].slug] = value
    const out = await Effect.runPromise(
      createRecordInTxProgram(tx, {
        objectId: entry.objectId,
        name: plan.name ?? '',
        values,
        actor: { type: 'user', id: ctx.userId },
        source: 'import',
        batchId: ctx.batchId,
      }),
    )
    return {
      id: out.id,
      after: [reembedAll(out.reembed), recordSweep(out.id, out.name)],
    }
  }
  throw new Error('A deal is born with its company — import Deals separately')
}

/** The row's identity cells as the sheet spelled them — its creator normalises. */
function rawIdentity(
  ctx: RunContext,
  rows: ReadonlyArray<LoadedRow>,
): Partial<Record<CoreIdentityKey, string>> {
  const out: Partial<Record<CoreIdentityKey, string>> = {}
  for (const row of rows)
    for (const { key, column } of ctx.identityColumns) {
      if (out[key] !== undefined || row.plan.identity[key] === undefined)
        continue
      const raw = (row.cells.at(column) ?? '').trim()
      if (raw !== '') out[key] = raw
    }
  return out
}

/**
 * The patch as `setValues` takes it — by slug, over the live registry. An
 * attribute archived since the preview is left out rather than failing the
 * row: the plan was written against a registry that has since moved.
 */
function slugPatch(
  ctx: RunContext,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [attributeId, value] of Object.entries(patch)) {
    const def = ctx.attributes.get(attributeId)
    if (def) out[def.slug] = value
  }
  return out
}

/**
 * One row, inside its transaction: secondary creates, the record, the
 * references, the values. `rows` is the survivor first, then the rows folded
 * into it, in sheet order.
 */
async function writeRow(
  tx: Tx,
  ctx: RunContext,
  plan: RowPlan,
  rows: ReadonlyArray<LoadedRow>,
): Promise<RowWrite> {
  // The batch cannot have moved under the run: a mapping change or a new
  // decision takes this row lock and returns the batch to `staged`.
  const status = (
    await tx
      .select({ status: importBatch.status })
      .from(importBatch)
      .where(eq(importBatch.id, ctx.batchId))
      .for('share')
  ).at(0)?.status
  if (status !== 'planned' && status !== 'committed')
    throw new ImportRefused({ reason: 'The import changed during the commit' })

  const after: Array<AfterCommit> = []
  const alsoCreated: Record<string, string> = {}

  // 1. Secondary creates this row's references need and nobody has made.
  const refIds = new Map<string, string>()
  for (const key of createKeysOf(plan)) {
    const made = ctx.made.get(key)
    if (made !== undefined) {
      refIds.set(key, made)
      continue
    }
    const entry = ctx.creates.get(key)
    if (!entry)
      throw new Error('A record this row references was never planned')
    const out = await makeSecondary(tx, ctx, entry)
    after.push(...out.after)
    alsoCreated[key] = out.id
    refIds.set(key, out.id)
  }

  // 2. The references: a hit is already in the patch; a create lands now.
  const patch: Record<string, unknown> = { ...plan.patch }
  for (const ref of plan.references ?? []) {
    if (ref.to !== 'create' || ref.attributeId in patch) continue
    const id = refIds.get(ref.key)
    const def = ctx.attributes.get(ref.attributeId)
    if (id === undefined || !def) continue
    patch[ref.attributeId] = def.options.multi ? [id] : id
  }
  const values = slugPatch(ctx, patch)
  const actor = { type: 'user' as const, id: ctx.userId }
  const identity = rawIdentity(ctx, rows)

  // 3. The record, through the creator the plan named, and its values.
  const kind = ctx.object.kind
  if (plan.creator === 'resolveEntity') {
    if (kind !== 'company' && kind !== 'person')
      throw new Error('This object is not a company or a person')
    const out = await resolveEntityInTx(tx, {
      kind,
      name: plan.name ?? undefined,
      keys: identity,
      source: IMPORT_SOURCE,
      createdBy: ctx.userId,
      values,
      valuesSource: 'import',
      batchId: ctx.batchId,
    })
    after.push(reembedAll(out.reembed), () => emitDomainEvent(out.emit))
    if (out.sweepName !== null)
      after.push(resolveSweep(out.entityId, out.sweepName))
    if (out.action === 'attached') {
      // The birth values ride the create; an attach writes them here.
      const set = await setValuesInTx(tx, {
        entityId: out.entityId,
        patch: values,
        actor,
        source: 'import',
        batchId: ctx.batchId,
      })
      after.push(reembedAll(set.reembed))
    }
    return {
      entityId: out.entityId,
      action: out.action === 'attached' ? 'attach' : 'create',
      alsoCreated,
      after,
    }
  }
  if (plan.creator === 'dealBirth') {
    const { company, stage, ...rest } = values
    if (typeof company !== 'string') throw new Error('A deal needs its company')
    const born = await Effect.runPromise(
      birthDealProgram(
        {
          name: plan.name ?? '',
          companyId: company,
          stage: typeof stage === 'string' ? stage : undefined,
          values: rest,
          actorId: ctx.userId,
          source: 'import',
          batchId: ctx.batchId,
        },
        tx,
      ),
    )
    return { entityId: born.id, action: 'create', alsoCreated, after }
  }
  const backing: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(identity))
    if (key === 'domain' || key === 'linkedin')
      backing[IDENTITY_KEY_ATTRIBUTES[key].slug] = value
  const born = await Effect.runPromise(
    createRecordInTxProgram(tx, {
      objectId: ctx.object.id,
      name: plan.name ?? '',
      values: { ...values, ...backing },
      actor,
      source: 'import',
      batchId: ctx.batchId,
    }),
  )
  after.push(reembedAll(born.reembed), recordSweep(born.id, born.name))
  return { entityId: born.id, action: 'create', alsoCreated, after }
}

/** The plan as stored after the commit: intent, plus what happened. */
function committedPlan(plan: RowPlan, write: RowWrite): RowPlan {
  const out: RowPlan = { ...plan }
  if (write.action !== plan.verdict) out.committedAs = write.action
  const made = { ...plan.alsoCreated, ...write.alsoCreated }
  if (Object.keys(made).length > 0) out.alsoCreated = made
  return out
}

const loadRows = (batchId: string) =>
  query(() =>
    db
      .select({
        rowNum: importRow.rowNum,
        cells: importRow.cells,
        plan: importRow.plan,
        entityId: importRow.entityId,
        error: importRow.error,
      })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum))
      .then((rows) =>
        // A ledger plan (SPA-170) is not this path's: its events commit
        // through `commitLedgerProgram` (SPA-171), and a records batch
        // holds none.
        rows.flatMap((r): Array<LoadedRow> =>
          r.plan && !('kind' in r.plan) ? [{ ...r, plan: r.plan }] : [],
        ),
      ),
  )

/** The objects a secondary create may land in, with their core kinds. */
const loadObjects = (ids: Array<string>) =>
  query(async () => {
    if (ids.length === 0) return new Map<string, { kind: ObjectKind | null }>()
    const rows = await db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        isSystem: objectDef.isSystem,
      })
      .from(objectDef)
      .where(inArray(objectDef.id, ids))
    return new Map(rows.map((r) => [r.id, { kind: coreKindOf(r) }]))
  })

/**
 * `import.commit`'s program. Refuses a batch that cannot commit; answers a
 * committed batch asked again with a run that wrote nothing; otherwise walks
 * the rows in sheet order and commits each landing row in its own
 * transaction. The batch is `committed` once a full run has walked every
 * row — failures stay on their rows, for `onlyFailed` to re-run.
 */
export const commitImportProgram = Effect.fn('commitImportProgram')(function* (
  input: CommitRequest,
): Effect.fn.Return<CommitRun, ImportFailure> {
  const batch = yield* committableBatch(input.batchId, input.onlyFailed)
  // A ledger batch's rows are portfolio events (SPA-171).
  if (batch.mode === 'ledger') return yield* commitLedgerProgram(batch, input)
  if (batch.targetObjectId === null)
    return yield* new ImportRefused({
      reason: 'Pick the object this import fills before committing it',
    })
  const rows = yield* loadRows(batch.id)
  const run = emptyRun()

  if (batch.status === 'committed' && !input.onlyFailed) {
    run.unchanged = rows.filter((r) => r.entityId !== null).length
    return run
  }

  const object = yield* mappingObjectOf(batch.targetObjectId)
  const width = batch.header?.length ?? rows.at(0)?.cells.length ?? 0
  const mapping: Mapping = fitMapping(batch.mapping ?? [], width)
  const identityColumns: Array<{ key: CoreIdentityKey; column: number }> = []
  mapping.forEach((t, column) => {
    if (t.target === 'identity') identityColumns.push({ key: t.key, column })
  })
  const creates = new Map<string, ImportAlsoCreate>()
  const made = new Map<string, string>()
  for (const row of rows) {
    for (const entry of row.plan.alsoCreates ?? [])
      if (!creates.has(entry.key)) creates.set(entry.key, entry)
    for (const [key, id] of Object.entries(row.plan.alsoCreated ?? {}))
      made.set(key, id)
  }
  // A create another row's reference names, but no row carries, still has
  // its plan on the reference itself.
  for (const row of rows)
    for (const ref of row.plan.references ?? [])
      if (ref.to === 'create' && !creates.has(ref.key))
        creates.set(ref.key, {
          key: ref.key,
          column: ref.column,
          attributeId: ref.attributeId,
          objectId: ref.objectId,
          plan: {
            verdict: 'create',
            creator: ref.creator,
            name: ref.createName,
            patch: {},
            identity: ref.identity,
            errors: [],
            skippedCells: [],
          },
        })
  const ctx: RunContext = {
    batchId: batch.id,
    userId: input.userId,
    object,
    attributes: new Map(
      object.registry.attributes
        .filter((a) => !a.archived)
        .map((a) => [a.id, a]),
    ),
    identityColumns,
    objects: yield* loadObjects([
      ...new Set([...creates.values()].map((c) => c.objectId)),
    ]),
    creates,
    made,
  }

  const byNum = new Map(rows.map((r) => [r.rowNum, r]))
  const folds = foldMerged(rows)

  for (const row of rows) {
    if (row.entityId !== null) {
      run.unchanged += 1
      continue
    }
    if (row.plan.verdict === 'skip' && row.plan.skipReason === undefined) {
      yield* query(() =>
        db
          .update(importRow)
          .set({ plan: { ...row.plan, skipReason: SKIP_BOTH_REASON } })
          .where(
            and(
              eq(importRow.batchId, batch.id),
              eq(importRow.rowNum, row.rowNum),
            ),
          ),
      )
      continue
    }
    const fold = folds.get(row.rowNum)
    if (!fold) continue
    if (input.onlyFailed && row.error === null) continue
    const members = [
      row,
      ...fold.folded.flatMap((n) => {
        const r = byNum.get(n)
        return r ? [r] : []
      }),
    ]
    const outcome = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const write = await writeRow(tx, ctx, fold.plan, members)
          await tx
            .update(importRow)
            .set({
              entityId: write.entityId,
              error: null,
              plan: committedPlan(row.plan, write),
            })
            .where(
              and(
                eq(importRow.batchId, batch.id),
                eq(importRow.rowNum, row.rowNum),
              ),
            )
          if (fold.folded.length > 0)
            await tx
              .update(importRow)
              .set({ entityId: write.entityId, error: null })
              .where(
                and(
                  eq(importRow.batchId, batch.id),
                  inArray(importRow.rowNum, fold.folded),
                ),
              )
          return write
        }),
      catch: (cause) => cause,
    }).pipe(Effect.result)

    if (outcome._tag === 'Failure') {
      const reason = reasonOf(outcome.failure)
      yield* query(() =>
        db
          .update(importRow)
          .set({ error: reason })
          .where(
            and(
              eq(importRow.batchId, batch.id),
              eq(importRow.rowNum, row.rowNum),
            ),
          ),
      )
      run.failed += 1
      continue
    }
    const write = outcome.success
    for (const [key, id] of Object.entries(write.alsoCreated)) made.set(key, id)
    for (const step of write.after)
      yield* Effect.promise(() =>
        step().catch((err: unknown) =>
          console.error('[import] after-commit step failed', err),
        ),
      )
    if (write.action === 'attach') run.attached += 1
    else run.written += 1
  }

  if (!input.onlyFailed && batch.status === 'planned')
    yield* query(() =>
      db
        .update(importBatch)
        .set({ status: 'committed', committedAt: new Date() })
        .where(
          and(eq(importBatch.id, batch.id), eq(importBatch.status, 'planned')),
        ),
    )
  return run
})

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

/** Rows the receipt draws before its `+ N more` fold. */
export const RECEIPT_ROWS = 200

export const RECEIPT_FILTERS = ['all', 'failed'] as const

export type ReceiptFilter = (typeof RECEIPT_FILTERS)[number]

export type ReceiptRow = {
  rowNum: number
  name: string | null
  verdict: ImportVerdict
  outcome: CommitOutcome
  /** The record the row wrote or landed on, with where it lives. */
  record: { name: string; href: string | null } | null
}

export type ImportReceiptView = {
  status: ImportBatchStatus
  committedAt: string | null
  counts: CommitCounts
  /** A commit of this batch is queued or running (pg-boss, keyed by the batch). */
  running: boolean
  /** The latest `import.commit` attempt for this batch, off `job_run`. */
  lastRun: {
    status: JobRunStatus
    line: string | null
    durationMs: number | null
    startedAt: string
  } | null
  rows: Array<ReceiptRow>
  /** Rows the filter matches in all. */
  matching: number
  filter: ReceiptFilter
  object: { kind: ObjectKind | null; plural: string }
  /** A ledger batch's half (SPA-171): its strip, missing rates and void note. */
  ledger: LedgerReceipt | null
}

/**
 * The batch page after Commit: the strip's counts off `import_row`, whether
 * a run is live off pg-boss, the last run's line off `job_run`, and the
 * first rows with their outcomes — every part read from the database, so
 * reopening the page recovers exactly where the commit is. Null while the
 * batch has not been committed and no commit has started.
 */
export const loadImportReceiptProgram = Effect.fn('loadImportReceiptProgram')(
  function* (input: {
    batchId: string
    filter: ReceiptFilter
  }): Effect.fn.Return<ImportReceiptView | null, ImportFailure> {
    const batch = yield* query(() =>
      db
        .select()
        .from(importBatch)
        .where(eq(importBatch.id, input.batchId))
        .then((rows) => rows.at(0)),
    )
    if (!batch) return yield* new ImportNotFound()
    if (batch.mode === 'records' && batch.targetObjectId === null) return null
    const inBatch = eq(importRow.batchId, batch.id)
    const tally = yield* query(() =>
      db
        .select({
          written: sql<number>`count(*) filter (where ${importRow.entityId} is not null and ${importRow.verdict} in ('attach', 'create') and coalesce(${importRow.plan} ->> 'committedAs', ${importRow.verdict}) = 'create')::int`,
          attached: sql<number>`count(*) filter (where ${importRow.entityId} is not null and ${importRow.verdict} in ('attach', 'create') and coalesce(${importRow.plan} ->> 'committedAs', ${importRow.verdict}) = 'attach')::int`,
          failed: sql<number>`count(*) filter (where ${importRow.error} is not null)::int`,
          remaining: sql<number>`count(*) filter (where ${importRow.entityId} is null and ${importRow.error} is null and ${importRow.verdict} in ('attach', 'create'))::int`,
        })
        .from(importRow)
        .where(inBatch)
        .then(
          (r) =>
            r.at(0) ?? { written: 0, attached: 0, failed: 0, remaining: 0 },
        ),
    )
    const jobs = yield* Effect.promise(() =>
      jobsByKey(QUEUES.importCommit, batch.id),
    )
    const running = jobs?.some((j) => isLive(j.state)) ?? false
    const started = tally.written + tally.attached + tally.failed > 0
    if (batch.status !== 'committed' && !running && !started) return null

    const prefix = runLinePrefix(batch.id)
    const last = yield* query(() =>
      db
        .select({
          status: jobRun.status,
          summary: jobRun.summary,
          error: jobRun.error,
          durationMs: jobRun.durationMs,
          startedAt: jobRun.startedAt,
        })
        .from(jobRun)
        .where(
          and(
            eq(jobRun.queue, QUEUES.importCommit),
            or(
              like(jobRun.summary, `${prefix}%`),
              like(jobRun.error, `%${prefix}%`),
            ),
          ),
        )
        .orderBy(desc(jobRun.startedAt))
        .limit(1)
        .then((r) => r.at(0)),
    )

    const where = and(
      inBatch,
      input.filter === 'failed' ? isNotNull(importRow.error) : undefined,
    )
    const found = yield* query(() =>
      db
        .select({
          rowNum: importRow.rowNum,
          plan: importRow.plan,
          entityId: importRow.entityId,
          error: importRow.error,
          recordName: entity.canonicalName,
          recordKind: entity.kind,
          objectSlug: objectDef.slug,
        })
        .from(importRow)
        .leftJoin(entity, eq(entity.id, importRow.entityId))
        .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
        .where(where)
        .orderBy(asc(importRow.rowNum))
        .limit(RECEIPT_ROWS),
    )
    const matching = yield* query(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(importRow)
        .where(where)
        .then((r) => r.at(0)?.n ?? 0),
    )
    const targetObjectId = batch.targetObjectId
    const object =
      targetObjectId === null
        ? undefined
        : yield* query(() =>
            db
              .select({
                slug: objectDef.slug,
                plural: objectDef.plural,
                isSystem: objectDef.isSystem,
              })
              .from(objectDef)
              .where(eq(objectDef.id, targetObjectId))
              .then((r) => r.at(0)),
          )
    const ledger =
      batch.mode === 'ledger' ? yield* loadLedgerReceiptProgram(batch.id) : null
    return {
      status: batch.status,
      committedAt: batch.committedAt?.toISOString() ?? null,
      counts: tally,
      running,
      lastRun: last
        ? {
            status: last.status,
            line: lineOf(prefix, last.summary ?? last.error),
            durationMs: last.durationMs,
            startedAt: last.startedAt.toISOString(),
          }
        : null,
      rows: found.flatMap((r): Array<ReceiptRow> => {
        if (!r.plan) return []
        const outcome = commitOutcomeOf({
          plan: r.plan,
          entityId: r.entityId,
          error: r.error,
        })
        return [
          {
            rowNum: r.rowNum,
            name: r.plan.name,
            verdict: r.plan.verdict,
            outcome,
            record:
              r.entityId !== null &&
              r.recordName !== null &&
              r.recordKind !== null
                ? {
                    name: r.recordName,
                    // A ledger row's events live on the company's holding.
                    href:
                      outcome.kind === 'appended'
                        ? `/portfolio/${outcome.holdingId}`
                        : recordPath({
                            kind: r.recordKind,
                            id: r.entityId,
                            objectSlug: r.objectSlug,
                          }),
                  }
                : null,
          },
        ]
      }),
      matching,
      filter: input.filter,
      object: {
        kind: object ? coreKindOf(object) : null,
        plural: object?.plural ?? 'records',
      },
      ledger,
    }
  },
)

/** The run's line without the batch id it was found by. */
function lineOf(prefix: string, text: string | null): string | null {
  if (text === null) return null
  const at = text.indexOf(prefix)
  return at === -1 ? text : text.slice(0, at) + text.slice(at + prefix.length)
}
