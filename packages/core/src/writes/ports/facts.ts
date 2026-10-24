import { Effect, Layer } from 'effect'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, entityAlias } from '@spaces/db/schema'
import type { Json } from '@spaces/db/json'
import {
  Facts,
  JobPermanent,
  JobRetryable,
  isVocabularyKey,
  vocabularyProblem,
} from '@spaces/sdk'
import type {
  AnswerClaim,
  AnswerResult,
  FactClaim,
  FillResult,
} from '@spaces/sdk'
import { EnrichmentCollector } from '../../enrichment/collector'
import type { Collector } from '../../enrichment/collector'
import { jsonRecord, jsonValue } from '../../json'
import { applyRun, linksForEntity } from '../enrichment/apply'
import { ref } from '../../context/ref'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import {
  AttributeValidationError,
  EntityNotFound,
  setValuesInTx,
} from '../attributes/values'
import type { Tx, ValueConflict } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import { SuggestionInvalid, proposeWith } from '../suggestions/propose'
import type { BoundIntegration } from './binding'
import { ReceiptNotOwned, checkReceipt } from './receipts'
import { integrationPatch } from './judgment'

/**
 * FactsLive: `Facts.fill` over the one attribute write path in fill-blanks
 * mode, so blank is decided under the entity row lock, never by a read first.
 * - **Provenance is the port's**: `actor_type 'integration'`, `actor_ref` =
 *   the bound row, `source 'enrichment'` — never from the claim.
 * - **The receipt is evidence**: `claim.receiptId` becomes `event:<id>` refs,
 *   and must be a receipt **this** integration stored, checked in the
 *   write's transaction — else a plugin could cite another's response.
 * - **Conflicts are refused, returned and raised**: a value someone else
 *   holds is written nowhere, handed back, and proposed as one suggestion in
 *   the fill's own transaction (a re-run is a no-op insert against
 *   `suggestion_open_integration_unique`). A relationship's conflict is
 *   proposed as identity claims, never record ids. This integration's own
 *   earlier value is updated in place — a relationship's never is.
 * - **One transaction**: a refused value fails the fill permanently and
 *   writes nothing. A merged-away record is filled on its survivor.
 * Embeddable values go out through `Enqueue` after the commit. `Facts.answer`
 * feeds the run's `EnrichmentCollector`, or `applyRun` outside a run.
 */

const failure = (cause: unknown) =>
  cause instanceof AttributeValidationError ||
  cause instanceof EntityNotFound ||
  cause instanceof ReceiptNotOwned
    ? new JobPermanent({ reason: `Facts.fill: ${cause.message}` })
    : new JobRetryable({
        reason: `Facts.fill failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

const answerFailure = (cause: unknown) =>
  cause instanceof AttributeValidationError ||
  cause instanceof EntityNotFound ||
  cause instanceof ReceiptNotOwned
    ? new JobPermanent({ reason: `Facts.answer: ${cause.message}` })
    : new JobRetryable({
        reason: `Facts.answer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

/** Shape check before any transaction: a malformed id is the job's bug, not a retry. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the reviewer reads: the slug, who says what, and what is held. */
export const conflictRationale = (
  pluginId: string,
  conflict: ValueConflict,
): string =>
  `${conflict.slug}: ${pluginId} says ${JSON.stringify(conflict.proposed)}; the record holds ${JSON.stringify(conflict.existing)}`

/**
 * Record ids as the identity claims a card proposes a relationship by: the
 * record's name, with its domain or email when it holds one. A suggestion
 * never carries a raw id.
 */
async function referenceClaims(tx: Tx, value: Json): Promise<Json> {
  const ids = (Array.isArray(value) ? value : [value]).map(String)
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: entity.id, name: entity.canonicalName })
    .from(entity)
    .where(inArray(entity.id, ids))
  const keys = await tx
    .select({
      entityId: entityAlias.entityId,
      kind: entityAlias.kind,
      value: entityAlias.value,
    })
    .from(entityAlias)
    .where(
      and(
        inArray(entityAlias.entityId, ids),
        eq(entityAlias.isIdentity, true),
        inArray(entityAlias.kind, ['domain', 'email']),
      ),
    )
    .orderBy(asc(entityAlias.createdAt))
  const claims = ids.flatMap((id) => {
    const named = rows.find((r) => r.id === id)
    if (named === undefined) return []
    const key = keys.find((k) => k.entityId === id)
    return [
      key === undefined
        ? { name: named.name }
        : { name: named.name, [key.kind]: key.value },
    ]
  })
  return Array.isArray(value) ? claims : (claims.at(0) ?? null)
}

/**
 * One suggestion per conflict, on the fill's transaction. A refusal by the
 * proposal validator is the one outcome skipped — it throws before any SQL,
 * so the transaction is untouched; anything else rolls the fill back.
 */
