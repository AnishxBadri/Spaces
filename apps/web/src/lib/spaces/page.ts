import { z } from 'zod'

/**
 * The space page's pure half: its tabs, the funding-stage mix, and the
 * Companies tab's filter, sort and fold. Client-safe — nothing here reaches `db`.
 */

export const SPACE_TABS = [
  'overview',
  'companies',
  'notes',
  'files',
  'people',
  'records',
] as const
export type SpaceTab = (typeof SPACE_TABS)[number]

/** A space opens on Overview every time, as a record does. */
export const DEFAULT_SPACE_TAB: SpaceTab = 'overview'

/**
 * `?tab=` deep-links a tab; anything else reads as no tab. `?into=` is the
 * subspace a split moves companies into: the Companies tab opens selecting.
 * `?watch=` marks one watch in the Watching lane.
 */
export const spaceSearch = z.object({
  tab: z.enum(SPACE_TABS).optional().catch(undefined),
  into: z.string().uuid().optional().catch(undefined),
  /** A watch the Watching lane marks: where "Already watching this" lands. */
  watch: z.string().uuid().optional().catch(undefined),
})

/** The subspace Move here targets: the picked one, else the link's. */
export function moveTarget(
  children: ReadonlyArray<{ id: string }>,
  picked: string | null,
  linked: string | null,
): string | null {
  const ids = new Set(children.map((c) => c.id))
  if (picked !== null && ids.has(picked)) return picked
  return linked !== null && ids.has(linked) ? linked : null
}

// ---------- the funding-stage mix ----------

export type StageOption = { id: string; label: string }

/** The option that always reads last and lightest, whatever its position. */
export const BOOTSTRAPPED = 'bootstrapped'

/** Bayer levels (of 16) the darkest and lightest funded stage draw at. */
const DENSEST = 16
const SPARSEST = 4
const BOOTSTRAPPED_LEVEL = 2

export type StageSegment = {
  /** The option id; `null` is the segment of companies with no stage. */
  id: string | null
  label: string
  count: number
  /** Dither density, 0–16. Rises with stage; 0 draws no dither. */
  level: number
}

/**
 * The options in bar order: the registry's order, bootstrapped moved last.
 * - Not a stage on the funding ladder, so it never reads as the latest one.
 */
export function stageOrder(
  options: ReadonlyArray<StageOption>,
): Array<StageOption> {
  return [
    ...options.filter((o) => o.id !== BOOTSTRAPPED),
    ...options.filter((o) => o.id === BOOTSTRAPPED),
  ]
}

/** An option for a stored value: by id, or by label for imported text. */
function optionFor(
  value: string,
  options: ReadonlyArray<StageOption>,
): StageOption | undefined {
  const lower = value.toLowerCase()
  return (
    options.find((o) => o.id === value) ??
    options.find((o) => o.label.toLowerCase() === lower)
  )
}

/** A stored stage's label, or the raw value when no option names it. */
export function stageLabel(
  value: string | null,
  options: ReadonlyArray<StageOption>,
): string | null {
  if (value === null) return null
  return optionFor(value, options)?.label ?? value
}

/**
 * The bar: one segment per stage held here, in `stageOrder`, then the
 * companies whose stage is unset or unknown. Counts sum to `stages.length`.
 */
export function stageMix(
  stages: ReadonlyArray<string | null>,
  options: ReadonlyArray<StageOption>,
): Array<StageSegment> {
  const ordered = stageOrder(options)
  const funded = ordered.filter((o) => o.id !== BOOTSTRAPPED)
  const counts = new Map<string, number>()
  let unstaged = 0
  for (const value of stages) {
    const opt = value === null ? undefined : optionFor(value, options)
    if (opt) counts.set(opt.id, (counts.get(opt.id) ?? 0) + 1)
    else unstaged += 1
  }
  const levelOf = (o: StageOption): number => {
    if (o.id === BOOTSTRAPPED) return BOOTSTRAPPED_LEVEL
    const i = funded.findIndex((f) => f.id === o.id)
    if (funded.length <= 1) return DENSEST
    return Math.round(
      SPARSEST + (i * (DENSEST - SPARSEST)) / (funded.length - 1),
    )
  }
  const segments: Array<StageSegment> = ordered
    .filter((o) => (counts.get(o.id) ?? 0) > 0)
    .map((o) => ({
      id: o.id,
      label: o.label,
      count: counts.get(o.id) ?? 0,
      level: levelOf(o),
    }))
  if (unstaged > 0) {
    segments.push({ id: null, label: 'No stage', count: unstaged, level: 0 })
  }
  return segments
}

