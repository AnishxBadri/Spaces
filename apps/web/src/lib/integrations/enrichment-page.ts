import { Clock, Effect, Schema } from 'effect'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  attribute,
  enrichmentRecord,
  entity,
  integration,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { workspace } from '@spaces/db/schema/workspace'
import { manifestSchema } from '@spaces/sdk'
import type { Manifest } from '@spaces/sdk'
import { utcDayStart } from '@spaces/core/ai/caps'
import { DEFAULT_REUSE_DAYS } from '@spaces/core/enrichment/auto'
import { keyWord, linkableKeys } from '@spaces/core/enrichment/link'
import { answersOf, fillsWhat } from '@spaces/core/enrichment/page'
import type { GridCell, GridSource } from '@spaces/core/enrichment/page'
import {
  enrichActionFor,
  enrichmentSettingsOf,
  scopeFor,
  withEnrichment,
} from '@spaces/core/enrichment/settings'
import type { EnrichmentPatch } from '@spaces/core/enrichment/settings'
import { WEBSITE_KEYS, WEBSITE_NAME } from '@spaces/core/enrichment/website'
import { DEFAULT_SCOPES } from '@spaces/core/plugins/auto-enrich'
import type {
  AutoEnrichScope,
  AutoEnrichScopeName,
} from '@spaces/core/plugins/auto-enrich'
import type {
  AttributeOptions,
  AttributeType,
} from '@spaces/core/attributes/registry'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { objectIdForKindAsync } from '@spaces/core/writes/attributes/objects'
import { enrichmentRow } from '@spaces/core/writes/enrichment/apply'
import { sendsOf } from './catalogue'
import { integrationLedgerProgram, spaceOptions } from './ledger'
import type { IntegrationRow, SpaceOption } from './ledger'

/**
 * Settings → Integrations → Enrichment: the sources in the
 * owner's order, auto-enrich, What fills what and the recent runs, and
 * the writes into `workspace.settings.enrichment`.
 * - The stored order is also which sources are on: a source left out of
 *   it is never asked. With no order stored, every runnable source is.
 * - The Website is always asked, first unless the order places it.
 * - Auto-enrich here is the paid sources' one scope, written for each;
 *   the Website keeps its own (every new record).
 */

export class EnrichmentPageFailed extends Schema.TaggedError<EnrichmentPageFailed>()(
  'EnrichmentPageFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class EnrichmentRefused extends Schema.TaggedError<EnrichmentRefused>()(
  'EnrichmentRefused',
  { message: Schema.String },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new EnrichmentPageFailed({
        message: 'Could not read the enrichment settings',
        cause,
      }),
  })

type Kind = 'company' | 'person'

/** One source as the page lists it. */
export type EnrichmentSource = {
  readonly id: string
  readonly name: string
  /** The Website, which needs no key and is always asked. */
  readonly builtIn: boolean
  /** `domain · email · LinkedIn URL`, or `nothing out · free`. */
  readonly sends: string
  /** In the stored order: asked when runnable. */
  readonly on: boolean
  /** Asked when on: enabled and loaded; the Website always. */
  readonly runnable: boolean
  /** `every new record`, `3 / 100 credits today`, `off`. */
  readonly state: string
  /** The plugin's own page; null for the Website. */
  readonly integrationId: string | null
}

/** An attribute as the grid and the Fill from window read it. */
export type GridAttribute = {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly type: AttributeType
  readonly options: AttributeOptions
  readonly filterable: boolean
  readonly isSystem: boolean
  /** The linked vocabulary key; null when not linked. */
  readonly key: string | null
  /** The key in words: `founded year`. */
  readonly keyWord: string | null
  readonly cells: ReadonlyArray<GridCell>
  readonly filledBy: string | null
}

export type FillsWhat = {
  readonly kind: Kind
  readonly label: string
  /** The sources the grid's columns name, in order. */
  readonly sources: ReadonlyArray<{
    readonly id: string
    readonly name: string
  }>
  readonly rows: ReadonlyArray<GridAttribute>
}

export type RecentRun = {
  readonly id: string
  /** ISO instant. */
  readonly at: string
  readonly recordId: string
  readonly recordKind: string
  readonly recordName: string
  /** `pressed`, `joined a deal`, `got a domain or email`… */
  readonly why: string
  readonly line: string
  readonly credits: number
}

export type AutoEnrichView = {
  readonly scopes: ReadonlyArray<AutoEnrichScopeName>
  readonly spaces: ReadonlyArray<string>
  readonly options: ReadonlyArray<SpaceOption>
  /** The paid sources the scope is written for; empty draws no checkboxes. */
  readonly paid: ReadonlyArray<string>
}

