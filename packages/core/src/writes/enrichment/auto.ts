import { Clock, Effect } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { DomainEvent } from '@spaces/sdk'
import { nextUtcMidnight, utcDayStart } from '../../ai/caps'
import {
  DEFAULT_REUSE_DAYS,
  autoReason,
  hasLookupKey,
} from '../../enrichment/auto'
import type {
  AutoEnrichOutcome,
  EnrichmentRunData,
} from '../../enrichment/auto'
import { enrichActionFor, scopeFor } from '../../enrichment/settings'
import type { EnrichmentSettings } from '../../enrichment/settings'
import { inScope } from '@spaces/core/plugins/auto-enrich'
import type { AutoEnrichScope } from '@spaces/core/plugins/auto-enrich'
import { creditDefaults, creditPolicy } from '@spaces/core/plugins/credit'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { sensitivityFor } from '../ai/sensitivity-for'
import { scopeFacts } from '../events/scope-facts'
import { enrichmentRow } from './apply'
import { lastEnrichedAt, spendSince } from './credits'

/**
 * The host's auto-enrich path: a domain event queues `enrichment.run`
 * for its record only past the checks `AUTO_ENRICH_CHECKS` names, in order.
 * - The singleton send is the `queued` check: pg-boss refuses a second job
 *   keyed on the record, so it answers before `credits` even though it runs
 *   last.
 * - A source at its daily cap parks the run with `startAfter` at the next
 *   00:00 UTC; it is never dropped.
 * - Time is Effect's `Clock`, so a test moves it past midnight.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** A runnable integration row, as the dispatcher read it. */
export type SourceRow = {
  readonly id: string
  readonly config: { readonly [key: string]: unknown }
  readonly manifest: unknown
}

export type AutoEnrichContext = {
  readonly settings: EnrichmentSettings
  readonly rows: ReadonlyArray<SourceRow>
}

/** A source the run may ask: the built-in Website or a plugin row. */
type Candidate =
  | {
      readonly id: string
      readonly local: true
      readonly scope: AutoEnrichScope | null
    }
  | {
      readonly id: string
      readonly local: false
      readonly scope: AutoEnrichScope
      readonly row: SourceRow
    }

const read = <T>(run: () => Promise<T>) => Effect.tryPromise(run)

/**
 * The Website, with or without a model: it is on for every record from
 * install, so its scope is every trigger unless the owner set one.
 */
const websiteCandidate = (settings: EnrichmentSettings) =>
  read(async (): Promise<Candidate> => {
    const row = await enrichmentRow()
    return {
      id: row.id,
      local: true,
      scope: settings.scopes.get(row.id) ?? null,
    }
  })

/** A paid source at its daily cap, or null: the first in the owner's order. */
const cappedSource = (sources: ReadonlyArray<Candidate>, now: Date) =>
  Effect.gen(function* () {
    for (const source of sources) {
      if (source.local) continue
      const manifest = manifestSchema.safeParse(source.row.manifest)
      if (!manifest.success) continue
      const cap = creditPolicy(
        source.row.config,
        creditDefaults(manifest.data),
      ).dailyCreditCap
      if (cap === null) continue
      const spent = yield* read(() => spendSince(source.id, utcDayStart(now)))
      if (spent >= cap) return source.id
    }
    return null
  })

const skipped = (
  check: Extract<AutoEnrichOutcome, { outcome: 'skipped' }>['check'],
): AutoEnrichOutcome => ({ outcome: 'skipped', check })

/** Send one run keyed on its record; null when one is already queued. */
export const sendRun = (data: EnrichmentRunData, startAfter: Date | null) =>
  Effect.gen(function* () {
    const sender = yield* Enqueue
    return yield* sender.enqueue(
      QUEUES.enrichmentRun,
      data,
      startAfter === null
        ? { singletonKey: data.entityId }
        : { singletonKey: data.entityId, startAfter },
    )
  })

export const autoEnrichProgram = Effect.fn('autoEnrichProgram')(function* (
  event: DomainEvent,
  ctx: AutoEnrichContext,
) {
  if (event.kind === 'deal') return skipped('scope')
  const kind = event.kind

  // 1. In scope: some source has this trigger in its auto-enrich scope.
  const website =
    kind === 'company' ? yield* websiteCandidate(ctx.settings) : null
  const plugins: Array<Candidate> = ctx.rows
    .filter((row) => enrichActionFor(row.manifest, kind) !== null)
    .map((row) => ({
      id: row.id,
      local: false,
      scope: scopeFor(ctx.settings, row.id, row.config),
      row,
    }))
  const candidates = website === null ? plugins : [website, ...plugins]
  const scoped = candidates.flatMap((c) => (c.scope === null ? [] : [c.scope]))
  const facts = yield* scopeFacts(event, scoped)
  const inScopeSources = candidates.filter(
    (c) => c.scope === null || inScope(c.scope, event, facts),
  )
  if (inScopeSources.length === 0) return skipped('scope')

  // 2. Not sensitive, else only local sources.
  const sensitivity = yield* sensitivityFor(event.entityId)
  const sources =
    sensitivity.sensitivity === 'sensitive'
      ? inScopeSources.filter((c) => c.local)
      : inScopeSources
  if (sources.length === 0) return skipped('sensitive')

  // 3. Not enriched within reuseDays.
  const now = new Date(yield* Clock.currentTimeMillis)
  const reuseDays = ctx.settings.reuseDays ?? DEFAULT_REUSE_DAYS
  const last = yield* read(() => lastEnrichedAt(event.entityId))
  if (last !== null && now.getTime() - last.getTime() < reuseDays * DAY_MS)
    return skipped('reuse')

  // 4. A key to look it up by; else `identity.added` brings it back.
  const record = (yield* read(() =>
    db
      .select({ values: entity.values })
      .from(entity)
      .where(and(eq(entity.id, event.entityId), isNull(entity.mergedIntoId)))
      .limit(1),
  )).at(0)
  if (record === undefined || !hasLookupKey(kind, record.values))
    return skipped('key')

  // 6. Credits left today, else parked until the reset.
  const parkedBy = yield* cappedSource(sources, now)
  const ids = sources.map((s) => s.id)
  const data: EnrichmentRunData = {
    entityId: event.entityId,
    reason: autoReason(event.name),
    sources: ids,
    trigger: event.name,
    ...(parkedBy === null ? {} : { parkedBy }),
  }
  const startAfter = parkedBy === null ? null : nextUtcMidnight(now)

  // 5. Not already queued: the singleton send.
  const jobId = yield* sendRun(data, startAfter)
  if (jobId === null) return skipped('queued')
  const out: AutoEnrichOutcome =
    parkedBy === null || startAfter === null
      ? { outcome: 'queued', jobId, sources: ids }
      : { outcome: 'parked', jobId, sources: ids, parkedBy, startAfter }
  return out
})
