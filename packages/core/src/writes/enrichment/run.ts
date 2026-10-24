import { Clock, Effect } from 'effect'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { workspace } from '@spaces/db/schema/workspace'
import { JobPermanent, JobRetryable } from '@spaces/sdk'
import type { DomainEventName, JobError } from '@spaces/sdk'
import { nextUtcMidnight } from '../../ai/caps'
import { EnrichmentCollector } from '../../enrichment/collector'
import type { Collector } from '../../enrichment/collector'
import { wantedKeys } from '../../enrichment/plan'
import {
  PICTURE_KEYS,
  pictureAnswerOf,
  withPictureKey,
} from '../../enrichment/picture'
import type { SourceAnswer } from '../../enrichment/plan'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  withBuiltIn,
} from '../../enrichment/settings'
import { isCapRefusal } from '@spaces/core/plugins/credit'
import { EnrichmentSources } from '../../enrichment/sources'
import type { AskResult } from '../../enrichment/sources'
import { WEBSITE_SENSITIVE } from '../../enrichment/website'
import type { WebsiteReader } from '../../enrichment/website'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import { EntityNotFound } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import { subjectSensitivity } from '../ports/ai'
import type { ModelCall } from '../ports/ai'
import { applyRun, holdingsOf, linksForEntity } from './apply'
import { sendRun } from './auto'
import type { RunApplied, RunSource } from './apply'
import { fetchPicture } from './picture'
import { askWebsite, websiteFor } from './website'

/**
 * `enrichment.run(entityId, reason)`: the owner's sources asked in
 * order, each for the linked keys still wanted after the ones before it,
 * and every answer applied at once by `applyRun`.
 * - A plugin source is asked through `EnrichmentSources`, the built-in
 *   Website by `askWebsite`; either's answers land in this run's
 *   `EnrichmentCollector`, not on the record.
 * - A source that fails or is declined is recorded in the receipt and the
 *   run goes on to the next.
 * - A sensitive record asks no outside source: each is skipped, and the
 *   timeline line says "sensitive".
 * - Nothing asked — no source, nothing wanted — writes nothing at all,
 *   unless a skip carries a timeline line (an outside source on a sensitive
 *   record).
 * - A record with no picture that no person held is asked for one too; the
 *   first answer is fetched and stored before `applyRun` sets it.
 * - An auto or bulk run whose source refused at its daily cap re-queues
 *   for that source at the next 00:00 UTC: parked, never dropped.
 */

/** Parked: the run queued again for the capped sources, after the reset. */
export type Parked = {
  readonly parked: { readonly by: string; readonly startAfter: string } | null
}

export type RunOutcome =
  | ({ readonly ran: false; readonly reason: string } & Parked)
  | ({ readonly ran: true } & Omit<RunApplied, 'reembed'> & Parked)

/** Which sources a run asks and why it was queued. */
export type RunOptions = {
  /** Ask only these sources; absent asks all. */
  readonly only?: ReadonlyArray<string>
  /** The domain event that queued an auto run. */
  readonly trigger?: DomainEventName
  /** Queued from a list's Enrich…; parks at a cap like an auto run. */
  readonly bulk?: true
}

const reasonOf = (error: JobError) => `${error._tag}: ${error.reason}`

/** An outside source's skip on a sensitive record, named on the timeline line. */
const OUTSIDE_SENSITIVE: AskResult = {
  asked: false,
  reason: 'a sensitive record reaches only local sources',
  line: WEBSITE_SENSITIVE,
}

