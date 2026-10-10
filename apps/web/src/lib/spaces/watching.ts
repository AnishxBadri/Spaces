import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  entitySpace,
  integration,
  jobRun,
  signal,
  space,
  spaceWatch,
} from '@spaces/db/schema'
import type { SpaceWatchSettings } from '@spaces/db/schema'
import type { Json } from '@spaces/db/json'
import { manifestSchema } from '@spaces/sdk'
import { jsonRecord, jsonString } from '@spaces/core/json'
import { checkSettings, settingsFormOf } from '#/lib/integrations/settings-form'
import type { FormValues, SettingsForm } from '#/lib/integrations/settings-form'
import { watchLabel } from './watch-status'

/**
 * The watching half of a space page (D72): its watches with their latest
 * run, the engines a watch can be added with, and What's moving on its
 * members. Outside `lib/server/` so tests call the programs directly.
 */

export class WatchingFailed extends Schema.TaggedError<WatchingFailed>()(
  'WatchingFailed',
  { cause: Schema.Defect() },
) {}

/** A refusal the Add watch window shows as it is. */
export class WatchRefused extends Schema.TaggedError<WatchRefused>()(
  'WatchRefused',
  {
    message: Schema.String,
    errors: Schema.Record(Schema.String, Schema.String),
  },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WatchingFailed({ cause }),
  })

/** A watch job's settings schema in a stored manifest; null when none. */
const watchSettingsSchema = (manifest: unknown): unknown => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return null
  const job = Object.values(parsed.data.jobs).find((j) => j.trigger === 'watch')
  return job === undefined ? null : (job.settings ?? {})
}

const nameOf = (manifest: Json, capabilityId: string): string =>
  jsonString(jsonRecord(manifest).name) ?? capabilityId

/** An integration that can carry a watch: it declares a watch job. */
export type WatchEngine = {
  integrationId: string
  name: string
  /** The watch job's settings schema as form fields — "Look for". */
  form: SettingsForm
}

/** A watch run, as the lane's status cell reads it before the stream opens. */
export type WatchRun = {
  jobRunId: string
  queue: string
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  startedAt: string
  summary: string | null
  error: string | null
}

export type WatchRow = {
  id: string
  integrationId: string
  engine: string
  label: string
  cadenceMinutes: number | null
  lastRunAt: string | null
  run: WatchRun | null
  /** Why Run now is absent — a degraded or stopped engine; null when it runs. */
  stopped: string | null
}

/** A signal on a member, as What's moving lists it. */
export type SpaceSignal = {
  id: string
  recordId: string
  recordName: string
  recordKind: string
  /** The subspace the record is filed in when not filed here directly. */
  via: { id: string; name: string } | null
  /** The integration's name, else the signal's own source text. */
  source: string
  title: string | null
  kind: string | null
  url: string | null
  refs: Array<string>
  observedAt: string
}

export type SpaceWatching = {
  watches: Array<WatchRow>
  /** Enabled engines, for the Add watch window. */
  engines: Array<WatchEngine>
  /** Installed engines' names, for the empty lane. */
  installed: Array<string>
  moving: Array<SpaceSignal>
}

/** How many signals What's moving reads; the lane folds at three. */
const MOVING_MAX = 20

/** Why an engine's watches cannot run now; null when they can. */
const stoppedReason = (row: {
  enabled: boolean
  status: 'installing' | 'enabled' | 'degraded' | 'disabled'
  lastError: string | null
  removed: boolean
  hasWatch: boolean
}): string | null => {
  if (row.removed) return 'Removed'
  if (!row.hasWatch) return 'No longer offers a watch'
  if (row.status === 'degraded') return row.lastError ?? 'Degraded'
  if (!row.enabled || row.status === 'disabled') return 'Disabled'
  if (row.status === 'installing') return 'Installing'
  return null
}

const watchEngines = Effect.fn('watchEngines')(function* () {
  const rows = yield* query(() =>
    db
      .select({
        id: integration.id,
        capabilityId: integration.capabilityId,
        manifest: integration.manifest,
        enabled: integration.enabled,
        status: integration.status,
        lastError: integration.lastError,
        removedAt: integration.removedAt,
      })
      .from(integration)
      .where(sql`${integration.capabilityId} not like 'core.%'`)
      .orderBy(asc(integration.capabilityId)),
  )
  return rows.map((r) => {
    const schema = watchSettingsSchema(r.manifest)
    return {
      id: r.id,
      name: nameOf(r.manifest, r.capabilityId),
      schema,
      enabled: r.enabled,
      removed: r.removedAt !== null,
      stopped: stoppedReason({
        enabled: r.enabled,
        status: r.status,
        lastError: r.lastError,
        removed: r.removedAt !== null,
        hasWatch: schema !== null,
      }),
    }
  })
})

