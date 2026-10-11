import { Clock, Effect, Schema } from 'effect'
import {
  and,
  asc,
  avg,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  max,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord, entity, integration } from '@spaces/db/schema'
import { workspace } from '@spaces/db/schema/workspace'
import { manifestSchema } from '@spaces/sdk'
import { nextUtcMidnight, utcDayStart } from '../../ai/caps'
import { DEFAULT_REUSE_DAYS, hasLookupKey } from '../../enrichment/auto'
import {
  BULK_REASON,
  DEFAULT_CREDITS_PER_RECORD,
  estimateBulk,
} from '../../enrichment/estimate'
import type {
  BulkEstimate,
  EstimateRecord,
  EstimateSource,
} from '../../enrichment/estimate'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  withBuiltIn,
} from '../../enrichment/settings'
import { WEBSITE_NAME } from '../../enrichment/website'
import { creditDefaults, creditPolicy } from '@spaces/core/plugins/credit'
import { QUEUES } from '../../queue/names'
import { sensitivityFor } from '../ai/sensitivity-for'
import { ENRICHMENT_CAPABILITY, enrichmentRow } from './apply'
import { sendRun } from './auto'
import { spendSince } from './credits'

/**
 * Bulk Enrich from a list (D76): `bulkEstimateProgram` reads what
 * `estimateBulk` needs and spends nothing; `bulkEnrichProgram` recomputes
 * it and sends one `enrichment.run` per record asked.
 * - The send is keyed on the record, so a record already queued or parked
 *   is never doubled.
 * - A record past a source's credits left today is sent with `startAfter`
 *   at the next 00:00 UTC and `parkedBy`, the auto-enrich parking path.
 * - A paid source's rate is the mean credits of its paid receipts over
 *   `RATE_DAYS`, else `DEFAULT_CREDITS_PER_RECORD`: web never loads the
 *   plugin bundle whose `cost` hook knows it. (D53, D63)
 */

export class BulkEstimateFailed extends Schema.TaggedError<BulkEstimateFailed>()(
  'BulkEstimateFailed',
  { cause: Schema.Defect() },
) {}

const RATE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const read = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BulkEstimateFailed({ cause }),
  })

/** Credits per paid answer, from the source's recent receipts. */
const rateOf = (integrationId: string, now: Date) =>
  read(async () => {
    const row = (
      await db
        .select({ rate: avg(enrichmentRecord.creditsUsed) })
        .from(enrichmentRecord)
        .where(
          and(
            eq(enrichmentRecord.integrationId, integrationId),
            gt(enrichmentRecord.creditsUsed, 0),
            gte(
              enrichmentRecord.fetchedAt,
              new Date(now.getTime() - RATE_DAYS * DAY_MS),
            ),
          ),
        )
    ).at(0)
    const rate = Number(row?.rate ?? 0)
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CREDITS_PER_RECORD
  })