export type EnrichmentPage = {
  readonly readouts: {
    readonly fieldsWeek: number
    readonly creditsToday: number
    readonly review: number
  }
  readonly sources: ReadonlyArray<EnrichmentSource>
  readonly auto: AutoEnrichView
  /** Days a source's answer is reused; `stored` false when it is the default. */
  readonly reuse: { readonly days: number; readonly stored: boolean }
  readonly grids: ReadonlyArray<FillsWhat>
  readonly runs: ReadonlyArray<RecentRun>
}

export const RECENT_RUNS = 10
const DAY_MS = 24 * 60 * 60 * 1000

const readSettings = query(async () => {
  const row = (
    await db.select({ settings: workspace.settings }).from(workspace).limit(1)
  ).at(0)
  return row?.settings ?? {}
})

const manifestOf = (stored: unknown): Manifest | null => {
  const parsed = manifestSchema.safeParse(stored)
  return parsed.success ? parsed.data : null
}

/** A plugin row that answers Enrich on some kind. */
type PluginSource = {
  readonly row: IntegrationRow
  readonly manifest: Manifest
  readonly config: { readonly [key: string]: unknown }
}

const pluginSources = Effect.gen(function* () {
  const ledger = yield* integrationLedgerProgram().pipe(
    Effect.mapError(
      (cause) =>
        new EnrichmentPageFailed({
          message: 'Could not read the plugins',
          cause,
        }),
    ),
  )
  const ids = ledger.map((r) => r.id)
  if (ids.length === 0) return []
  const rows = yield* query(() =>
    db
      .select({
        id: integration.id,
        manifest: integration.manifest,
        config: integration.config,
        createdAt: integration.createdAt,
      })
      .from(integration)
      .where(inArray(integration.id, ids))
      .orderBy(asc(integration.createdAt)),
  )
  return rows.flatMap((r): Array<PluginSource> => {
    const manifest = manifestOf(r.manifest)
    const row = ledger.find((l) => l.id === r.id)
    if (manifest === null || row === undefined) return []
    const enriches =
      enrichActionFor(manifest, 'company') !== null ||
      enrichActionFor(manifest, 'person') !== null
    return enriches ? [{ row, manifest, config: r.config }] : []
  })
})

const runnableRow = (row: IntegrationRow) => row.state === 'enabled'

const PLUGIN_STATE: {
  readonly [S in Exclude<IntegrationRow['state'], 'enabled'>]: string
} = {
  off: 'plugin disabled',
  starting: 'starting',
  'needs-key': 'needs a key',
  'needs-setup': 'needs setup',
  degraded: 'could not load',
  tripped: 'stopped by the breaker',
}

const stateOfPlugin = (row: IntegrationRow, on: boolean): string => {
  if (row.state !== 'enabled') return PLUGIN_STATE[row.state]
  if (!on) return 'off'
  return row.credits.cap === null
    ? `${row.credits.used} credits today`
    : `${row.credits.used} / ${row.credits.cap} credits today`
}

/** The page's sources, in the order the run asks them, off sources last. */
const sourcesProgram = Effect.fn('enrichment.sources')(function* () {
  const stored = yield* readSettings
  const settings = enrichmentSettingsOf(stored)
  const website = yield* query(enrichmentRow)
  const plugins = yield* pluginSources
  const order = settings.sources
  const listed = (id: string) => order === null || order.includes(id)
  const web: EnrichmentSource = {
    id: website.id,
    name: WEBSITE_NAME,
    builtIn: true,
    sends: 'nothing out · free',
    on: true,
    runnable: true,
    state: 'every new record',
    integrationId: null,
  }
  const rows = plugins.map((p): EnrichmentSource => ({
    id: p.row.id,
    name: p.row.name,
    builtIn: false,
    sends: sendsOf(p.manifest).join(' · '),
    on: listed(p.row.id),
    runnable: runnableRow(p.row),
    state: stateOfPlugin(p.row, listed(p.row.id)),
    integrationId: p.row.id,
  }))
  const position = (id: string) => order?.indexOf(id) ?? -1
  const onRows =
    order === null
      ? [web, ...rows]
      : [
          ...(order.includes(web.id) ? [] : [web]),
          ...[web, ...rows]
            .filter((s) => order.includes(s.id))
            .sort((a, b) => position(a.id) - position(b.id)),
        ]
  const offRows = rows.filter((s) => !s.on)
  return { stored, settings, plugins, sources: [...onRows, ...offRows] }
})

/** What each source answers for a kind: the Website's keys, a plugin's declared ones. */
const gridSources = (
  sources: ReadonlyArray<EnrichmentSource>,
  plugins: ReadonlyArray<PluginSource>,
  kind: Kind,
): Array<GridSource> =>
  sources.flatMap((s): Array<GridSource> => {
    const answers = s.builtIn
      ? new Set<string>(kind === 'company' ? WEBSITE_KEYS : [])
      : answersOf(plugins.find((p) => p.row.id === s.id)?.manifest, kind)
    if (answers.size === 0) return []
    return [{ id: s.id, name: s.name, on: s.on && s.runnable, answers }]
  })