/** The latest `job_run` of each watch: what the cell settles from. */
const latestRuns = Effect.fn('latestRuns')(function* (
  watchIds: ReadonlyArray<string>,
) {
  if (watchIds.length === 0) return new Map<string, WatchRun>()
  const rows = yield* query(() =>
    db
      .selectDistinctOn([jobRun.watchId], {
        watchId: jobRun.watchId,
        jobRunId: jobRun.id,
        queue: jobRun.queue,
        status: jobRun.status,
        startedAt: jobRun.startedAt,
        summary: jobRun.summary,
        error: jobRun.error,
      })
      .from(jobRun)
      .where(inArray(jobRun.watchId, [...watchIds]))
      .orderBy(jobRun.watchId, desc(jobRun.startedAt)),
  )
  return new Map(
    rows.flatMap((r) =>
      r.watchId === null
        ? []
        : [
            [
              r.watchId,
              {
                jobRunId: r.jobRunId,
                queue: r.queue,
                status: r.status,
                startedAt: r.startedAt.toISOString(),
                summary: r.summary,
                error: r.error,
              },
            ] as const,
          ],
    ),
  )
})

/**
 * Signals on records filed in the space or below it, newest first. A record
 * filed here directly reads with no via; else via its shallowest subspace.
 */
export const spaceMovingProgram = Effect.fn('spaceMovingProgram')(function* (
  spaceId: string,
): Effect.fn.Return<Array<SpaceSignal>, WatchingFailed> {
  const inSubtree = sql`exists (
    select 1 from ${entitySpace}
    join ${space} filed on filed.entity_id = ${entitySpace.spaceId}
    join ${space} here on here.entity_id = ${spaceId}
    where ${entitySpace.entityId} = ${signal.entityId}
      and here.path @> filed.path
  )`
  const rows = yield* query(() =>
    db
      .select({
        id: signal.id,
        recordId: entity.id,
        recordName: entity.canonicalName,
        recordKind: entity.kind,
        source: signal.source,
        sourceRef: signal.sourceRef,
        payload: signal.payload,
        observedAt: signal.observedAt,
      })
      .from(signal)
      .innerJoin(entity, eq(entity.id, signal.entityId))
      .where(and(isNull(entity.mergedIntoId), inSubtree))
      .orderBy(desc(signal.observedAt), desc(signal.id))
      .limit(MOVING_MAX),
  )
  if (rows.length === 0) return []

  const recordIds = [...new Set(rows.map((r) => r.recordId))]
  const filings = yield* query(() =>
    db
      .select({
        entityId: entitySpace.entityId,
        spaceId: space.entityId,
        name: entity.canonicalName,
        path: space.path,
      })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          inArray(entitySpace.entityId, recordIds),
          sql`${space.path} <@ (select path from ${space} where entity_id = ${spaceId})`,
        ),
      )
      .orderBy(asc(sql`nlevel(${space.path})`), asc(space.path)),
  )
  const via = new Map<string, { id: string; name: string } | null>()
  for (const f of filings) {
    if (via.get(f.entityId) === null) continue
    if (f.spaceId === spaceId) via.set(f.entityId, null)
    else if (!via.has(f.entityId))
      via.set(f.entityId, { id: f.spaceId, name: f.name })
  }

  const refIds = [
    ...new Set(
      rows.flatMap((r) => (r.sourceRef === null ? [] : [r.sourceRef])),
    ),
  ]
  const sources =
    refIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (yield* query(() =>
            db
              .select({
                id: integration.id,
                capabilityId: integration.capabilityId,
                manifest: integration.manifest,
              })
              .from(integration)
              .where(inArray(integration.id, refIds)),
          )).map((i) => [i.id, nameOf(i.manifest, i.capabilityId)] as const),
        )

  return rows.map((r) => {
    const p = jsonRecord(r.payload)
    const refs = Array.isArray(p.refs)
      ? p.refs.flatMap((x) => (typeof x === 'string' ? [x] : []))
      : []
    return {
      id: r.id,
      recordId: r.recordId,
      recordName: r.recordName,
      recordKind: r.recordKind,
      via: via.get(r.recordId) ?? null,
      source:
        r.sourceRef === null
          ? r.source
          : (sources.get(r.sourceRef) ?? r.source),
      title: jsonString(p.title),
      kind: jsonString(p.kind),
      url: jsonString(p.url),
      refs,
      observedAt: r.observedAt.toISOString(),
    }
  })
})

