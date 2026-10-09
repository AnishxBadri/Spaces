import { Effect } from 'effect'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { workspace } from '@spaces/db/schema/workspace'
import { JobPermanent, JobRetryable } from '@spaces/sdk'
import type { JobError } from '@spaces/sdk'
import { EnrichmentCollector } from '../../enrichment/collector'
import type { Collector } from '../../enrichment/collector'
import { wantedKeys } from '../../enrichment/plan'
import type { SourceAnswer } from '../../enrichment/plan'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  orderSources,
} from '../../enrichment/settings'
import { EnrichmentSources } from '../../enrichment/sources'
import type { AskResult } from '../../enrichment/sources'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import { EntityNotFound } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import { applyRun, holdingsOf, linksForEntity } from './apply'
import type { RunApplied, RunSource } from './apply'

/**
 * `enrichment.run(entityId, reason)` (D76): the owner's sources asked in
 * order, each for the linked keys still wanted after the ones before it,
 * and every answer applied at once by `applyRun`.
 * - A source is asked through `EnrichmentSources`; its `Facts.answer` lands
 *   in this run's `EnrichmentCollector`, not on the record.
 * - A source that fails or is declined is recorded in the receipt and the
 *   run goes on to the next.
 * - Nothing asked — no source, nothing wanted — writes nothing at all.
 */

export type RunOutcome =
  | { readonly ran: false; readonly reason: string }
  | ({ readonly ran: true } & Omit<RunApplied, 'reembed'>)

const reasonOf = (error: JobError) => `${error._tag}: ${error.reason}`

const retryable = (what: string) => (cause: unknown) =>
  cause instanceof EntityNotFound
    ? new JobPermanent({ reason: `${what}: ${cause.message}` })
    : new JobRetryable({
        reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

const read = <T>(what: string, run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: retryable(what) })

/** The runnable integrations with an enrich action for `kind`, in the owner's order. */
const sourcesFor = (kind: 'company' | 'person') =>
  Effect.gen(function* () {
    const settings = yield* read('enrichment.run: settings', async () =>
      enrichmentSettingsOf(
        (
          await db
            .select({ settings: workspace.settings })
            .from(workspace)
            .limit(1)
        ).at(0)?.settings ?? {},
      ),
    )
    const rows = yield* read('enrichment.run: sources', () =>
      db
        .select({ id: integration.id, manifest: integration.manifest })
        .from(integration)
        .where(
          and(eq(integration.enabled, true), eq(integration.status, 'enabled')),
        )
        .orderBy(asc(integration.createdAt)),
    )
    const runnable = rows.filter((r) => enrichActionFor(r.manifest, kind))
    return { settings, sources: orderSources(settings, runnable) }
  })

/** Credits a source's receipts for this record used since the run began. */
const creditsSince = (integrationId: string, entityId: string, since: Date) =>
  read(
    'enrichment.run: credits',
    async () =>
      (
        await db
          .select({
            spent:
              sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
                Number,
              ),
          })
          .from(enrichmentRecord)
          .where(
            and(
              eq(enrichmentRecord.integrationId, integrationId),
              eq(enrichmentRecord.entityId, entityId),
              gte(enrichmentRecord.fetchedAt, since),
            ),
          )
      ).at(0)?.spent ?? 0,
  )

export const runEnrichment = Effect.fn('runEnrichment')(function* (
  requested: string,
  reason: string,
): Effect.fn.Return<RunOutcome, JobError, EnrichmentSources | Enqueue> {
  const entityId = yield* read('enrichment.run', () => canonicalId(requested))
  const record = yield* read('enrichment.run', async () =>
    (
      await db
        .select({ values: entity.values, now: sql<Date>`now()` })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0),
  )
  if (record === undefined)
    return yield* new JobPermanent({ reason: `no record ${entityId}` })
  const { links, kind } = yield* read('enrichment.run', () =>
    linksForEntity(entityId),
  )
  if (kind === null) return { ran: false, reason: 'not a company or a person' }
  const holdings = yield* read('enrichment.run', () =>
    holdingsOf(db, entityId, record.values, links),
  )
  const started = new Date(record.now)
  const { settings, sources } = yield* sourcesFor(kind)
  const asker = yield* EnrichmentSources

  const ran: Array<RunSource> = []
  const answers: Array<SourceAnswer> = []
  const answered = new Set<string>()
  for (const source of sources) {
    const keys = wantedKeys(links, holdings, answered)
    if (keys.length === 0) break
    const collector: Collector = {
      integrationId: source.id,
      entityId,
      answers: [],
    }
    const result = yield* asker
      .ask(source.id, { entityId, kind, keys, reuseDays: settings.reuseDays })
      .pipe(
        Effect.provideService(EnrichmentCollector, collector),
        Effect.catch((error: JobError) =>
          Effect.succeed<AskResult>({ asked: false, reason: reasonOf(error) }),
        ),
      )
    const credits = yield* creditsSince(source.id, entityId, started)
    if (!result.asked && collector.answers.length === 0) {
      ran.push({
        integrationId: source.id,
        asked: keys,
        credits,
        skipped: result.reason,
      })
      continue
    }
    ran.push({ integrationId: source.id, asked: keys, credits })
    for (const answer of collector.answers) {
      answers.push({ integrationId: source.id, ...answer })
      for (const key of Object.keys(answer.answers)) answered.add(key)
    }
  }
  if (!ran.some((s) => s.skipped === undefined))
    return {
      ran: false,
      reason:
        ran.length === 0
          ? 'no source to ask'
          : ran.map((s) => s.skipped).join('; '),
    }

  const applied = yield* Effect.tryPromise({
    try: () => applyRun({ entityId, reason, sources: ran, answers }),
    catch: retryable('enrichment.run'),
  })
  yield* enqueueEmbeds(applied.reembed)
  return {
    ran: true,
    fields: applied.fields,
    credits: applied.credits,
    suggestionId: applied.suggestionId,
    receiptId: applied.receiptId,
  }
})
