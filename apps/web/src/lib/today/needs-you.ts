/**
 * Today's attention rules, pure: which deals are idle, how the Needs you
 * ledger is ordered, filtered and folded, and the head's date stamps.
 * Client-safe: the route and its components call these during render.
 */

import { formatWeekday } from '@spaces/core/format'

/** A task due today or earlier, a past meeting nobody wrote up, a deal idle
 *  past its stage median, a stale mark, a group of open Review cards. */
export const NEEDS_YOU_KINDS = [
  'task',
  'meeting',
  'deal',
  'mark',
  'review',
] as const
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number]

/** A deal with no stage change for this long is idle. */
export const IDLE_DEAL_DAYS = 21
/** A holding not marked for this long is stale. */
export const STALE_MARK_DAYS = 180
/** The ledger shows this many rows before `Show all ›`. */
export const NEEDS_YOU_FOLD = 8

/** One ledger row as the order sees it; `weight` is its size within its kind. */
export type Ranked = { kind: NeedsYouKind; key: string; weight: number }

/**
 * The urgency order: kinds in `NEEDS_YOU_KINDS` order — tasks by days
 * overdue (due today is 0), meetings by days since they happened, deals by
 * days past their stage median, marks by
 * days since the last mark, Review groups by card count — each kind's
 * largest weight first, ties by key so the order is stable.
 */
export function byUrgency<T extends Ranked>(rows: ReadonlyArray<T>): T[] {
  const tier = (k: NeedsYouKind) => NEEDS_YOU_KINDS.indexOf(k)
  return [...rows].sort(
    (a, b) =>
      tier(a.kind) - tier(b.kind) ||
      b.weight - a.weight ||
      a.key.localeCompare(b.key),
  )
}

/** A readout's filter on the ledger: the rows its figure counted. */
export const READOUT_FILTERS = ['overdue', 'pastMedian', 'oldestMark'] as const
export type ReadoutFilter = (typeof READOUT_FILTERS)[number]

/** What the ledger shows: every row, one kind, or a readout's rows. */
export type NeedsFilter = NeedsYouKind | ReadoutFilter | 'all'

/** A row a filter can test: a task carries whether it is late. */
type Filterable = Ranked & { late?: boolean }

/**
 * The rows a filter shows: every kind under `all`, else that kind alone.
 * A readout keeps the rows its figure counted — Overdue the late tasks,
 * Deals past stage median the deal rows, Oldest mark the mark rows.
 */
export function inFilter<T extends Filterable>(
  rows: ReadonlyArray<T>,
  filter: NeedsFilter,
): T[] {
  switch (filter) {
    case 'all':
      return [...rows]
    case 'overdue':
      return rows.filter((r) => r.kind === 'task' && r.late === true)
    case 'pastMedian':
      return rows.filter((r) => r.kind === 'deal')
    case 'oldestMark':
      return rows.filter((r) => r.kind === 'mark')
    default:
      return rows.filter((r) => r.kind === filter)
  }
}

/** The fold opens itself rather than hide fewer than this many rows. */
export const FOLD_MIN_HIDDEN = 3

/**
 * The rows drawn: the first `NEEDS_YOU_FOLD` unless the fold is open, or
 * unless folding would hide fewer than `FOLD_MIN_HIDDEN` — a fold that
 * saves a row or two costs more than it hides.
 */
export function folded<T>(rows: ReadonlyArray<T>, open: boolean): T[] {
  if (open || rows.length - NEEDS_YOU_FOLD < FOLD_MIN_HIDDEN) return [...rows]
  return rows.slice(0, NEEDS_YOU_FOLD)
}

export type DealDays = {
  id: string
  name: string
  stage: string
  /** Days in the current stage; null when no stage event says when. */
  days: number | null
}

/** A stage's median days, or null before any deal in it has a stage event. */
export function medianOf(
  stage: string,
  medians: Readonly<Record<string, number>>,
): number | null {
  return Object.hasOwn(medians, stage) ? medians[stage] : null
}

/** A deal's days past its stage median; null when either is unknown. */
export function daysPastMedian(
  deal: DealDays,
  medians: Readonly<Record<string, number>>,
): number | null {
  const median = medianOf(deal.stage, medians)
  if (deal.days === null || median === null) return null
  return deal.days - median
}

/**
 * The deals Needs you lists and the readout counts, one set so the two
 * agree: active-stage deals idle past `IDLE_DEAL_DAYS` and past their
 * stage median. A stage with no median yet leaves idleness alone to decide.
 */
export function dealsPastMedian<T extends DealDays>(
  deals: ReadonlyArray<T>,
  medians: Readonly<Record<string, number>>,
  active: ReadonlySet<string>,
): T[] {
  return deals.filter((d) => {
    if (!active.has(d.stage) || d.days === null || d.days <= IDLE_DEAL_DAYS)
      return false
    const past = daysPastMedian(d, medians)
    return past === null || past > 0
  })
}

/** Whole days between two ISO dates, b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) /
      86_400_000,
  )
}

/** ISO-8601 week number of an ISO date. */
export function isoWeek(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

/** The head's date: `Thu 15 Oct · W42`. */
export function todayStamp(iso: string): string {
  return `${formatWeekday(iso, iso)} · W${isoWeek(iso)}`
}

/** The folded head's date beside `Today`: `Thu 15 Oct`. */
export function todayFoldStamp(iso: string): string {
  return formatWeekday(iso, iso)
}

/** A due day as the figure lane prints it: `−2d` once passed, else `Today`. */
export function dueFigure(due: string, today: string): string {
  const n = daysBetween(today, due)
  return n < 0 ? `−${String(-n)}d` : 'Today'
}

/** The kinds in the order the head's filters and the fold name them. */
export const FILTER_ORDER: ReadonlyArray<NeedsYouKind> = [
  'task',
  'review',
  'meeting',
  'deal',
  'mark',
]

const KIND_NOUN: Record<NeedsYouKind, readonly [string, string]> = {
  task: ['task', 'tasks'],
  meeting: ['meeting', 'meetings'],
  review: ['review', 'review'],
  deal: ['deal', 'deals'],
  mark: ['mark', 'marks'],
}

/** The fold's line: `6 more · 3 tasks · 2 review · 1 deal`. */
export function foldSummary(hidden: ReadonlyArray<Ranked>): string {
  const parts = FILTER_ORDER.flatMap((k) => {
    const n = hidden.filter((r) => r.kind === k).length
    if (n === 0) return []
    return [`${n} ${KIND_NOUN[k][n === 1 ? 0 : 1]}`]
  })
  return [`${hidden.length} more`, ...parts].join(' · ')
}