const GRID_LABEL: { readonly [K in Kind]: string } = {
  company: 'Companies',
  person: 'People',
}

/** One object's grid: each attribute that can link a key, linked ones first. */
const gridProgram = Effect.fn('enrichment.grid')(function* (
  kind: Kind,
  sources: ReadonlyArray<GridSource>,
) {
  const objectId = yield* query(() => objectIdForKindAsync(kind))
  const attrs = yield* query(() =>
    db
      .select({
        id: attribute.id,
        slug: attribute.slug,
        name: attribute.name,
        description: attribute.description,
        type: attribute.type,
        options: attribute.options,
        filterable: attribute.filterable,
        isSystem: attribute.isSystem,
      })
      .from(attribute)
      .where(
        and(eq(attribute.objectId, objectId), eq(attribute.archived, false)),
      )
      .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt)),
  )
  const candidates = attrs.flatMap((a) => {
    const key = a.options.enrichmentKey ?? null
    const linkable =
      linkableKeys(a.type, kind, a.options.targetKind ?? null).length > 0
    if (key === null && !linkable) return []
    return [{ ...a, key, keyWord: key === null ? null : keyWord(key) }]
  })
  const ordered = [
    ...candidates.filter((a) => a.key !== null),
    ...candidates.filter((a) => a.key === null),
  ]
  return {
    kind,
    label: GRID_LABEL[kind],
    sources: sources.map((s) => ({ id: s.id, name: s.name })),
    rows: fillsWhat(ordered, sources),
  } satisfies FillsWhat
})

/** `Auto-enrich · deal.linked` → `joined a deal`. */
export const whyOf = (reason: string | null): string => {
  if (reason === null) return 'ran'
  if (reason === 'Enrich pressed') return 'pressed'
  const trigger = reason.split(' · ').at(1)
  switch (trigger) {
    case 'deal.linked':
      return 'joined a deal'
    case 'filed':
      return 'filed in a space'
    case 'entity.created':
      return 'was created'
    case 'identity.added':
      return 'got a domain or email'
    case 'interaction.logged':
      return 'was in a meeting'
    default:
      return reason
  }
}

const runsProgram = Effect.fn('enrichment.runs')(function* () {
  const rows = yield* query(() =>
    db
      .select({
        id: activity.id,
        at: activity.at,
        meta: activity.meta,
        recordId: entity.id,
        recordKind: entity.kind,
        recordName: entity.canonicalName,
      })
      .from(activity)
      .innerJoin(entity, eq(entity.id, activity.subjectEntityId))
      .where(eq(activity.verb, 'entity.enriched'))
      .orderBy(desc(activity.at))
      .limit(RECENT_RUNS),
  )
  const receiptIds = rows.flatMap((r) => {
    const id = jsonString(r.meta['receiptId'])
    return id === null ? [] : [id]
  })
  const receipts =
    receiptIds.length === 0
      ? []
      : yield* query(() =>
          db
            .select({ id: enrichmentRecord.id, raw: enrichmentRecord.raw })
            .from(enrichmentRecord)
            .where(inArray(enrichmentRecord.id, receiptIds)),
        )
  return rows.map((r): RecentRun => {
    const receiptId = jsonString(r.meta['receiptId'])
    const raw = receipts.find((x) => x.id === receiptId)?.raw ?? null
    const credits = r.meta['credits']
    return {
      id: r.id,
      at: r.at.toISOString(),
      recordId: r.recordId,
      recordKind: r.recordKind,
      recordName: r.recordName,
      why: whyOf(jsonString(jsonRecord(raw)['reason'])),
      line: jsonString(r.meta['line']) ?? '',
      credits: typeof credits === 'number' ? credits : 0,
    }
  })
})