/** The records with a run queued or parked, by the send's singleton key. */
const queuedOf = (ids: ReadonlyArray<string>) =>
  read(async (): Promise<ReadonlySet<string>> => {
    if (ids.length === 0) return new Set()
    const present = await db.execute(
      sql`select to_regclass('pgboss.job') is not null as present`,
    )
    if (present.rows.at(0)?.['present'] !== true) return new Set()
    const rows = await db.execute(sql`
      select singleton_key from pgboss.job
      where name = ${QUEUES.enrichmentRun}
        and state in ('created', 'retry')
        and singleton_key in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    return new Set(
      rows.rows.flatMap((r) => {
        const key = r['singleton_key']
        return typeof key === 'string' ? [key] : []
      }),
    )
  })

type SourceRow = {
  readonly id: string
  readonly capabilityId: string
  readonly config: { readonly [key: string]: unknown }
  readonly manifest: unknown
}
/** A source in the order: a plugin row, or the Website (`row` null). */
type Ordered = { readonly id: string; readonly row: SourceRow | null }

/**
 * The sources a run over `kind` asks, in the owner's order: the Website
 * (companies only), then each runnable row with an enrich action for the
 * kind.
 */
const sourcesOf = (kind: 'company' | 'person', now: Date) =>
  Effect.gen(function* () {
    const settings = yield* read(async () =>
      enrichmentSettingsOf(
        (
          await db
            .select({ settings: workspace.settings })
            .from(workspace)
            .limit(1)
        ).at(0)?.settings ?? {},
      ),
    )
    const rows = yield* read(() =>
      db
        .select({
          id: integration.id,
          capabilityId: integration.capabilityId,
          config: integration.config,
          manifest: integration.manifest,
        })
        .from(integration)
        .where(
          and(eq(integration.enabled, true), eq(integration.status, 'enabled')),
        )
        .orderBy(asc(integration.createdAt)),
    )
    // Read, never made here: the confirm makes the row before it sends.
    const websiteRow = rows.find(
      (r) => r.capabilityId === ENRICHMENT_CAPABILITY,
    )
    const builtIn: Ordered | null =
      kind === 'company'
        ? { id: websiteRow?.id ?? ENRICHMENT_CAPABILITY, row: null }
        : null
    const plugins = rows
      .filter((r) => enrichActionFor(r.manifest, kind) !== null)
      .map((r): Ordered => ({ id: r.id, row: r }))
    const ordered = withBuiltIn(settings, builtIn, plugins)
    const sources: Array<EstimateSource> = []
    for (const { id, row } of ordered) {
      if (row === null) {
        sources.push({
          id,
          name: WEBSITE_NAME,
          local: true,
          cap: null,
          spentToday: 0,
          rate: 0,
        })
        continue
      }
      const manifest = manifestSchema.safeParse(row.manifest)
      const cap = manifest.success
        ? creditPolicy(row.config, creditDefaults(manifest.data)).dailyCreditCap
        : null
      sources.push({
        id,
        name: manifest.success ? manifest.data.name : row.capabilityId,
        local: false,
        cap,
        spentToday: yield* read(() => spendSince(id, utcDayStart(now))),
        rate: yield* rateOf(id, now),
      })
    }
    return {
      sources,
      reuseDays: settings.reuseDays ?? DEFAULT_REUSE_DAYS,
    }
  })

/** Each live record of `kind` among `ids`, in the order given, with its checks read. */
const recordsOf = (kind: 'company' | 'person', ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return []
    const rows = yield* read(() =>
      db
        .select({ id: entity.id, values: entity.values })
        .from(entity)
        .where(
          and(
            inArray(entity.id, [...ids]),
            eq(entity.kind, kind),
            isNull(entity.mergedIntoId),
          ),
        ),
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    const live = ids.flatMap((id) => {
      const row = byId.get(id)
      return row === undefined ? [] : [row]
    })
    const liveIds = live.map((r) => r.id)
    const last = yield* read(async () =>
      liveIds.length === 0
        ? []
        : db
            .select({
              id: enrichmentRecord.entityId,
              at: max(enrichmentRecord.fetchedAt),
            })
            .from(enrichmentRecord)
            .where(inArray(enrichmentRecord.entityId, liveIds))
            .groupBy(enrichmentRecord.entityId),
    )
    const lastById = new Map(last.map((r) => [r.id, r.at]))
    const queued = yield* queuedOf(liveIds)
    return yield* Effect.forEach(
      live,
      (r) =>
        sensitivityFor(r.id).pipe(
          Effect.map((s): EstimateRecord => ({
            id: r.id,
            sensitive: s.sensitivity === 'sensitive',
            lastEnrichedAt: lastById.get(r.id) ?? null,
            hasKey: hasLookupKey(kind, r.values),
            queued: queued.has(r.id),
          })),
          Effect.mapError((cause) => new BulkEstimateFailed({ cause })),
        ),
      { concurrency: 8 },
    )
  })

/** What Enrich over these records would ask, skip and spend. A read. */
export const bulkEstimateProgram = Effect.fn('bulkEstimateProgram')(function* (
  kind: 'company' | 'person',
  ids: ReadonlyArray<string>,
): Effect.fn.Return<BulkEstimate, BulkEstimateFailed> {
  const now = new Date(yield* Clock.currentTimeMillis)
  const { sources, reuseDays } = yield* sourcesOf(kind, now)
  const records = yield* recordsOf(kind, ids)
  return estimateBulk({ records, sources, reuseDays, now })
})

export type BulkEnrichOutcome = {
  /** Sent to run now. */
  readonly queued: number
  /** Sent to run after the next 00:00 UTC. */
  readonly parked: number
  /** Refused by the singleton key: a run was already waiting. */
  readonly already: number
  readonly resumesAt: string | null
}

/** Enrich n: the estimate recomputed, then one keyed send per record asked. */
export const bulkEnrichProgram = Effect.fn('bulkEnrichProgram')(function* (
  kind: 'company' | 'person',
  ids: ReadonlyArray<string>,
) {
  yield* read(() => enrichmentRow())
  const estimate = yield* bulkEstimateProgram(kind, ids)
  const now = new Date(yield* Clock.currentTimeMillis)
  const startAfter = nextUtcMidnight(now)
  let queued = 0
  let parked = 0
  let already = 0
  for (const item of estimate.plan) {
    const jobId = yield* sendRun(
      {
        entityId: item.entityId,
        reason: BULK_REASON,
        sources: [...item.sources],
        bulk: true,
        ...(item.parkedBy === null ? {} : { parkedBy: item.parkedBy }),
      },
      item.parkedBy === null ? null : startAfter,
    )
    if (jobId === null) already += 1
    else if (item.parkedBy === null) queued += 1
    else parked += 1
  }
  const out: BulkEnrichOutcome = {
    queued,
    parked,
    already,
    resumesAt: parked > 0 ? startAfter.toISOString() : null,
  }
  return out
})