async function raiseConflicts(
  tx: Tx,
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
  entityId: string,
  conflicts: ReadonlyArray<ValueConflict>,
  refs: ReadonlyArray<string>,
) {
  for (const conflict of conflicts) {
    const value = conflict.reference
      ? await referenceClaims(tx, conflict.proposed)
      : conflict.proposed
    const existing = conflict.reference
      ? await referenceClaims(tx, conflict.existing)
      : conflict.existing
    try {
      await proposeWith(
        tx,
        integrationPatch({
          integrationId: row.id,
          entityId,
          slug: conflict.slug,
          value,
          rationale: conflictRationale(row.capabilityId, {
            ...conflict,
            proposed: value,
            existing,
          }),
          refs,
        }),
      )
    } catch (cause) {
      if (!(cause instanceof SuggestionInvalid)) throw cause
    }
  }
}

export const FactsLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
): Layer.Layer<Facts, never, Enqueue> =>
  Layer.effect(
    Facts,
    Effect.gen(function* () {
      const context = yield* Effect.context<Enqueue>()

      const fill = Effect.fn('Facts.fill')(function* (claim: FactClaim) {
        const { receiptId } = claim
        if (!UUID.test(claim.entityId)) {
          return yield* new JobPermanent({
            reason: `Facts.fill: no record ${claim.entityId}`,
          })
        }
        if (receiptId !== undefined && !UUID.test(receiptId)) {
          return yield* new JobPermanent({
            reason: `Facts.fill: no receipt ${receiptId}`,
          })
        }
        const written = yield* Effect.tryPromise({
          try: () =>
            db.transaction(async (tx) => {
              if (receiptId !== undefined)
                await checkReceipt(tx, row.id, receiptId)
              const entityId = await canonicalId(claim.entityId, tx)
              const refs = receiptId === undefined ? [] : [ref.event(receiptId)]
              const result = await setValuesInTx(tx, {
                entityId,
                patch: { ...claim.values },
                actor: { type: 'integration', id: row.id },
                source: 'enrichment',
                ...(refs.length === 0 ? {} : { refs }),
                fillBlanks: true,
              })
              await raiseConflicts(tx, row, entityId, result.conflicts, refs)
              return result
            }),
          catch: failure,
        })
        yield* enqueueEmbeds(written.reembed)
        const result: FillResult = {
          conflicts: written.conflicts.map((c) => ({
            slug: c.slug,
            existing: c.existing,
            proposed: c.proposed,
          })),
        }
        return result
      })

      const answer = Effect.fn('Facts.answer')(function* (
        claim: AnswerClaim,
        collector: Collector | null,
      ) {
        if (!UUID.test(claim.entityId))
          return yield* new JobPermanent({
            reason: `Facts.answer: no record ${claim.entityId}`,
          })
        if (!UUID.test(claim.receiptId))
          return yield* new JobPermanent({
            reason: `Facts.answer: no receipt ${claim.receiptId}`,
          })
        const refused = Object.entries(claim.answers)
          .map(([key, value]) => vocabularyProblem(key, value))
          .find((problem) => problem !== null)
        if (refused !== undefined)
          return yield* new JobPermanent({ reason: `Facts.answer: ${refused}` })
        const asOf =
          claim.asOf === undefined ? new Date() : new Date(claim.asOf)
        if (Number.isNaN(asOf.getTime()))
          return yield* new JobPermanent({
            reason: `Facts.answer: asOf ${claim.asOf ?? ''} is not a date`,
          })
        const answers = jsonValue.safeParse(claim.answers)
        const decoded = answers.success ? jsonRecord(answers.data) : null
        if (decoded === null)
          return yield* new JobPermanent({
            reason: 'Facts.answer: the answers are not JSON',
          })

        const { entityId, linked, credits } = yield* Effect.tryPromise({
          try: async () => {
            await db.transaction((tx) =>
              checkReceipt(tx, row.id, claim.receiptId),
            )
            const survivor = await canonicalId(claim.entityId)
            const { links } = await linksForEntity(survivor)
            const receipt = (
              await db
                .select({ credits: enrichmentRecord.creditsUsed })
                .from(enrichmentRecord)
                .where(eq(enrichmentRecord.id, claim.receiptId))
            ).at(0)
            return {
              entityId: survivor,
              linked: new Set<string>(links.map((l) => l.key)),
              credits: receipt?.credits ?? 0,
            }
          },
          catch: answerFailure,
        })
        const keys = Object.keys(claim.answers)
        const result: AnswerResult = {
          linked: keys.filter((k) => isVocabularyKey(k) && linked.has(k)),
          unlinked: keys.filter((k) => !(isVocabularyKey(k) && linked.has(k))),
        }
        const collected = {
          receiptId: claim.receiptId,
          asOf: asOf.toISOString(),
          answers: decoded,
        }
        if (
          collector !== null &&
          collector.integrationId === row.id &&
          collector.entityId === entityId
        ) {
          collector.answers.push(collected)
          return result
        }
        const applied = yield* Effect.tryPromise({
          try: () =>
            applyRun({
              entityId,
              reason: 'answer',
              sources: [{ integrationId: row.id, asked: null, credits }],
              answers: [{ integrationId: row.id, ...collected }],
            }),
          catch: answerFailure,
        })
        yield* enqueueEmbeds(applied.reembed)
        return result
      })

      return Facts.of({
        fill: (claim) => fill(claim).pipe(Effect.provide(context)),
        answer: (claim) =>
          Effect.gen(function* () {
            const collector = yield* EnrichmentCollector
            return yield* answer(claim, collector).pipe(Effect.provide(context))
          }),
      })
    }),
  )
