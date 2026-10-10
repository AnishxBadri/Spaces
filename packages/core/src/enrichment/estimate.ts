/**
 * The bulk Enrich estimate (D76, D53): what `enrichment.run` over a list
 * would ask, skip and spend, before anything is queued. Pure — the db half
 * (`bulkEstimateProgram`) reads the facts and hands them in.
 * - The checks are auto-enrich's, in its order, minus `scope` (choosing the
 *   records is the scope): `sensitive` keeps only local sources; `reuse`,
 *   `key` and `queued` are the record's.
 * - A record runs as one job asking every source that would ask it. One
 *   that does not fit a capped source's credits left today parks whole,
 *   naming that source, as an auto run does.
 */

/** Why a record is not asked, in the order the checks run. */
export const BULK_SKIPS = ['sensitive', 'reuse', 'key', 'queued'] as const
export type BulkSkip = (typeof BULK_SKIPS)[number]
export type SkipCounts = { readonly [K in BulkSkip]: number }

/** The reason a bulk run is logged with. */
export const BULK_REASON = 'Enrich from a list'

/** Credits a paid source is assumed to cost per record with no history. */
export const DEFAULT_CREDITS_PER_RECORD = 1

/** At most this many records go into one estimate. */
export const BULK_MAX = 1000

export type EstimateSource = {
  readonly id: string
  readonly name: string
  /** The built-in Website: free, and allowed on a sensitive record. */
  readonly local: boolean
  /** Null: no daily cap. */
  readonly cap: number | null
  readonly spentToday: number
  /** Credits per record asked; 0 for a local source. */
  readonly rate: number
}

export type EstimateRecord = {
  readonly id: string
  readonly sensitive: boolean
  readonly lastEnrichedAt: Date | null
  readonly hasKey: boolean
  /** A run is already queued or parked for it. */
  readonly queued: boolean
}

export type SourceEstimate = {
  readonly id: string
  readonly name: string
  readonly local: boolean
  readonly ask: number
  readonly skipped: SkipCounts
  /** About this many credits, rounded up; 0 for a local source. */
  readonly credits: number
  /** Credits left today; null with no cap. */
  readonly left: number | null
  /** Records that wait for this source's reset. */
  readonly parks: number
}

/** One job to send: the sources it asks, and the source it parks for. */
export type BulkPlanItem = {
  readonly entityId: string
  readonly sources: ReadonlyArray<string>
  readonly parkedBy: string | null
}

export type BulkEstimate = {
  /** Records considered. */
  readonly total: number
  /** Records some source would ask: what Enrich n sends. */
  readonly ask: number
  /** Of those, how many park until the reset. */
  readonly parks: number
  /** Records no source asks, each counted once under its first check. */
  readonly skipped: SkipCounts
  readonly sources: ReadonlyArray<SourceEstimate>
  readonly plan: ReadonlyArray<BulkPlanItem>
  /** The reuse window the `reuse` skips were counted against. */
  readonly reuseDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

const noSkips = (): { [K in BulkSkip]: number } => ({
  sensitive: 0,
  reuse: 0,
  key: 0,
  queued: 0,
})

/** The record's own check: reuse, key, queued — or null when it passes all three. */
const recordCheck = (
  record: EstimateRecord,
  reuseDays: number,
  now: Date,
): Exclude<BulkSkip, 'sensitive'> | null => {
  if (
    record.lastEnrichedAt !== null &&
    now.getTime() - record.lastEnrichedAt.getTime() < reuseDays * DAY_MS
  )
    return 'reuse'
  if (!record.hasKey) return 'key'
  if (record.queued) return 'queued'
  return null
}

/** Why `source` would not ask `record`, or null when it would. */
const checkFor = (
  source: EstimateSource,
  record: EstimateRecord,
  own: Exclude<BulkSkip, 'sensitive'> | null,
): BulkSkip | null => (record.sensitive && !source.local ? 'sensitive' : own)

export const estimateBulk = (input: {
  readonly records: ReadonlyArray<EstimateRecord>
  /** In the owner's order. */
  readonly sources: ReadonlyArray<EstimateSource>
  readonly reuseDays: number
  readonly now: Date
}): BulkEstimate => {
  const { records, sources, reuseDays, now } = input
  const perSource = new Map(
    sources.map((s) => [s.id, { ask: 0, skipped: noSkips(), parks: 0 }]),
  )
  const remaining = new Map<string, number>()
  for (const s of sources)
    if (!s.local && s.cap !== null)
      remaining.set(s.id, Math.max(0, s.cap - s.spentToday))
  const anyLocal = sources.some((s) => s.local)
  const skipped = noSkips()
  const plan: Array<BulkPlanItem> = []

  for (const record of records) {
    const own = recordCheck(record, reuseDays, now)
    const asking: Array<EstimateSource> = []
    for (const source of sources) {
      const check = checkFor(source, record, own)
      const tally = perSource.get(source.id)
      if (check === null) {
        asking.push(source)
        if (tally) tally.ask += 1
      } else {
        if (tally) tally.skipped[check] += 1
      }
    }
    if (asking.length === 0) {
      // With no source at all nothing is skipped either; the window says so.
      if (sources.length > 0)
        skipped[record.sensitive && !anyLocal ? 'sensitive' : (own ?? 'key')] +=
          1
      continue
    }
    const short = asking.find((s) => {
      const left = remaining.get(s.id)
      return left !== undefined && left < s.rate
    })
    if (short === undefined) {
      for (const s of asking) {
        const left = remaining.get(s.id)
        if (left !== undefined) remaining.set(s.id, left - s.rate)
      }
    } else {
      const tally = perSource.get(short.id)
      if (tally) tally.parks += 1
    }
    plan.push({
      entityId: record.id,
      sources: asking.map((s) => s.id),
      parkedBy: short?.id ?? null,
    })
  }

  return {
    total: records.length,
    ask: plan.length,
    parks: plan.filter((p) => p.parkedBy !== null).length,
    skipped,
    sources: sources.map((s) => {
      const tally = perSource.get(s.id) ?? {
        ask: 0,
        skipped: noSkips(),
        parks: 0,
      }
      return {
        id: s.id,
        name: s.name,
        local: s.local,
        ask: tally.ask,
        skipped: tally.skipped,
        credits: s.local ? 0 : Math.ceil(tally.ask * s.rate),
        left:
          s.local || s.cap === null ? null : Math.max(0, s.cap - s.spentToday),
        parks: tally.parks,
      }
    }),
    plan,
    reuseDays,
  }
}

/** A source's skips in one count. */
export const skippedTotal = (counts: SkipCounts): number =>
  BULK_SKIPS.reduce((sum, k) => sum + counts[k], 0)