// ---------- the Companies tab ----------

export type CompanyFilter = 'all' | 'pipeline' | 'watching'
export type CompanySort = 'stage' | 'name' | 'filed'

export const COMPANY_SORTS: ReadonlyArray<{ id: CompanySort; label: string }> =
  [
    { id: 'stage', label: 'Funding stage' },
    { id: 'name', label: 'Name' },
    { id: 'filed', label: 'Recently filed' },
  ]

type CompanyRow = {
  name: string
  stage: string | null
  deals: number
  filedAt: string
}

/** Watching is a company here in no pipeline: the row's lane says so. */
export function filterCompanies<T extends CompanyRow>(
  rows: ReadonlyArray<T>,
  filter: CompanyFilter,
): Array<T> {
  if (filter === 'pipeline') return rows.filter((c) => c.deals > 0)
  if (filter === 'watching') return rows.filter((c) => c.deals === 0)
  return [...rows]
}

/**
 * Funding stage sorts in bar order — bootstrapped, then no stage, last —
 * with the name breaking ties; Recently filed is newest first.
 */
export function sortCompanies<T extends CompanyRow>(
  rows: ReadonlyArray<T>,
  sort: CompanySort,
  options: ReadonlyArray<StageOption>,
): Array<T> {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  if (sort === 'name') return [...rows].sort(byName)
  if (sort === 'filed') {
    return [...rows].sort(
      (a, b) =>
        (a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : 0) ||
        byName(a, b),
    )
  }
  const ordered = stageOrder(options)
  const rank = (c: T): number => {
    const opt = c.stage === null ? undefined : optionFor(c.stage, options)
    const i = opt ? ordered.findIndex((o) => o.id === opt.id) : -1
    return i === -1 ? ordered.length : i
  }
  return [...rows].sort((a, b) => rank(a) - rank(b) || byName(a, b))
}

/** How many company rows the Companies tab lists before its fold. */
export const COMPANY_FOLD = 10

/**
 * The fold's detail: the held-back rows counted by stage, most first, ties
 * in bar order — `Seed 3, Pre-seed 3, Bootstrapped 1`.
 */
export function foldStages(
  stages: ReadonlyArray<string | null>,
  options: ReadonlyArray<StageOption>,
): string {
  return stageMix(stages, options)
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .map((s) => `${s.label} ${String(s.count)}`)
    .join(', ')
}

// ---------- the People tab ----------

type Person = { id: string; name: string }

/** A row of the People tab, and why the person is on it. */
export type SpacePerson<TDirect, TInherited> =
  | { kind: 'filed'; person: TDirect }
  | { kind: 'company'; person: TInherited; via: string }

/**
 * The people of a space: those filed here, then those of the companies
 * filed here — one row per person, the first company naming them.
 */
export function spacePeople<
  TDirect extends Person,
  TInherited extends Person & { companyName: string },
>(
  direct: ReadonlyArray<TDirect>,
  inherited: ReadonlyArray<TInherited>,
): Array<SpacePerson<TDirect, TInherited>> {
  const seen = new Set<string>()
  const out: Array<SpacePerson<TDirect, TInherited>> = []
  for (const p of direct) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ kind: 'filed', person: p })
  }
  for (const p of inherited) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ kind: 'company', person: p, via: p.companyName })
  }
  return out
}