const readoutsProgram = Effect.fn('enrichment.readouts')(function* (
  sourceIds: ReadonlyArray<string>,
) {
  const now = new Date(yield* Clock.currentTimeMillis)
  const week = new Date(now.getTime() - 7 * DAY_MS)
  const fields = yield* query(
    async () =>
      (
        await db
          .select({
            n: sql`coalesce(sum((${activity.meta} ->> 'fields')::int), 0)`.mapWith(
              Number,
            ),
          })
          .from(activity)
          .where(
            and(eq(activity.verb, 'entity.enriched'), gte(activity.at, week)),
          )
      ).at(0)?.n ?? 0,
  )
  const credits = yield* query(
    async () =>
      (
        await db
          .select({
            n: sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
              Number,
            ),
          })
          .from(enrichmentRecord)
          .where(gte(enrichmentRecord.fetchedAt, utcDayStart(now)))
      ).at(0)?.n ?? 0,
  )
  const review =
    sourceIds.length === 0
      ? 0
      : yield* query(
          async () =>
            (
              await db
                .select({ n: sql`count(*)`.mapWith(Number) })
                .from(suggestion)
                .where(
                  and(
                    eq(suggestion.status, 'open'),
                    eq(suggestion.kind, 'attribute_patch'),
                    eq(suggestion.proposedByType, 'integration'),
                    inArray(suggestion.proposedById, [...sourceIds]),
                  ),
                )
            ).at(0)?.n ?? 0,
        )
  return { fieldsWeek: fields, creditsToday: credits, review }
})

export const enrichmentPageProgram = Effect.fn('enrichmentPageProgram')(
  function* (): Effect.fn.Return<EnrichmentPage, EnrichmentPageFailed> {
    const { settings, plugins, sources } = yield* sourcesProgram()
    const first = plugins.at(0)
    const scope: AutoEnrichScope =
      first === undefined
        ? { scopes: DEFAULT_SCOPES, spaces: [] }
        : scopeFor(settings, first.row.id, first.config)
    const grids: Array<FillsWhat> = []
    for (const kind of ['company', 'person'] as const)
      grids.push(yield* gridProgram(kind, gridSources(sources, plugins, kind)))
    return {
      readouts: yield* readoutsProgram(plugins.map((p) => p.row.id)),
      sources,
      auto: {
        scopes: scope.scopes,
        spaces: scope.spaces,
        options: yield* spaceOptions.pipe(
          Effect.mapError(
            (cause) =>
              new EnrichmentPageFailed({
                message: 'Could not read the spaces',
                cause,
              }),
          ),
        ),
        paid: plugins.map((p) => p.row.name),
      },
      reuse: {
        days: settings.reuseDays ?? DEFAULT_REUSE_DAYS,
        stored: settings.reuseDays !== null,
      },
      grids,
      runs: yield* runsProgram(),
    }
  },
)

/** Write `patch` into `workspace.settings.enrichment`, under the row lock. */
const writeSettings = Effect.fn('enrichment.writeSettings')(function* (
  patch: EnrichmentPatch,
) {
  const written = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        const row = (
          await tx
            .select({ settings: workspace.settings })
            .from(workspace)
            .where(eq(workspace.id, 1))
            .for('update')
        ).at(0)
        if (row === undefined) return false
        await tx
          .update(workspace)
          .set({
            settings: withEnrichment(row.settings, patch),
            updatedAt: new Date(),
          })
          .where(eq(workspace.id, 1))
        return true
      }),
    catch: (cause) =>
      new EnrichmentPageFailed({
        message: 'Could not save the enrichment settings',
        cause,
      }),
  })
  if (!written)
    return yield* new EnrichmentRefused({
      message: 'The workspace is not set up yet',
    })
})

/**
 * The sources on, in the order they are asked. An id that is neither the
 * Website nor an installed source is refused; the Website is always kept.
 */
export const saveSourceOrderProgram = Effect.fn('saveSourceOrderProgram')(
  function* (
    ids: ReadonlyArray<string>,
  ): Effect.fn.Return<void, EnrichmentPageFailed | EnrichmentRefused> {
    const website = yield* query(enrichmentRow)
    const plugins = yield* pluginSources
    const known = new Set([website.id, ...plugins.map((p) => p.row.id)])
    const unknown = ids.find((id) => !known.has(id))
    if (unknown !== undefined)
      return yield* new EnrichmentRefused({
        message: 'That source is not installed',
      })
    const order = [...new Set(ids)]
    yield* writeSettings({
      sources: order.includes(website.id) ? order : [website.id, ...order],
    })
  },
)

/** The paid sources' auto-enrich scope, written for every one of them. */
export const saveAutoEnrichProgram = Effect.fn('saveAutoEnrichProgram')(
  function* (
    scope: AutoEnrichScope,
  ): Effect.fn.Return<void, EnrichmentPageFailed | EnrichmentRefused> {
    const plugins = yield* pluginSources
    if (plugins.length === 0)
      return yield* new EnrichmentRefused({
        message: 'No enrichment source is installed to auto-enrich with',
      })
    yield* writeSettings({
      scope: { ids: plugins.map((p) => p.row.id), scope },
    })
  },
)

/** How many days a source's answer is reused before it is asked again. */
export const saveReuseDaysProgram = Effect.fn('saveReuseDaysProgram')(
  function* (
    days: number,
  ): Effect.fn.Return<void, EnrichmentPageFailed | EnrichmentRefused> {
    yield* writeSettings({ reuseDays: days })
  },
)