/** Everything the space page's Watching and What's moving lanes draw. */
export const spaceWatchingProgram = Effect.fn('spaceWatchingProgram')(
  function* (spaceId: string): Effect.fn.Return<SpaceWatching, WatchingFailed> {
    const [engines, watchRows, moving] = yield* Effect.all(
      [
        watchEngines(),
        query(() =>
          db
            .select({
              id: spaceWatch.id,
              integrationId: spaceWatch.integrationId,
              settings: spaceWatch.settings,
              cadenceMinutes: spaceWatch.cadenceMinutes,
              lastRunAt: spaceWatch.lastRunAt,
            })
            .from(spaceWatch)
            .where(eq(spaceWatch.spaceId, spaceId))
            .orderBy(asc(spaceWatch.createdAt), asc(spaceWatch.id)),
        ),
        spaceMovingProgram(spaceId),
      ],
      { concurrency: 'unbounded' },
    )
    const runs = yield* latestRuns(watchRows.map((w) => w.id))
    const byId = new Map(engines.map((e) => [e.id, e]))
    const watches = watchRows.map((w): WatchRow => {
      const engine = byId.get(w.integrationId)
      const name = engine?.name ?? 'Unknown engine'
      return {
        id: w.id,
        integrationId: w.integrationId,
        engine: name,
        label: watchLabel(w.settings, name),
        cadenceMinutes: w.cadenceMinutes,
        lastRunAt: w.lastRunAt?.toISOString() ?? null,
        run: runs.get(w.id) ?? null,
        stopped: engine === undefined ? 'Removed' : engine.stopped,
      }
    })
    return {
      watches,
      engines: engines.flatMap((e) =>
        e.schema !== null && e.stopped === null
          ? [
              {
                integrationId: e.id,
                name: e.name,
                form: settingsFormOf(e.schema),
              },
            ]
          : [],
      ),
      installed: engines.flatMap((e) =>
        e.schema !== null && !e.removed ? [e.name] : [],
      ),
      moving,
    }
  },
)

export type AddWatchInput = {
  spaceId: string
  integrationId: string
  values: FormValues
  cadenceMinutes: number | null
}

/** The `space_watch_lens_unique` index refusing a second identical lens. */
function sameLens(cause: unknown): boolean {
  let e: unknown = cause
  for (let depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    if (typeof e !== 'object') return false
    if (
      'code' in e &&
      e.code === '23505' &&
      'constraint' in e &&
      e.constraint === 'space_watch_lens_unique'
    )
      return true
    e = 'cause' in e ? e.cause : null
  }
  return false
}

const refuse = (message: string, errors: { [key: string]: string } = {}) =>
  new WatchRefused({ message, errors })

/**
 * Save a watch from the Add watch window: the engine must be running and
 * declare a watch; the settings pass its schema. A text setting equal to
 * the space's criteria is saved blank — the brief already carries it.
 */
export const addSpaceWatchProgram = Effect.fn('addSpaceWatchProgram')(
  function* (
    userId: string,
    input: AddWatchInput,
  ): Effect.fn.Return<{ id: string }, WatchRefused | WatchingFailed> {
    const target = (yield* query(() =>
      db
        .select({ criteria: space.criteria })
        .from(space)
        .where(eq(space.entityId, input.spaceId)),
    )).at(0)
    if (target === undefined) return yield* refuse('That space is gone')
    const engine = (yield* watchEngines()).find(
      (e) => e.id === input.integrationId,
    )
    if (engine === undefined || engine.schema === null)
      return yield* refuse('That plugin offers no watch')
    if (engine.stopped !== null)
      return yield* refuse(`${engine.name} is not running — ${engine.stopped}`)
    const form = settingsFormOf(engine.schema)
    if (!form.ok) return yield* refuse(form.reason)
    const checked = checkSettings(form.fields, input.values)
    if (!checked.ok)
      return yield* refuse('Some settings were refused', checked.errors)
    const criteria = target.criteria?.trim() ?? ''
    const settings: SpaceWatchSettings = {}
    for (const [key, value] of Object.entries(checked.values)) {
      if (value === undefined) continue
      if (
        typeof value === 'string' &&
        criteria !== '' &&
        value.trim() === criteria
      )
        continue
      settings[key] = value
    }
    const inserted = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(spaceWatch)
          .values({
            spaceId: input.spaceId,
            integrationId: input.integrationId,
            settings,
            cadenceMinutes: input.cadenceMinutes,
            createdBy: userId,
          })
          .returning({ id: spaceWatch.id }),
      catch: (cause) =>
        sameLens(cause)
          ? refuse('Already watching this')
          : new WatchingFailed({ cause }),
    })
    const row = inserted.at(0)
    if (row === undefined) return yield* refuse('The watch was not saved')
    return { id: row.id }
  },
)

/** The sentence a failed save shows. */
export function addWatchMessage(failure: unknown): string {
  return failure instanceof WatchRefused
    ? failure.message
    : 'Could not save the watch'
}
