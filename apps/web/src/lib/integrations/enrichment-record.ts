import { Effect } from 'effect'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attributeEvent,
  enrichmentRecord,
  integration,
  jobRun,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { workspace } from '@spaces/db/schema/workspace'
import type { Json } from '@spaces/db/json'
import { ENRICHMENT_VOCABULARY } from '@spaces/sdk/vocabulary'
import { whereFromOf } from '@spaces/core/enrichment/page'
import type { WhereFrom } from '@spaces/core/enrichment/page'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  withBuiltIn,
} from '@spaces/core/enrichment/settings'
import {
  WEBSITE_NAME,
  WEBSITE_SENSITIVE,
} from '@spaces/core/enrichment/website'
import { isCapRefusal } from '@spaces/core/plugins/credit'
import { QUEUES } from '@spaces/core/queue/names'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { sensitivityFor } from '@spaces/core/writes/ai/sensitivity-for'
import {
  ENRICHMENT_CAPABILITY,
  enrichmentRow,
  linksForEntity,
} from '@spaces/core/writes/enrichment/apply'
import { isLaneRoutedProgram } from '#/lib/ai/route'
import { EnrichmentPageFailed } from './enrichment-page'

/**
 * A record's enrichment, as its page shows it (D76, D80):
 * - what its Enrich will ask, in order, and how its last run went;
 * - each filled value's where-from: the source, the date and, for a
 *   changing figure, the earlier values.
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new EnrichmentPageFailed({
        message: 'Could not read the record’s enrichment',
        cause,
      }),
  })

/** How the last run went, in the words the Enrich line prints. */
export type LastRun = {
  readonly words: string
  /** `done` pine, `muted` graphite, `warn` amber, `bad` rose. */
  readonly tone: 'done' | 'muted' | 'warn' | 'bad'
  /** It left a card in Review. */
  readonly review: boolean
}

export type RecordEnrichment = {
  /** The sources Enrich asks, in order. */
  readonly sources: ReadonlyArray<string>
  /** Only free sources are on: the line offers More sources. (D80) */
  readonly onlyFree: boolean
  /** The record is sensitive: only local sources run. */
  readonly sensitive: boolean
  readonly last: LastRun | null
  /** By attribute slug. */
  readonly whereFrom: { readonly [slug: string]: WhereFrom }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Display names of the integrations that wrote values or answered. */
const namesOf = Effect.fn('enrichment.names')(function* (
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return new Map<string, string>()
  const rows = yield* query(() =>
    db
      .select({
        id: integration.id,
        capabilityId: integration.capabilityId,
        manifest: integration.manifest,
      })
      .from(integration)
      .where(inArray(integration.id, [...ids])),
  )
  return new Map(
    rows.map((r) => [
      r.id,
      r.capabilityId === ENRICHMENT_CAPABILITY
        ? WEBSITE_NAME
        : (jsonString(jsonRecord(r.manifest)['name']) ?? r.capabilityId),
    ]),
  )
})

/** Each slug an integration last wrote: its source, date and earlier figures. */
export const whereFromProgram = Effect.fn('whereFromProgram')(function* (
  entityId: string,
) {
  const events = yield* query(() =>
    db
      .select({
        slug: attributeEvent.attrSlug,
        to: attributeEvent.to,
        from: attributeEvent.from,
        at: attributeEvent.at,
        actorType: attributeEvent.actorType,
        actorRef: attributeEvent.actorRef,
      })
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, entityId))
      .orderBy(desc(attributeEvent.at)),
  )
  const { links } = yield* query(() => linksForEntity(entityId))
  const changing = new Set(
    links
      .filter((l) => ENRICHMENT_VOCABULARY[l.key].changing)
      .map((l) => l.def.slug),
  )
  const names = yield* namesOf([
    ...new Set(
      events.flatMap((e) => (e.actorRef === null ? [] : [e.actorRef])),
    ),
  ])
  const found = whereFromOf(
    events.map((e) => ({
      slug: e.slug,
      to: e.to,
      from: e.from,
      at: e.at.toISOString(),
      actorType: e.actorType,
      actorRef: e.actorRef,
    })),
    names,
    changing,
  )
  return Object.fromEntries(found)
})

/** The sources a run on this record asks, by name, in the owner's order. */
const askedProgram = Effect.fn('enrichment.asked')(function* (
  kind: 'company' | 'person',
) {
  const stored = yield* query(async () =>
    (
      await db.select({ settings: workspace.settings }).from(workspace).limit(1)
    ).at(0),
  )
  const settings = enrichmentSettingsOf(stored?.settings ?? {})
  const rows = yield* query(() =>
    db
      .select({
        id: integration.id,
        capabilityId: integration.capabilityId,
        manifest: integration.manifest,
      })
      .from(integration)
      .where(
        and(eq(integration.enabled, true), eq(integration.status, 'enabled')),
      )
      .orderBy(asc(integration.createdAt)),
  )
  const plugins = rows
    .filter((r) => enrichActionFor(r.manifest, kind) !== null)
    .map((r) => ({
      id: r.id,
      name: jsonString(jsonRecord(r.manifest)['name']) ?? r.capabilityId,
    }))
  const routed =
    kind === 'company' && (yield* isLaneRoutedProgram('extract', null)).normal
  const website = routed
    ? { id: (yield* query(enrichmentRow)).id, name: WEBSITE_NAME }
    : null
  const ordered = withBuiltIn(settings, website, plugins)
  return {
    names: ordered.map((s) => s.name),
    onlyFree: ordered.every((s) => s.id === website?.id),
  }
})

