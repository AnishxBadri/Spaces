import { Effect, Schema } from 'effect'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { objectIdForKindAsync } from '@spaces/core/writes/attributes/objects'
import {
  AttributeValidationError,
  EntityNotFound,
  setValuesInTx,
} from '@spaces/core/writes/attributes/values'
import type { Tx } from '@spaces/core/writes/attributes/values'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import { birthHolding } from '#/lib/portfolio/holding'

/**
 * **Deal birth** (SPA-169) — the one program a deal is born through. It was
 * the body of `createDeal`'s handler, where the stage=`invested` →
 * `birthHolding` hook lived inline in a server fn with no reusable program;
 * the importer needs exactly that pipeline→portfolio seam and must not own a
 * second copy of it, so the body moved here and `createDeal` became a thin
 * caller through `effectFn`.
 *
 * Outside `lib/server/` for the barrel's reason (CLAUDE.md → Traps): the
 * import worker and the tests call it without a request.
 *
 * One transaction: the entity, its birth values (supplied, then defaults),
 * the `deal.created` activity and — at Invested — the holding land together
 * or not at all. Given a transaction (`tx`), the birth runs inside it, which
 * is how an import row's deal lands or fails with the rest of that row.
 */

/**
 * Which door the deal came through. `manual` is a person at the create
 * dialog — `source_class` `manual`, events `direct`, as `createDeal` has
 * always stamped; `import` is a committed spreadsheet row.
 */
export type DealSource = 'manual' | 'import'

export type BirthDealInput = {
  name: string
  companyId: string
  /** Defaults to `pre_lead`, as the create dialog always has. */
  stage?: string | undefined
  /** Further supplied values by attribute slug — `value`, `source`, anything an import maps. */
  values?: Record<string, unknown> | undefined
  /** The human the birth names: `created_by`, the events' actor, the activity. */
  actorId: string
  source: DealSource
  /** The import batch the birth belongs to; stamped on every event it writes. */
  batchId?: string | undefined
}

/** What the create dialog posts to `createDeal`, once validated. */
export type DealDialogInput = {
  companyId: string
  name: string
  stage?: string | undefined
  value?: number | undefined
  source?: string | undefined
}

/**
 * `createDeal`'s whole handler below `requireUser`: the dialog's fields as a
 * birth. Its own function so a test drives the dialog's exact path through
 * `birthDealProgram` without a request to authenticate.
 */
export function dealFromDialog(
  data: DealDialogInput,
  actorId: string,
): BirthDealInput {
  return {
    name: data.name,
    companyId: data.companyId,
    stage: data.stage,
    values: {
      ...(data.value !== undefined ? { value: data.value } : {}),
      ...(data.source ? { source: data.source } : {}),
    },
    actorId,
    source: 'manual',
  }
}

export type BirthDealResult = {
  id: string
  /** The holding an Invested birth opened or found; null below Invested. */
  holdingId: string | null
}

export class DealBirthFailed extends Schema.TaggedError<DealBirthFailed>()(
  'DealBirthFailed',
  { cause: Schema.Defect() },
) {}

const EVENT_SOURCE = { manual: 'direct', import: 'import' } as const

/** Supplied values as birth reads them: blanks are not assertions. */
function suppliedOf(input: BirthDealInput): Record<string, unknown> {
  const all: Record<string, unknown> = {
    ...input.values,
    company: input.companyId,
    stage: input.stage ?? 'pre_lead',
  }
  return Object.fromEntries(
    Object.entries(all).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    ),
  )
}

/**
 * The birth itself, inside a transaction the caller owns. Returns the
 * embeddable values it set, to be chunked once that transaction commits —
 * the same hand-off `setValuesInTx` makes.
 */
export async function birthDealInTx(
  tx: Tx,
  input: BirthDealInput,
): Promise<BirthDealResult & { reembed: Array<EmbedSource> }> {
  const objectId = await objectIdForKindAsync('deal')
  const born = (
    await tx
      .insert(entity)
      .values({
        kind: 'deal',
        objectId,
        canonicalName: input.name,
        sourceClass: input.source,
        createdBy: input.actorId,
      })
      .returning({ id: entity.id })
  ).at(0)
  if (!born) throw new Error('Deal insert returned no row')

  // Birth = supplied values, then defaults (spec §4). Owner is not stamped
  // here: `deal.owner` defaults to current-user, so the dialog, an import
  // and any other path with a human present agree on who owns it.
  const { reembed } = await setValuesInTx(tx, {
    entityId: born.id,
    patch: suppliedOf(input),
    actor: { type: 'user', id: input.actorId },
    source: EVENT_SOURCE[input.source],
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    fillDefaults: { now: new Date() },
  })
  await tx.insert(activity).values({
    actorId: input.actorId,
    verb: 'deal.created',
    subjectEntityId: input.companyId,
    objectEntityId: born.id,
  })
  // The pipeline→portfolio seam applies at birth too: a deal *born* at
  // Invested (an import, direct entry) births its holding just like one
  // moved there (companies.ts updateRecord has the twin hook).
  const holdingId =
    input.stage === 'invested'
      ? (
          await birthHolding(
            { companyId: input.companyId, actorId: input.actorId },
            tx,
          )
        ).id
      : null
  return { id: born.id, holdingId, reembed }
}

/**
 * The program. Without `tx` it opens its own transaction and, once that
 * commits, queues the embeddable values it set; with one, it runs inside the
 * caller's and leaves that step to whoever commits it.
 */
export const birthDealProgram = Effect.fn('birthDealProgram')(function* (
  input: BirthDealInput,
  tx?: Tx,
): Effect.fn.Return<
  BirthDealResult,
  AttributeValidationError | EntityNotFound | DealBirthFailed
> {
  const out = yield* Effect.tryPromise({
    try: () =>
      tx
        ? birthDealInTx(tx, input)
        : db.transaction((t) => birthDealInTx(t, input)),
    catch: (cause) =>
      cause instanceof AttributeValidationError ||
      cause instanceof EntityNotFound
        ? cause
        : new DealBirthFailed({ cause }),
  })
  if (!tx)
    for (const source of out.reembed)
      yield* Effect.promise(() => enqueueSourceEmbed(source))
  return { id: out.id, holdingId: out.holdingId }
})