const retryable = (what: string) => (cause: unknown) =>
  cause instanceof EntityNotFound
    ? new JobPermanent({ reason: `${what}: ${cause.message}` })
    : new JobRetryable({
        reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

const read = <T>(what: string, run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: retryable(what) })

/**
 * The runnable integrations with an enrich action for `kind`, and the
 * Website when it serves this record, in the owner's order.
 */
const sourcesFor = (kind: 'company' | 'person', entityId: string) =>
  Effect.gen(function* () {
    const website = yield* websiteFor(kind, entityId)
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
    const builtIn =
      website === null ? null : { id: website.row.id, manifest: null }
    return {
      settings,
      website,
      sources: withBuiltIn(settings, builtIn, runnable),
    }
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

/** Re-queue an auto or bulk run for the sources its daily cap refused. */
const park = Effect.fn('enrichment.park')(function* (
  entityId: string,
  reason: string,
  carried: Pick<RunOptions, 'trigger' | 'bulk'>,
  capped: ReadonlyArray<string>,
) {
  const by = capped.at(0)
  if (by === undefined) return null
  const startAfter = nextUtcMidnight(new Date(yield* Clock.currentTimeMillis))
  yield* sendRun(
    {
      entityId,
      reason,
      sources: [...capped],
      ...(carried.trigger === undefined ? {} : { trigger: carried.trigger }),
      ...(carried.bulk === undefined ? {} : { bulk: carried.bulk }),
      parkedBy: by,
    },
    startAfter,
  )
  return { by, startAfter: startAfter.toISOString() }
})

export const runEnrichment = Effect.fn('runEnrichment')(function* (
  requested: string,
  reason: string,
  options: RunOptions = {},
): Effect.fn.Return<
  RunOutcome,
  JobError,
  EnrichmentSources | Enqueue | WebsiteReader | ModelCall
> {
  const entityId = yield* read('enrichment.run', () => canonicalId(requested))
  const record = yield* read('enrichment.run', async () =>
    (
      await db
        .select({
          values: entity.values,
          pictureSha: entity.pictureSha,
          pictureHeld: entity.pictureHeld,
          now: sql<Date>`now()`,
        })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0),
  )
  if (record === undefined)
    return yield* new JobPermanent({ reason: `no record ${entityId}` })
  const { links, kind } = yield* read('enrichment.run', () =>
    linksForEntity(entityId),
  )
  if (kind === null)
    return { ran: false, reason: 'not a company or a person', parked: null }
  const holdings = yield* read('enrichment.run', () =>
    holdingsOf(db, entityId, record.values, links),
  )
  const started = new Date(record.now)
  const pictureKey =
    record.pictureSha === null && !record.pictureHeld
      ? PICTURE_KEYS[kind]
      : null
  const {
    settings,
    website,
    sources: ordered,
  } = yield* sourcesFor(kind, entityId)
  const only = options.only
  const sources =
    only === undefined ? ordered : ordered.filter((s) => only.includes(s.id))
  const asker = yield* EnrichmentSources
  // A sensitive record never reaches an outside source: only the Website
  // runs, its model half through a local route.
  const sensitive =
    website?.sensitivity.sensitivity === 'sensitive' ||
    (website === null &&
      (yield* subjectSensitivity(entityId)).sensitivity === 'sensitive')

  const ran: Array<RunSource> = []
  const answers: Array<SourceAnswer> = []
  const answered = new Set<string>()
  for (const source of sources) {
    const keys = withPictureKey(
      wantedKeys(links, holdings, answered),
      pictureKey,
      answered,
    )
    if (keys.length === 0) break
    const collector: Collector = {
      integrationId: source.id,
      entityId,
      answers: [],
    }
    const input = { entityId, kind, keys, reuseDays: settings.reuseDays }
    const builtIn = website !== null && source.id === website.row.id
    const result = yield* (
      builtIn
        ? askWebsite(website, input)
        : sensitive
          ? Effect.succeed<AskResult>(OUTSIDE_SENSITIVE)
          : asker.ask(source.id, input)
    ).pipe(
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
        ...(result.line === undefined ? {} : { line: result.line }),
      })
      continue
    }
    ran.push({
      integrationId: source.id,
      asked: keys,
      credits,
      ...(result.asked && result.name !== undefined
        ? { name: result.name }
        : {}),
      ...(result.asked && result.notes !== undefined
        ? { notes: result.notes }
        : {}),
    })
    for (const answer of collector.answers) {
      answers.push({ integrationId: source.id, ...answer })
      for (const key of Object.keys(answer.answers)) answered.add(key)
    }
  }
  const capped = ran.flatMap((s) =>
    s.skipped !== undefined && isCapRefusal(s.skipped) ? [s.integrationId] : [],
  )
  const parked =
    options.trigger === undefined && options.bulk === undefined
      ? null
      : yield* park(entityId, reason, options, capped)
  if (!ran.some((s) => s.skipped === undefined || s.line !== undefined))
    return {
      ran: false,
      reason:
        ran.length === 0
          ? 'no source to ask'
          : ran.map((s) => s.skipped).join('; '),
      parked,
    }

  const pictureAnswer =
    pictureKey === null ? null : pictureAnswerOf(pictureKey, answers)
  const picture =
    pictureAnswer === null ? null : yield* fetchPicture(pictureAnswer)

  const applied = yield* Effect.tryPromise({
    try: () => applyRun({ entityId, reason, sources: ran, answers, picture }),
    catch: retryable('enrichment.run'),
  })
  yield* enqueueEmbeds(applied.reembed)
  return {
    ran: true,
    fields: applied.fields,
    credits: applied.credits,
    suggestionId: applied.suggestionId,
    receiptId: applied.receiptId,
    picture: applied.picture,
    parked,
  }
})