/** The skips a run's receipt recorded: each source's name and reason. */
const skipsOf = (raw: Json | undefined) => {
  const sources = jsonRecord(raw)['sources']
  return (Array.isArray(sources) ? sources : []).flatMap((s) => {
    const source = jsonRecord(s)
    const skipped = jsonString(source['skipped'])
    const name = jsonString(source['name'])
    return skipped === null || name === null ? [] : [{ name, skipped }]
  })
}

const lastRun = (
  words: string,
  tone: LastRun['tone'],
  review = false,
): LastRun => ({ words, tone, review })

/** The last run: the open `enrichment.run` row, else its line, else its summary. */
const lastRunProgram = Effect.fn('enrichment.lastRun')(function* (
  entityId: string,
): Effect.fn.Return<LastRun | null, EnrichmentPageFailed> {
  const job = (yield* query(() =>
    db
      .select({
        status: jobRun.status,
        summary: jobRun.summary,
        error: jobRun.error,
        startedAt: jobRun.startedAt,
      })
      .from(jobRun)
      .where(
        and(
          eq(jobRun.entityId, entityId),
          eq(jobRun.queue, QUEUES.enrichmentRun),
        ),
      )
      .orderBy(desc(jobRun.startedAt))
      .limit(1),
  )).at(0)
  const line = (yield* query(() =>
    db
      .select({ at: activity.at, meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, entityId),
          eq(activity.verb, 'entity.enriched'),
        ),
      )
      .orderBy(desc(activity.at))
      .limit(1),
  )).at(0)
  if (job?.status === 'running') return lastRun('running…', 'muted')
  if (job !== undefined && (line === undefined || line.at < job.startedAt)) {
    if (job.status === 'failed') return lastRun(job.error ?? 'failed', 'bad')
    const summary = job.summary ?? ''
    if (isCapRefusal(summary.replace(/^nothing asked: /, '')))
      return lastRun('limit reached · runs at 00:00 UTC', 'warn')
    if (summary.startsWith('nothing asked'))
      return lastRun('nothing blank · no credit used', 'muted')
    return null
  }
  if (line === undefined) return null
  const meta = line.meta
  const receiptId = jsonString(meta['receiptId'])
  const receipt =
    receiptId === null
      ? undefined
      : (yield* query(() =>
          db
            .select({ raw: enrichmentRecord.raw })
            .from(enrichmentRecord)
            .where(eq(enrichmentRecord.id, receiptId)),
        )).at(0)
  const skips = skipsOf(receipt?.raw)
  const capped = skips.find((s) => isCapRefusal(s.skipped))
  if (capped !== undefined)
    return lastRun(`${capped.name} limit reached · runs at 00:00 UTC`, 'warn')
  const skipped = (Array.isArray(meta['skipped']) ? meta['skipped'] : [])
    .map(jsonRecord)
    .filter((s) => jsonString(s['why']) === WEBSITE_SENSITIVE)
    .map((s) => jsonString(s['name']))
  const fields = typeof meta['fields'] === 'number' ? meta['fields'] : 0
  const credits = typeof meta['credits'] === 'number' ? meta['credits'] : 0
  const review = jsonString(meta['suggestionId']) !== null
  if (skipped.length > 0)
    return lastRun(
      `sensitive · ${skipped.includes(WEBSITE_NAME) ? 'nothing sent out' : 'Website only'}`,
      'warn',
      review,
    )
  if (fields === 0 && !review)
    return lastRun(
      `nothing blank · ${credits === 0 ? 'no credit used' : plural(credits, 'credit')}`,
      'muted',
    )
  return lastRun(
    [plural(fields, 'field'), ...(review ? ['1 to Review'] : [])].join(' · '),
    'done',
    review,
  )
})

export const recordEnrichmentProgram = Effect.fn('recordEnrichmentProgram')(
  function* (
    entityId: string,
    kind: 'company' | 'person',
  ): Effect.fn.Return<RecordEnrichment, EnrichmentPageFailed> {
    const asked = yield* askedProgram(kind)
    const sensitivity = yield* sensitivityFor(entityId).pipe(
      Effect.mapError(
        (cause) =>
          new EnrichmentPageFailed({
            message: 'Could not read the record’s sensitivity',
            cause,
          }),
      ),
    )
    return {
      sources: asked.names,
      onlyFree: asked.onlyFree,
      sensitive: sensitivity.sensitivity === 'sensitive',
      last: yield* lastRunProgram(entityId),
      whereFrom: yield* whereFromProgram(entityId),
    }
  },
)
