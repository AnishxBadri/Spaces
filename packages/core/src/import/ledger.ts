import { slugifyAttributeName } from '../attributes/registry'
import { fmtMoney } from '../portfolio/format'
import { coerce } from './coerce'
import { assignColumn, cellReason, columnLetter } from './mapping'
import { resolveReferenceCells } from './references'
import type { ColumnSpec, MappingProblem, Replaced } from './mapping'
import type { ReferenceColumn, ReferenceLookup } from './references'
import type {
  ColumnTarget,
  ImportAlsoCreate,
  ImportCellIssue,
  ImportDateOrder,
  ImportReference,
  LedgerDistributionEvent,
  LedgerDistributionKind,
  LedgerEvents,
  LedgerField,
  LedgerInstrument,
  LedgerInstrumentResolution,
  LedgerInvestmentEvent,
  LedgerMarkBasis,
  LedgerMarkEvent,
  LedgerNeed,
  LedgerPlan,
  LedgerRoundEvent,
  LedgerRowPlan,
  LedgerTarget,
  Mapping,
  RowPlan,
} from '@spaces/db/schema/import'

/**
 * **Ledger mapping** (SPA-170, project 14 `import-8`) — the portfolio
 * bootstrap's pure half. One row of the universal tracking sheet (company,
 * date, amount, instrument, round, current value) becomes **dated events** —
 * an optional `round`, one `investment`, an optional `mark`, an optional
 * `distribution` — and never a balance: CONTEXT.md phase 15 fixes every
 * aggregate as derived, and "as on <date>" as a filter over events.
 *
 * Three rules are pinned rather than guessed:
 *
 * 1. An instrument cell reading `SAFE` is `safe_post_money` or
 *    `safe_pre_money`, and those carry different ownership semantics — so a
 *    value with no stored resolution is the row's error, naming the value
 *    and the candidates. Only unambiguous spellings resolve by themselves.
 * 2. A mark with no date takes the batch's declared "marks as of" date; with
 *    none declared the row errors. Never today — nothing here reads a clock.
 * 3. A cap with no round data plans no round. A fabricated round would
 *    corrupt the dilution ledger for good.
 *
 * Money stays a number here, as `coerce` answers it; it becomes a string
 * only at the write boundary (SPA-171). Planning the same rows under the
 * same mapping is byte-identical: every output is a function of the cells
 * and the stored mapping.
 */
export type {
  LedgerEvents,
  LedgerField,
  LedgerInstrument,
  LedgerInstrumentResolution,
  LedgerNeed,
  LedgerPlan,
  LedgerRowPlan,
  LedgerTarget,
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const LEDGER_FIELDS: ReadonlyArray<LedgerField> = [
  'company',
  'date',
  'amount',
  'currency',
  'instrument',
  'cap',
  'discount',
  'shares',
  'vehicle',
  'roundKind',
  'roundDate',
  'raised',
  'preMoney',
  'postMoney',
  'pricePerShare',
  'sharesOutstanding',
  'markValue',
  'markDate',
  'markBasis',
  'distributionAmount',
  'distributionDate',
  'distributionKind',
]

export function isLedgerField(value: string): value is LedgerField {
  return LEDGER_FIELDS.some((f) => f === value)
}

/** How a field reads inside its line's picker. */
export const LEDGER_FIELD_LABELS: Record<LedgerField, string> = {
  company: 'Company',
  date: 'Date',
  amount: 'Amount',
  currency: 'Currency',
  instrument: 'Instrument',
  cap: 'Cap',
  discount: 'Discount',
  shares: 'Shares',
  vehicle: 'Vehicle',
  roundKind: 'Kind',
  roundDate: 'Date',
  raised: 'Raised',
  preMoney: 'Pre-money',
  postMoney: 'Post-money',
  pricePerShare: 'Price per share',
  sharesOutstanding: 'Shares outstanding',
  markValue: 'Value',
  markDate: 'Date',
  markBasis: 'Basis',
  distributionAmount: 'Amount',
  distributionDate: 'Date',
  distributionKind: 'Kind',
}

export type LedgerGroup = 'company' | 'round' | 'cheque' | 'mark' | 'proceeds'

export const LEDGER_GROUP_LABELS: Record<LedgerGroup, string> = {
  company: 'Company',
  round: 'Round',
  cheque: 'Our cheque',
  mark: 'Current mark',
  proceeds: 'Proceeds',
}

export type LedgerLine = {
  group: LedgerGroup
  label: string
  fields: ReadonlyArray<LedgerField>
}

/** The target table's rows, in order: each line is one or more fields. */
export const LEDGER_LINES: ReadonlyArray<LedgerLine> = [
  { group: 'company', label: 'Company', fields: ['company'] },
  { group: 'round', label: 'Kind · date', fields: ['roundKind', 'roundDate'] },
  {
    group: 'round',
    label: 'Raised · pre · post',
    fields: ['raised', 'preMoney', 'postMoney'],
  },
  {
    group: 'round',
    label: 'Price per share · shares out',
    fields: ['pricePerShare', 'sharesOutstanding'],
  },
  {
    group: 'cheque',
    label: 'Date · amount · currency',
    fields: ['date', 'amount', 'currency'],
  },
  { group: 'cheque', label: 'Instrument', fields: ['instrument'] },
  { group: 'cheque', label: 'Cap · discount', fields: ['cap', 'discount'] },
  { group: 'cheque', label: 'Shares · vehicle', fields: ['shares', 'vehicle'] },
  {
    group: 'mark',
    label: 'Value · date · basis',
    fields: ['markValue', 'markDate', 'markBasis'],
  },
  {
    group: 'proceeds',
    label: 'Amount · date · kind',
    fields: ['distributionAmount', 'distributionDate', 'distributionKind'],
  },
]

export const LEDGER_DATE_FIELDS: ReadonlyArray<LedgerField> = [
  'date',
  'roundDate',
  'markDate',
  'distributionDate',
]

const isDateField = (f: LedgerField) => LEDGER_DATE_FIELDS.includes(f)

/** The fields a mapping cannot advance without. */
export const LEDGER_REQUIRED: ReadonlyArray<LedgerField> = [
  'company',
  'date',
  'amount',
]

export const INSTRUMENTS: ReadonlyArray<LedgerInstrument> = [
  'priced',
  'safe_post_money',
  'safe_pre_money',
  'ccd',
]

export const INSTRUMENT_LABELS: Record<LedgerInstrument, string> = {
  priced: 'Priced',
  safe_post_money: 'Post-money SAFE',
  safe_pre_money: 'Pre-money SAFE',
  ccd: 'CCD',
}

export function isInstrument(value: string): value is LedgerInstrument {
  return INSTRUMENTS.some((i) => i === value)
}

export const MARK_BASES: ReadonlyArray<LedgerMarkBasis> = [
  'round_price',
  'manual',
  '409a',
]

export const DISTRIBUTION_KINDS: ReadonlyArray<LedgerDistributionKind> = [
  'exit',
  'secondary',
  'dividend',
  'writeoff',
]

/** The currencies the decisions panel offers for a row that names none. */
export const LEDGER_CURRENCIES: ReadonlyArray<string> = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'SGD',
  'JPY',
  'CNY',
  'AUD',
  'CAD',
  'CHF',
  'HKD',
  'AED',
  'NZD',
]

// ---------------------------------------------------------------------------
// The mapping's ledger columns
// ---------------------------------------------------------------------------

export type LedgerColumn = LedgerTarget & { column: number }

export type LedgerColumns = Partial<Record<LedgerField, LedgerColumn>>

/** Field → the column it is mapped to, with the column's target. */
export function ledgerColumnsOf(mapping: Mapping): LedgerColumns {
  const out: LedgerColumns = {}
  mapping.forEach((t, column) => {
    if (t.target === 'ledger' && out[t.field] === undefined)
      out[t.field] = { ...t, column }
  })
  return out
}

/** The decisions the plan reads, off the columns that carry them. */
export type LedgerDecisions = {
  instrumentMap: Record<string, LedgerInstrumentResolution>
  instrumentByRow: Record<string, LedgerInstrument>
  currency: string | null
  marksAsOf: string | null
}

export function ledgerDecisionsOf(columns: LedgerColumns): LedgerDecisions {
  return {
    instrumentMap: columns.instrument?.instrumentMap ?? {},
    instrumentByRow: columns.instrument?.instrumentByRow ?? {},
    currency: columns.amount?.currency ?? null,
    marksAsOf: columns.markValue?.marksAsOf ?? null,
  }
}

// ---------------------------------------------------------------------------
// The guess
// ---------------------------------------------------------------------------

/**
 * Common tracking-sheet headers, by slug, and the field each means. Matched
 * exactly on the slugified header, first column first; a field is claimed
 * once. Anything else is not mapped — never a guess.
 */
const LEDGER_ALIASES: Partial<Record<string, LedgerField>> = {
  company: 'company',
  company_name: 'company',
  startup: 'company',
  portfolio_company: 'company',
  name: 'company',
  date: 'date',
  investment_date: 'date',
  date_invested: 'date',
  invested_on: 'date',
  check_date: 'date',
  cheque_date: 'date',
  amount: 'amount',
  check: 'amount',
  cheque: 'amount',
  check_size: 'amount',
  cheque_size: 'amount',
  amount_invested: 'amount',
  investment_amount: 'amount',
  invested: 'amount',
  investment: 'amount',
  currency: 'currency',
  ccy: 'currency',
  instrument: 'instrument',
  type: 'instrument',
  instrument_type: 'instrument',
  security: 'instrument',
  round: 'roundKind',
  stage: 'roundKind',
  round_name: 'roundKind',
  series: 'roundKind',
  round_date: 'roundDate',
  raised: 'raised',
  round_size: 'raised',
  amount_raised: 'raised',
  pre_money: 'preMoney',
  pre: 'preMoney',
  pre_money_valuation: 'preMoney',
  post_money: 'postMoney',
  post: 'postMoney',
  post_money_valuation: 'postMoney',
  price_per_share: 'pricePerShare',
  pps: 'pricePerShare',
  share_price: 'pricePerShare',
  shares_outstanding: 'sharesOutstanding',
  fully_diluted_shares: 'sharesOutstanding',
  valuation_cap: 'cap',
  cap: 'cap',
  discount: 'discount',
  shares: 'shares',
  our_shares: 'shares',
  shares_held: 'shares',
  vehicle: 'vehicle',
  fund: 'vehicle',
  spv: 'vehicle',
  current_value: 'markValue',
  fmv: 'markValue',
  fair_value: 'markValue',
  fair_market_value: 'markValue',
  current_mark: 'markValue',
  mark_date: 'markDate',
  as_of: 'markDate',
  as_of_date: 'markDate',
  valuation_date: 'markDate',
  basis: 'markBasis',
  mark_basis: 'markBasis',
  proceeds: 'distributionAmount',
  distribution: 'distributionAmount',
  proceeds_date: 'distributionDate',
  distribution_date: 'distributionDate',
  exit_date: 'distributionDate',
  distribution_type: 'distributionKind',
  exit_type: 'distributionKind',
}

function ledgerTarget(field: LedgerField): LedgerTarget {
  // A company the matcher does not find is created by default in the
  // bootstrap: the toggle is on the decisions panel.
  return field === 'company'
    ? { target: 'ledger', field, createMissing: true }
    : { target: 'ledger', field }
}

/** The deterministic first guess for a ledger batch. */
export function autoMapLedger(headers: ReadonlyArray<string>): Mapping {
  const taken = new Set<LedgerField>()
  return headers.map((h): ColumnTarget => {
    const slug = /[a-z0-9]/i.test(h) ? slugifyAttributeName(h) : null
    const field = slug ? LEDGER_ALIASES[slug] : undefined
    if (!field || taken.has(field)) return { target: 'ignore' }
    taken.add(field)
    return ledgerTarget(field)
  })
}

// ---------------------------------------------------------------------------
// Changing the mapping
// ---------------------------------------------------------------------------

/** The date order every mapped date column agrees on, else null. */
export function sharedDateOrder(mapping: Mapping): ImportDateOrder | null {
  const orders = new Set<ImportDateOrder | null>()
  for (const t of mapping)
    if (t.target === 'ledger' && isDateField(t.field))
      orders.add(t.dateOrder ?? null)
  const only = [...orders]
  return only.length === 1 ? (only[0] ?? null) : null
}

/**
 * One field onto one column, or off the sheet (`column` null). A column that
 * held another field gives it up — the caller names it. A date field joins
 * the order the other date columns share; the company keeps its toggle.
 */
export function assignLedgerField(
  mapping: Mapping,
  field: LedgerField,
  column: number | null,
): { mapping: Mapping; replaced: Array<Replaced> } {
  const held = mapping.findIndex(
    (t) => t.target === 'ledger' && t.field === field,
  )
  if (column === null) {
    if (held === -1) return { mapping, replaced: [] }
    return assignColumn(mapping, held, { target: 'ignore' })
  }
  const previous = mapping.at(held)
  const order = sharedDateOrder(mapping)
  const target: LedgerTarget = { target: 'ledger', field }
  if (isDateField(field) && order !== null) target.dateOrder = order
  if (field === 'company') {
    const keep =
      previous?.target === 'ledger' ? previous.createMissing === true : true
    if (keep) target.createMissing = true
  }
  const cleared =
    held === -1 || held === column
      ? mapping
      : mapping.map((t, i): ColumnTarget =>
          i === held ? { target: 'ignore' } : t,
        )
  return assignColumn(cleared, column, target)
}

export type LedgerDecision =
  | {
      kind: 'instrument'
      /** The value's `instrumentKey`. */
      value: string
      resolution: LedgerInstrumentResolution | null
    }
  | { kind: 'rowInstrument'; rowNum: number; instrument: LedgerInstrument }
  | { kind: 'marksAsOf'; date: string | null }
  | { kind: 'currency'; code: string | null }
  | { kind: 'dateOrder'; order: ImportDateOrder }
  | { kind: 'createMissing'; on: boolean }

type Decided = { ok: true; mapping: Mapping } | { ok: false; reason: string }

function onField(
  mapping: Mapping,
  field: LedgerField,
  change: (t: LedgerTarget) => LedgerTarget,
  missing: string,
): Decided {
  const at = mapping.findIndex(
    (t) => t.target === 'ledger' && t.field === field,
  )
  const t = mapping.at(at)
  if (!t || t.target !== 'ledger') return { ok: false, reason: missing }
  return {
    ok: true,
    mapping: mapping.map((x, i) => (i === at ? change(t) : x)),
  }
}

/** A target without one of its optional keys — absent, never `undefined`. */
function without(t: LedgerTarget, key: keyof LedgerTarget): LedgerTarget {
  const out: LedgerTarget = { ...t }
  delete out[key]
  return out
}

/** A decision, written onto the column it is about. */
export function applyLedgerDecision(
  mapping: Mapping,
  decision: LedgerDecision,
): Decided {
  switch (decision.kind) {
    case 'instrument':
      return onField(
        mapping,
        'instrument',
        (t) => {
          const map = { ...(t.instrumentMap ?? {}) }
          if (decision.resolution === null) delete map[decision.value]
          else map[decision.value] = decision.resolution
          return Object.keys(map).length === 0
            ? without(t, 'instrumentMap')
            : { ...t, instrumentMap: map }
        },
        'Map the instrument column first',
      )
    case 'rowInstrument':
      return onField(
        mapping,
        'instrument',
        (t) => ({
          ...t,
          instrumentByRow: {
            ...(t.instrumentByRow ?? {}),
            [String(decision.rowNum)]: decision.instrument,
          },
        }),
        'Map the instrument column first',
      )
    case 'marksAsOf':
      if (decision.date !== null && !ISO_DATE.test(decision.date))
        return { ok: false, reason: 'Marks as of is a date — YYYY-MM-DD' }
      return onField(
        mapping,
        'markValue',
        (t) =>
          decision.date === null
            ? without(t, 'marksAsOf')
            : { ...t, marksAsOf: decision.date },
        'Map the mark value column first',
      )
    case 'currency':
      if (decision.code !== null && !/^[A-Z]{3}$/.test(decision.code))
        return { ok: false, reason: 'A currency is a three-letter code' }
      return onField(
        mapping,
        'amount',
        (t) =>
          decision.code === null
            ? without(t, 'currency')
            : { ...t, currency: decision.code },
        'Map the amount column first',
      )
    case 'dateOrder':
      return {
        ok: true,
        mapping: mapping.map((t) =>
          t.target === 'ledger' && isDateField(t.field)
            ? { ...t, dateOrder: decision.order }
            : t,
        ),
      }
    case 'createMissing':
      return onField(
        mapping,
        'company',
        (t) =>
          decision.on
            ? { ...t, createMissing: true }
            : without(t, 'createMissing'),
        'Map the company column first',
      )
  }
}

/** What stops a ledger mapping advancing: the three required fields, and any record target. */
export function validateLedgerMapping(mapping: Mapping): Array<MappingProblem> {
  const columns = ledgerColumnsOf(mapping)
  const problems: Array<MappingProblem> = []
  const need: Record<string, string> = {
    company: 'Map the company column',
    date: 'Map the date of our cheque',
    amount: 'Map the amount of our cheque',
  }
  for (const f of LEDGER_REQUIRED)
    if (columns[f] === undefined)
      problems.push({ column: null, reason: need[f] })
  mapping.forEach((t, i) => {
    if (t.target !== 'ledger' && t.target !== 'ignore')
      problems.push({
        column: i,
        reason: `Column ${columnLetter(i)} maps to a record field — a ledger column maps to an event field`,
      })
  })
  return problems
}

// ---------------------------------------------------------------------------
// Reading cells
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The form an instrument value is compared in: lowercase words, nothing else. */
export function instrumentKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Spellings that can mean only one instrument. `SAFE` is deliberately not
 * here, nor is anything carrying no pre/post word: those are decisions.
 */
const INSTRUMENT_ALIASES: Partial<Record<string, LedgerInstrument>> = {
  priced: 'priced',
  'priced round': 'priced',
  'priced equity': 'priced',
  equity: 'priced',
  preferred: 'priced',
  'preferred stock': 'priced',
  'preferred shares': 'priced',
  common: 'priced',
  'common stock': 'priced',
  'ordinary shares': 'priced',
  ccd: 'ccd',
  ccds: 'ccd',
  'compulsorily convertible debenture': 'ccd',
  'compulsorily convertible debentures': 'ccd',
  'safe post money': 'safe_post_money',
  'post money safe': 'safe_post_money',
  'safe postmoney': 'safe_post_money',
  'postmoney safe': 'safe_post_money',
  'safe pre money': 'safe_pre_money',
  'pre money safe': 'safe_pre_money',
  'safe premoney': 'safe_pre_money',
  'premoney safe': 'safe_pre_money',
}

/**
 * A value's resolution: what the mapping stored for it, else the one
 * instrument its spelling can only mean, else none.
 */
export function resolveInstrument(
  key: string,
  map: Readonly<Partial<Record<string, LedgerInstrumentResolution>>>,
): { resolution: LedgerInstrumentResolution | null; auto: boolean } {
  const stored = map[key]
  if (stored !== undefined) return { resolution: stored, auto: false }
  const alias = key === '' ? undefined : INSTRUMENT_ALIASES[key]
  return alias
    ? { resolution: alias, auto: true }
    : { resolution: null, auto: false }
}

/** The candidates an unresolved value is named with: the two SAFEs, or all four. */
export function instrumentCandidates(key: string): Array<LedgerInstrument> {
  return key.split(' ').includes('safe')
    ? ['safe_post_money', 'safe_pre_money']
    : [...INSTRUMENTS]
}

function orList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`
}

/** `"SAFE" could be safe_post_money or safe_pre_money` — the row's error. */
export function unresolvedInstrumentReason(raw: string, key: string): string {
  const shown = raw.trim() === '' ? 'A blank instrument' : `"${raw.trim()}"`
  return `${shown} could be ${orList(instrumentCandidates(key))}`
}

/**
 * The currency a money cell is written in, when its mark says so without
 * doubt: an ISO code, `€`, `£`, `₹`/`Rs`, or a prefixed dollar (`US$`,
 * `S$`, `HK$`…). A bare `$` or `¥` names several currencies and reads as
 * none — the row's currency column, or the declared default, decides.
 */
export function currencyOfMark(raw: string): string | null {
  const s = raw.trim().replace(/^[(−-]\s*/, '')
  const code = /^([A-Z]{3})\b|\b([A-Z]{3})\)?$/.exec(s.toUpperCase())
  const iso = code?.[1] ?? code?.[2] ?? null
  if (iso && LEDGER_CURRENCIES.includes(iso)) return iso
  if (/€/.test(s)) return 'EUR'
  if (/£/.test(s)) return 'GBP'
  if (/₹|^rs\.?\s*\d/i.test(s)) return 'INR'
  const dollar = /([A-Z]{1,2})\$/i.exec(s)
  if (dollar) {
    const byPrefix: Partial<Record<string, string>> = {
      US: 'USD',
      S: 'SGD',
      HK: 'HKD',
      A: 'AUD',
      AU: 'AUD',
      C: 'CAD',
      CA: 'CAD',
      NZ: 'NZD',
    }
    return byPrefix[dollar[1].toUpperCase()] ?? null
  }
  return null
}

const CURRENCY_WORDS: Partial<Record<string, string>> = {
  $: 'USD',
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  RS: 'INR',
}

/** A currency column's cell: a three-letter code or an unambiguous symbol. */
export function readCurrencyCell(
  raw: string,
): { ok: true; code: string } | { ok: false } {
  const s = raw.trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(s)) return { ok: true, code: s }
  const word = CURRENCY_WORDS[s]
  return word ? { ok: true, code: word } : { ok: false }
}

const MONEY_SPEC: ColumnSpec = { kind: 'typed', type: 'currency', options: {} }
const NUMBER_SPEC: ColumnSpec = { kind: 'typed', type: 'number', options: {} }
const DATE_SPEC: ColumnSpec = { kind: 'typed', type: 'date', options: {} }

type Read<T> =
  | { kind: 'blank' }
  | { kind: 'ok'; value: T }
  | { kind: 'bad'; reason: string; order?: true }

function readNumber(raw: string, spec: ColumnSpec): Read<number> {
  if (raw.trim() === '') return { kind: 'blank' }
  const out = coerce('currency', {}, raw)
  if (!out.ok) return { kind: 'bad', reason: cellReason(spec, out.reason) }
  if (typeof out.value !== 'number') return { kind: 'blank' }
  if (out.value < 0) return { kind: 'bad', reason: 'negative' }
  return { kind: 'ok', value: out.value }
}

function readDate(
  raw: string,
  order: ImportDateOrder | undefined,
): Read<string> {
  if (raw.trim() === '') return { kind: 'blank' }
  const out = coerce('date', order ? { dateOrder: order } : {}, raw)
  if (out.ok && typeof out.value === 'string')
    return { kind: 'ok', value: out.value }
  const reason = out.ok ? 'not a date' : out.reason
  return reason.includes('reads two ways')
    ? {
        kind: 'bad',
        reason: 'reads two ways — choose the date order',
        order: true,
      }
    : { kind: 'bad', reason: cellReason(DATE_SPEC, reason) }
}

/** `20%` → 0.2, `0.2` → 0.2, `20` → 0.2 (a discount of 1 or more is a percent). */
export function readDiscount(raw: string): Read<number> {
  const s = raw.trim()
  if (s === '') return { kind: 'blank' }
  const pct = s.endsWith('%')
  const n = readNumber(pct ? s.slice(0, -1) : s, NUMBER_SPEC)
  if (n.kind !== 'ok')
    return n.kind === 'blank' ? { kind: 'bad', reason: 'not a number' } : n
  const value = pct || n.value >= 1 ? n.value / 100 : n.value
  return value > 1
    ? { kind: 'bad', reason: 'over 100%' }
    : { kind: 'ok', value }
}

const BASIS_WORDS: Partial<Record<string, LedgerMarkBasis>> = {
  'round price': 'round_price',
  round: 'round_price',
  'last round': 'round_price',
  manual: 'manual',
  '409a': '409a',
}

const DISTRIBUTION_WORDS: Partial<Record<string, LedgerDistributionKind>> = {
  exit: 'exit',
  secondary: 'secondary',
  dividend: 'dividend',
  writeoff: 'writeoff',
  'write off': 'writeoff',
  'written off': 'writeoff',
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

export type LedgerRowRead = {
  /** Null whenever `errors` is not empty. */
  events: LedgerEvents | null
  errors: Array<ImportCellIssue>
  /** Optional cells that did not read; the row lands without them. */
  skippedCells: Array<ImportCellIssue>
  needs: Array<LedgerNeed>
}

/**
 * One tracking-sheet row → its dated events, or the reasons it has none.
 * `rowNum` is how a `per_row` instrument finds its choice. The company is
 * not read here — it is a lookup (`planLedgerBatch`).
 */
export function planLedgerRow(
  cells: ReadonlyArray<string>,
  columns: LedgerColumns,
  decisions: LedgerDecisions,
  rowNum: number,
): LedgerRowRead {
  const errors: Array<ImportCellIssue> = []
  const skippedCells: Array<ImportCellIssue> = []
  const needs = new Set<LedgerNeed>()
  const rawOf = (f: LedgerField) => {
    const c = columns[f]
    return c ? (cells.at(c.column) ?? '') : ''
  }
  const colOf = (f: LedgerField, fallback: LedgerField = f) =>
    columns[f]?.column ?? columns[fallback]?.column ?? -1
  const fail = (f: LedgerField, reason: string, need?: LedgerNeed) => {
    errors.push({ column: colOf(f, 'amount'), raw: rawOf(f), reason })
    if (need) needs.add(need)
  }
  const skip = (f: LedgerField, reason: string) =>
    skippedCells.push({ column: colOf(f), raw: rawOf(f), reason })

  /** A date field; a cell that does not read is always the row's error. */
  const date = (f: LedgerField): string | null => {
    const r = readDate(rawOf(f), columns[f]?.dateOrder)
    if (r.kind === 'ok') return r.value
    if (r.kind === 'bad') fail(f, r.reason, r.order ? 'dateOrder' : undefined)
    return null
  }
  /** An optional figure; one that does not read is skipped. */
  const figure = (
    f: LedgerField,
    spec: ColumnSpec = MONEY_SPEC,
  ): number | null => {
    const r = readNumber(rawOf(f), spec)
    if (r.kind === 'ok') return r.value
    if (r.kind === 'bad') skip(f, r.reason)
    return null
  }
  const text = (f: LedgerField, max: number): string | null => {
    const s = rawOf(f).trim()
    if (s === '') return null
    if (s.length > max) {
      skip(f, `over ${max} characters`)
      return null
    }
    return s
  }

  // --- our cheque -------------------------------------------------------
  const investedOn = date('date')
  if (!columns.date) fail('date', 'no date column')
  else if (rawOf('date').trim() === '') fail('date', 'no date')

  const amountRaw = rawOf('amount')
  let amount: number | null = null
  if (amountRaw.trim() === '') fail('amount', 'no amount')
  else {
    const r = readNumber(amountRaw, MONEY_SPEC)
    if (r.kind === 'ok') amount = r.value
    else if (r.kind === 'bad') fail('amount', r.reason)
  }

  // The row's currency: its currency cell, else the amount's own mark, else
  // the declared default. A cell and a mark that disagree are an error.
  let cellCurrency: string | null = null
  const currencyRaw = rawOf('currency')
  if (currencyRaw.trim() !== '') {
    const c = readCurrencyCell(currencyRaw)
    if (c.ok) cellCurrency = c.code
    else fail('currency', 'not a currency')
  }
  const amountMark = currencyOfMark(amountRaw)
  if (cellCurrency && amountMark && cellCurrency !== amountMark)
    fail('amount', `written in ${amountMark}, the row says ${cellCurrency}`)
  const rowCurrency = cellCurrency ?? amountMark ?? decisions.currency
  if (rowCurrency === null && amountRaw.trim() !== '')
    fail(
      'amount',
      'no currency — choose one for rows that name none',
      'currency',
    )
  const currencyFor = (f: LedgerField) =>
    currencyOfMark(rawOf(f)) ?? rowCurrency

  // Instrument: the stored resolution, else an unambiguous spelling.
  const instrumentRaw = rawOf('instrument')
  const key = instrumentKey(instrumentRaw)
  let instrument: LedgerInstrument | null = null
  if (!columns.instrument)
    fail('instrument', 'no instrument column', 'instrument')
  else {
    const { resolution } = resolveInstrument(key, decisions.instrumentMap)
    const chosen =
      resolution === 'per_row'
        ? (decisions.instrumentByRow[String(rowNum)] ?? null)
        : resolution
    if (chosen) instrument = chosen
    else
      fail(
        'instrument',
        unresolvedInstrumentReason(instrumentRaw, key),
        'instrument',
      )
  }

  const cap = figure('cap')
  let discount: number | null = null
  const d = readDiscount(rawOf('discount'))
  if (d.kind === 'ok') discount = d.value
  else if (d.kind === 'bad') skip('discount', d.reason)
  const shares = figure('shares', NUMBER_SPEC)
  const vehicle = text('vehicle', 120)

  // --- the round --------------------------------------------------------
  // Round data is the round's own cells. A cap is the cheque's term, not
  // round data, so a row with a cap and nothing else plans no round.
  const roundKind = rawOf('roundKind').trim()
  const roundOn = date('roundDate')
  const raised = figure('raised')
  const preMoney = figure('preMoney')
  const postMoney = figure('postMoney')
  const pricePerShare = figure('pricePerShare')
  const sharesOutstanding = figure('sharesOutstanding', NUMBER_SPEC)
  const figures = [
    raised,
    preMoney,
    postMoney,
    pricePerShare,
    sharesOutstanding,
  ]
  const hasRoundData =
    roundKind !== '' || roundOn !== null || figures.some((x) => x !== null)
  let round: LedgerRoundEvent | undefined
  if (hasRoundData && roundKind === '') {
    const first = ROUND_FIELDS.find(
      (f) => columns[f] !== undefined && rawOf(f).trim() !== '',
    )
    errors.push({
      column: first ? colOf(first) : colOf('roundKind'),
      raw: first ? rawOf(first) : '',
      reason: 'round figures with no round kind',
    })
  } else if (roundKind.length > 60) fail('roundKind', 'over 60 characters')
  else if (hasRoundData && investedOn !== null) {
    const moneyCurrency = [raised, preMoney, postMoney].some((x) => x !== null)
      ? ((['raised', 'preMoney', 'postMoney'] as const)
          .map((f) => currencyOfMark(rawOf(f)))
          .find((c) => c !== null) ?? rowCurrency)
      : null
    round = {
      date: roundOn ?? investedOn,
      kind: roundKind,
      raised,
      currency: moneyCurrency,
      preMoney,
      postMoney,
      pricePerShare,
      sharesOutstanding,
    }
  }

  // --- the mark ---------------------------------------------------------
  let mark: LedgerMarkEvent | undefined
  const markRaw = rawOf('markValue')
  if (markRaw.trim() !== '') {
    const value = readNumber(markRaw, MONEY_SPEC)
    if (value.kind === 'bad') skip('markValue', value.reason)
    if (value.kind === 'ok') {
      const markedOn =
        rawOf('markDate').trim() === '' ? decisions.marksAsOf : date('markDate')
      if (rawOf('markDate').trim() === '' && decisions.marksAsOf === null)
        fail('markValue', 'no mark date — declare marks as of', 'marksAsOf')
      const basisRaw = rawOf('markBasis').trim()
      const basis: LedgerMarkBasis | null =
        basisRaw === ''
          ? 'manual'
          : (BASIS_WORDS[basisRaw.toLowerCase()] ?? null)
      if (basis === null)
        fail('markBasis', `"${basisRaw}" could be ${orList(MARK_BASES)}`)
      const currency = currencyFor('markValue')
      if (markedOn !== null && basis !== null && currency !== null)
        mark = { date: markedOn, fairValue: value.value, currency, basis }
    }
  }

  // --- proceeds ---------------------------------------------------------
  let distribution: LedgerDistributionEvent | undefined
  const distRaw = rawOf('distributionAmount')
  const kindRaw = rawOf('distributionKind').trim()
  if (distRaw.trim() !== '' || kindRaw !== '') {
    const kind: LedgerDistributionKind | null =
      kindRaw === ''
        ? null
        : (DISTRIBUTION_WORDS[instrumentKey(kindRaw)] ?? null)
    if (kindRaw === '')
      fail('distributionAmount', `no kind — ${orList(DISTRIBUTION_KINDS)}`)
    else if (kind === null)
      fail(
        'distributionKind',
        `"${kindRaw}" could be ${orList(DISTRIBUTION_KINDS)}`,
      )
    let proceeds: number | null = null
    if (distRaw.trim() === '') {
      if (kind === 'writeoff') proceeds = 0
      else if (kind !== null) fail('distributionAmount', 'no amount')
    } else {
      const r = readNumber(distRaw, MONEY_SPEC)
      if (r.kind === 'ok') proceeds = r.value
      else if (r.kind === 'bad') fail('distributionAmount', r.reason)
    }
    const paidOn = date('distributionDate')
    if (rawOf('distributionDate').trim() === '')
      fail(
        columns.distributionDate ? 'distributionDate' : 'distributionAmount',
        'no proceeds date',
      )
    const currency = currencyFor('distributionAmount')
    if (
      kind !== null &&
      proceeds !== null &&
      paidOn !== null &&
      currency !== null
    )
      distribution = { date: paidOn, amount: proceeds, currency, kind }
  }

  errors.sort((a, b) => a.column - b.column)
  skippedCells.sort((a, b) => a.column - b.column)
  const needList = [...needs].sort()
  if (
    errors.length > 0 ||
    investedOn === null ||
    amount === null ||
    rowCurrency === null ||
    instrument === null
  )
    return { events: null, errors, skippedCells, needs: needList }
  const investment: LedgerInvestmentEvent = {
    date: investedOn,
    amount,
    currency: rowCurrency,
    instrument,
    shares,
    cap,
    discount,
    vehicle,
    roundRow: round ? rowNum : null,
  }
  const events: LedgerEvents = {
    ...(round ? { round } : {}),
    investment,
    ...(mark ? { mark } : {}),
    ...(distribution ? { distribution } : {}),
  }
  return { events, errors, skippedCells, needs: needList }
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/** The attribute id a ledger's company reference is filed under. */
export const LEDGER_COMPANY_REF = 'ledger:company'

export type CompanyTarget = Extract<
  ReferenceColumn,
  { type: 'record' }
>['target']

export type LedgerContext = {
  /** The Companies object, as the reference matcher points at it. */
  company: CompanyTarget
  /** The company column's cells, looked up (`lookupReferences`). */
  lookup: ReferenceLookup
  /** Companies that already have a holding. */
  held: ReadonlySet<string>
}

export type PlannedLedgerRow = { rowNum: number; plan: LedgerRowPlan }

/** The reference column the company cell is matched through. */
export function companyColumnOf(
  columns: LedgerColumns,
  target: CompanyTarget,
): ReferenceColumn | null {
  const c = columns.company
  return c
    ? {
        type: 'record',
        column: c.column,
        attributeId: LEDGER_COMPANY_REF,
        multi: false,
        required: true,
        createMissing: c.createMissing === true,
        target,
      }
    : null
}

/** Round fields agree when each pair is equal or one side is unknown. */
function mergeRounds(
  a: LedgerRoundEvent,
  b: LedgerRoundEvent,
): LedgerRoundEvent | null {
  const pick = <T>(x: T | null, y: T | null): { ok: boolean; v: T | null } =>
    x === null
      ? { ok: true, v: y }
      : y === null || x === y
        ? { ok: true, v: x }
        : { ok: false, v: x }
  const parts = {
    raised: pick(a.raised, b.raised),
    currency: pick(a.currency, b.currency),
    preMoney: pick(a.preMoney, b.preMoney),
    postMoney: pick(a.postMoney, b.postMoney),
    pricePerShare: pick(a.pricePerShare, b.pricePerShare),
    sharesOutstanding: pick(a.sharesOutstanding, b.sharesOutstanding),
  }
  if (Object.values(parts).some((p) => !p.ok)) return null
  return {
    date: a.date,
    kind: a.kind,
    raised: parts.raised.v,
    currency: parts.currency.v,
    preMoney: parts.preMoney.v,
    postMoney: parts.postMoney.v,
    pricePerShare: parts.pricePerShare.v,
    sharesOutstanding: parts.sharesOutstanding.v,
  }
}

const roundKey = (r: LedgerRoundEvent) =>
  `${r.kind.trim().toLowerCase()}|${r.date}`

/**
 * Every row's plan. Rows are grouped by company — the entity the matcher
 * found, or the create it plans — and each company is born one holding, on
 * its first landing row, unless it already has one; a second row for it
 * plans a second investment and no second holding. Two rows naming one
 * round (same kind, same date) plan it once, on the first, and the second
 * cheque joins it; rows whose round figures disagree stop the later row.
 */
export function planLedgerBatch(
  rows: ReadonlyArray<{ rowNum: number; cells: ReadonlyArray<string> }>,
  mapping: Mapping,
  ctx: LedgerContext,
): Array<PlannedLedgerRow> {
  const columns = ledgerColumnsOf(mapping)
  const decisions = ledgerDecisionsOf(columns)
  const companyColumn = companyColumnOf(columns, ctx.company)

  const planned: Array<PlannedLedgerRow> = rows.map((row) => {
    const read = planLedgerRow(row.cells, columns, decisions, row.rowNum)
    const raw = companyColumn ? (row.cells.at(companyColumn.column) ?? '') : ''
    const companyErrors: Array<ImportCellIssue> = []
    let references: Array<ImportReference> = []
    if (!companyColumn)
      companyErrors.push({ column: -1, raw: '', reason: 'no company column' })
    else if (raw.trim() === '')
      companyErrors.push({
        column: companyColumn.column,
        raw,
        reason: 'no company',
      })
    else {
      const out = resolveReferenceCells(
        [
          {
            column: companyColumn.column,
            attributeId: LEDGER_COMPANY_REF,
            raw,
          },
        ],
        new Map([[companyColumn.column, companyColumn]]),
        ctx.lookup,
      )
      companyErrors.push(...out.errors, ...out.skippedCells)
      references = out.references
    }
    const ref = references.at(0)
    const company =
      ref?.to === 'record'
        ? `entity:${ref.entityId}`
        : ref?.to === 'create'
          ? ref.key
          : null
    const errors = [...companyErrors, ...read.errors].sort(
      (a, b) => a.column - b.column,
    )
    const lands =
      errors.length === 0 && read.events !== null && company !== null
    const ledger: LedgerPlan = {
      company,
      birthsHolding: false,
      events: lands ? read.events : null,
      needs: read.needs,
    }
    const plan: LedgerRowPlan = {
      verdict: !lands ? 'no-land' : ref?.to === 'record' ? 'attach' : 'create',
      creator: 'resolveEntity',
      name: raw.trim() === '' ? null : raw.trim(),
      ...(ref?.to === 'record' ? { entityId: ref.entityId } : {}),
      patch: {},
      identity: {},
      errors,
      skippedCells: read.skippedCells,
      ...(references.length > 0 ? { references } : {}),
      kind: 'ledger',
      ledger,
    }
    return { rowNum: row.rowNum, plan }
  })

  // One round per company, kind and date.
  const rounds = new Map<string, { rowNum: number; index: number }>()
  for (const [index, row] of planned.entries()) {
    const events = row.plan.ledger.events
    const round = events?.round
    if (!events || !round || row.plan.ledger.company === null) continue
    const key = `${row.plan.ledger.company}#${roundKey(round)}`
    const first = rounds.get(key)
    if (!first) {
      rounds.set(key, { rowNum: row.rowNum, index })
      continue
    }
    const holder = planned[first.index]
    const held = holder.plan.ledger.events
    const merged = held?.round ? mergeRounds(held.round, round) : null
    if (!held || !merged) {
      const column = ledgerColumnsOf(mapping).roundKind?.column ?? -1
      row.plan = {
        ...row.plan,
        verdict: 'no-land',
        errors: [
          ...row.plan.errors,
          {
            column,
            raw: round.kind,
            reason: `round ${round.kind} ${round.date} differs from row ${first.rowNum}'s`,
          },
        ],
        ledger: { ...row.plan.ledger, events: null },
      }
      continue
    }
    holder.plan = {
      ...holder.plan,
      ledger: { ...holder.plan.ledger, events: { ...held, round: merged } },
    }
    const rest: LedgerEvents = {
      investment: { ...events.investment, roundRow: first.rowNum },
      ...(events.mark ? { mark: events.mark } : {}),
      ...(events.distribution ? { distribution: events.distribution } : {}),
    }
    row.plan = { ...row.plan, ledger: { ...row.plan.ledger, events: rest } }
  }

  // One holding per company, born on its first landing row; the company's
  // create rides on that row too.
  const seen = new Set<string>()
  return planned.map((row) => {
    const plan = row.plan
    const company = plan.ledger.company
    if (plan.verdict === 'no-land' || company === null || seen.has(company))
      return row
    seen.add(company)
    const ref = plan.references?.at(0)
    const existing = ref?.to === 'record' && ctx.held.has(ref.entityId)
    const next: LedgerRowPlan = {
      ...plan,
      ledger: { ...plan.ledger, birthsHolding: !existing },
    }
    if (ref?.to === 'create') {
      const create: ImportAlsoCreate = {
        key: ref.key,
        column: ref.column,
        attributeId: ref.attributeId,
        objectId: ref.objectId,
        plan: {
          verdict: 'create',
          creator: ref.creator,
          name: ref.createName,
          patch: {},
          identity: ref.identity,
          errors: [],
          skippedCells: [],
        },
      }
      next.alsoCreates = [create]
    }
    return { rowNum: row.rowNum, plan: next }
  })
}

// ---------------------------------------------------------------------------
// Reading a stored plan
// ---------------------------------------------------------------------------

/** A stored plan is a ledger row's when it says so. */
export function isLedgerPlan(plan: RowPlan): plan is LedgerRowPlan {
  // Read as `unknown`: the plan came out of a jsonb column.
  const kind: unknown = 'kind' in plan ? plan.kind : undefined
  return kind === 'ledger'
}

export type LedgerCounts = {
  /** Companies with a landing row. */
  holdings: number
  /** Of `holdings`, those born by this batch. */
  births: number
  rounds: number
  investments: number
  marks: number
  distributions: number
  noLand: number
  /** Rows stopped by a decision not yet made. */
  needDecision: number
  total: number
}

export function countLedger(plans: ReadonlyArray<LedgerRowPlan>): LedgerCounts {
  const counts: LedgerCounts = {
    holdings: 0,
    births: 0,
    rounds: 0,
    investments: 0,
    marks: 0,
    distributions: 0,
    noLand: 0,
    needDecision: 0,
    total: plans.length,
  }
  const companies = new Set<string>()
  for (const p of plans) {
    const events = p.ledger.events
    if (p.verdict === 'no-land' || !events) {
      counts.noLand += 1
      if (p.ledger.needs.length > 0) counts.needDecision += 1
      continue
    }
    if (p.ledger.company !== null) companies.add(p.ledger.company)
    if (p.ledger.birthsHolding) counts.births += 1
    counts.investments += 1
    if (events.round) counts.rounds += 1
    if (events.mark) counts.marks += 1
    if (events.distribution) counts.distributions += 1
  }
  counts.holdings = companies.size
  return counts
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** The preview's title: `12 holdings · 19 investments · 14 rounds · 11 marks · 1 will not land.` */
export function ledgerSentence(counts: LedgerCounts): string {
  const parts = [
    plural(counts.holdings, 'holding'),
    plural(counts.investments, 'investment'),
    plural(counts.rounds, 'round'),
    plural(counts.marks, 'mark'),
  ]
  if (counts.distributions > 0)
    parts.push(plural(counts.distributions, 'distribution'))
  if (counts.noLand > 0)
    parts.push(`${counts.noLand.toLocaleString('en-US')} will not land`)
  return `${parts.join(' · ')}.`
}

/** The mapping page's readout counts: `19 investments · 14 rounds · 11 marks · 2 rows need a decision`. */
export function ledgerReadout(counts: LedgerCounts): Array<string> {
  const parts = [
    plural(counts.investments, 'investment'),
    plural(counts.rounds, 'round'),
    plural(counts.marks, 'mark'),
  ]
  if (counts.distributions > 0)
    parts.push(plural(counts.distributions, 'distribution'))
  if (counts.needDecision > 0)
    parts.push(
      `${plural(counts.needDecision, 'row')} need${counts.needDecision === 1 ? 's' : ''} a decision`,
    )
  return parts
}

/** A money figure: `$50,000`, or the bare number when the currency is unknown. */
export function moneyText(
  amount: number,
  currency: string | null,
  compact = false,
): string {
  if (currency === null || !/^[A-Z]{3}$/.test(currency))
    return amount.toLocaleString('en-US')
  return fmtMoney(amount, currency, compact ? { compact: true } : undefined)
}

const INSTRUMENT_WORDS: Record<LedgerInstrument, string> = {
  priced: 'priced',
  safe_post_money: 'post-money SAFE',
  safe_pre_money: 'pre-money SAFE',
  ccd: 'CCD',
}

export type LedgerEventLine = {
  date: string
  kind: 'round' | 'investment' | 'mark' | 'distribution'
  rowNum: number
  text: string
}

const EVENT_ORDER = { round: 0, investment: 1, mark: 2, distribution: 3 }

/** A row's events as report lines — a joined round is its first row's. */
export function eventLines(
  rowNum: number,
  events: LedgerEvents,
): Array<LedgerEventLine> {
  const out: Array<LedgerEventLine> = []
  const r = events.round
  if (r)
    out.push({
      date: r.date,
      kind: 'round',
      rowNum,
      text: `round ${r.kind} ${r.date}`,
    })
  const i = events.investment
  const sameDay = r?.date === i.date
  out.push({
    date: i.date,
    kind: 'investment',
    rowNum,
    text: `investment ${moneyText(i.amount, i.currency)} ${INSTRUMENT_WORDS[i.instrument]}${sameDay ? '' : ` ${i.date}`}`,
  })
  const m = events.mark
  if (m)
    out.push({
      date: m.date,
      kind: 'mark',
      rowNum,
      text: `mark ${moneyText(m.fairValue, m.currency)} ${m.date}`,
    })
  const d = events.distribution
  if (d)
    out.push({
      date: d.date,
      kind: 'distribution',
      rowNum,
      text: `${d.kind === 'writeoff' ? 'write-off' : d.kind} ${moneyText(d.amount, d.currency)} ${d.date}`,
    })
  return out
}

export type LedgerCompanyReport = {
  company: string
  name: string
  entityId: string | null
  verdict: 'attach' | 'create'
  /** Born by this batch, or already held. */
  holding: 'birth' | 'existing'
  rows: Array<number>
  events: Array<LedgerEventLine>
}

/**
 * The dry run's per-company list: every landing row of a company, its
 * events in date order (round before cheque before mark on one day, then
 * sheet order).
 */
export function ledgerReport(
  rows: ReadonlyArray<PlannedLedgerRow>,
): Array<LedgerCompanyReport> {
  const byCompany = new Map<string, LedgerCompanyReport>()
  for (const { rowNum, plan } of rows) {
    const events = plan.ledger.events
    const company = plan.ledger.company
    if (plan.verdict === 'no-land' || !events || company === null) continue
    const held = byCompany.get(company) ?? {
      company,
      name: plan.references?.at(0)?.name ?? plan.name ?? '',
      entityId: plan.entityId ?? null,
      verdict: plan.verdict === 'attach' ? 'attach' : 'create',
      holding: 'existing',
      rows: [],
      events: [],
    }
    if (plan.ledger.birthsHolding) held.holding = 'birth'
    held.rows.push(rowNum)
    held.events.push(...eventLines(rowNum, events))
    byCompany.set(company, held)
  }
  const out = [...byCompany.values()]
  for (const c of out)
    c.events.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind] ||
        a.rowNum - b.rowNum,
    )
  return out
}

/** A stopped row's why: `Instrument "SAFE" · could be safe_post_money or safe_pre_money`. */
export function ledgerWhy(
  plan: LedgerRowPlan,
  headers: ReadonlyArray<string> | null,
): string {
  const e = plan.errors.at(0)
  if (!e) return 'does not read'
  const h =
    e.column < 0 ? '' : headers?.at(e.column)?.trim() || columnLetter(e.column)
  const raw = e.raw.trim()
  const shown =
    raw === '' || e.reason.includes(`"${raw}"`)
      ? ''
      : ` "${raw.length > 24 ? `${raw.slice(0, 23)}…` : raw}"`
  const more =
    plan.errors.length > 1 ? ` · +${plan.errors.length - 1} more` : ''
  return `${h}${shown}${h || shown ? ' · ' : ''}${e.reason}${more}`
}

// ---------------------------------------------------------------------------
// The mapping step's readings
// ---------------------------------------------------------------------------

export type InstrumentValue = {
  key: string
  /** The first spelling, trimmed; empty for a blank cell. */
  raw: string
  rows: number
  resolution: LedgerInstrumentResolution | null
  /** Resolved by its spelling rather than by a stored choice. */
  auto: boolean
  candidates: Array<LedgerInstrument>
}

export type LedgerSummary = {
  /** Rows carrying each group's data. */
  groups: Record<LedgerGroup, number>
  instruments: Array<InstrumentValue>
  /** Rows with a mark value and no mark date. */
  marksWithoutDate: number
  /** Rows with an amount whose currency nothing names. */
  rowsWithoutCurrency: number
  /** Date cells that read two ways, and those whose two readings differ. */
  dates: { ambiguous: number; flips: number }
  /** Decisions the operator has still to make. */
  open: number
}

const ROUND_FIELDS: ReadonlyArray<LedgerField> = [
  'roundKind',
  'roundDate',
  'raised',
  'preMoney',
  'postMoney',
  'pricePerShare',
  'sharesOutstanding',
]

/** What the decisions panel and the group hints read, over every staged row. */
export function summarizeLedger(
  rows: ReadonlyArray<{ cells: ReadonlyArray<string> }>,
  mapping: Mapping,
): LedgerSummary {
  const columns = ledgerColumnsOf(mapping)
  const decisions = ledgerDecisionsOf(columns)
  const raw = (cells: ReadonlyArray<string>, f: LedgerField) => {
    const c = columns[f]
    return c ? (cells.at(c.column) ?? '').trim() : ''
  }
  const groups: Record<LedgerGroup, number> = {
    company: 0,
    round: 0,
    cheque: 0,
    mark: 0,
    proceeds: 0,
  }
  const values = new Map<string, InstrumentValue>()
  let marksWithoutDate = 0
  let rowsWithoutCurrency = 0
  let ambiguous = 0
  let flips = 0
  for (const { cells } of rows) {
    if (raw(cells, 'company') !== '') groups.company += 1
    if (raw(cells, 'markValue') !== '') groups.mark += 1
    if (ROUND_FIELDS.some((f) => raw(cells, f) !== '')) groups.round += 1
    if (
      raw(cells, 'distributionAmount') !== '' ||
      raw(cells, 'distributionKind') !== ''
    )
      groups.proceeds += 1
    const amount = raw(cells, 'amount')
    if (amount !== '') groups.cheque += 1
    if (raw(cells, 'markValue') !== '' && raw(cells, 'markDate') === '')
      marksWithoutDate += 1
    if (
      amount !== '' &&
      raw(cells, 'currency') === '' &&
      currencyOfMark(amount) === null
    )
      rowsWithoutCurrency += 1
    if (columns.instrument && amount !== '') {
      const cell = raw(cells, 'instrument')
      const key = instrumentKey(cell)
      const held = values.get(key)
      if (held) held.rows += 1
      else {
        const r = resolveInstrument(key, decisions.instrumentMap)
        values.set(key, {
          key,
          raw: cell,
          rows: 1,
          resolution: r.resolution,
          auto: r.auto,
          candidates: instrumentCandidates(key),
        })
      }
    }
    for (const f of LEDGER_DATE_FIELDS) {
      const cell = raw(cells, f)
      if (cell === '') continue
      const plain = coerce('date', {}, cell)
      if (plain.ok) continue
      const dmy = coerce('date', { dateOrder: 'dmy' }, cell)
      const mdy = coerce('date', { dateOrder: 'mdy' }, cell)
      if (!dmy.ok && !mdy.ok) continue
      ambiguous += 1
      if (dmy.ok && mdy.ok && dmy.value !== mdy.value) flips += 1
    }
  }
  const instruments = [...values.values()]
  const orderOpen =
    ambiguous > 0 &&
    LEDGER_DATE_FIELDS.some(
      (f) => columns[f] !== undefined && columns[f].dateOrder === undefined,
    )
  const open =
    instruments.filter((v) => v.resolution === null).length +
    (marksWithoutDate > 0 && decisions.marksAsOf === null ? 1 : 0) +
    (rowsWithoutCurrency > 0 && decisions.currency === null ? 1 : 0) +
    (orderOpen ? 1 : 0)
  return {
    groups,
    instruments,
    marksWithoutDate,
    rowsWithoutCurrency,
    dates: { ambiguous, flips },
    open,
  }
}

/** A field's cell as row 1 becomes it, or null when blank. */
function fieldText(
  f: LedgerField,
  cells: ReadonlyArray<string>,
  columns: LedgerColumns,
  decisions: LedgerDecisions,
): string | null {
  const c = columns[f]
  if (!c) return null
  const raw = cells.at(c.column) ?? ''
  if (raw.trim() === '') return null
  if (isDateField(f)) {
    const r = readDate(raw, c.dateOrder)
    return r.kind === 'ok' ? r.value : `"${raw.trim()}" ?`
  }
  switch (f) {
    case 'amount':
    case 'cap':
    case 'raised':
    case 'preMoney':
    case 'postMoney':
    case 'markValue':
    case 'distributionAmount': {
      const r = readNumber(raw, MONEY_SPEC)
      if (r.kind !== 'ok') return `"${raw.trim()}" ?`
      const amountCell = columns.amount
        ? (cells.at(columns.amount.column) ?? '')
        : ''
      const currencyCell = columns.currency
        ? readCurrencyCell(cells.at(columns.currency.column) ?? '')
        : null
      const ccy =
        currencyOfMark(raw) ??
        (currencyCell?.ok ? currencyCell.code : null) ??
        currencyOfMark(amountCell) ??
        decisions.currency
      const compact =
        f !== 'amount' && f !== 'markValue' && f !== 'distributionAmount'
      const text = moneyText(r.value, ccy, compact)
      return f === 'preMoney'
        ? `${text} pre`
        : f === 'postMoney'
          ? `${text} post`
          : text
    }
    case 'currency': {
      const r = readCurrencyCell(raw)
      return r.ok ? r.code : `"${raw.trim()}" ?`
    }
    case 'instrument': {
      const key = instrumentKey(raw)
      const { resolution } = resolveInstrument(key, decisions.instrumentMap)
      return resolution === null || resolution === 'per_row'
        ? `"${raw.trim()}" ?`
        : INSTRUMENT_WORDS[resolution]
    }
    case 'discount': {
      const r = readDiscount(raw)
      return r.kind === 'ok'
        ? `${Math.round(r.value * 1000) / 10}% discount`
        : `"${raw.trim()}" ?`
    }
    default:
      return raw.trim()
  }
}

/** A line's `row 1 becomes`: its fields' readings, joined. Empty when none. */
export function lineBecomes(
  line: LedgerLine,
  cells: ReadonlyArray<string>,
  mapping: Mapping,
): string {
  const columns = ledgerColumnsOf(mapping)
  const decisions = ledgerDecisionsOf(columns)
  const parts = line.fields.flatMap((f) => {
    const t = fieldText(f, cells, columns, decisions)
    return t === null ? [] : [t]
  })
  if (
    line.fields.includes('markValue') &&
    columns.markValue &&
    (cells.at(columns.markValue.column) ?? '').trim() !== '' &&
    fieldText('markDate', cells, columns, decisions) === null &&
    decisions.marksAsOf !== null
  )
    parts.push(decisions.marksAsOf)
  return parts.join(' · ')
}

/** A line's mapped columns in its picker: `H · I · J`, `—` for a field off the sheet. */
export function lineColumns(line: LedgerLine, mapping: Mapping): string | null {
  const columns = ledgerColumnsOf(mapping)
  const letters = line.fields.map((f) => {
    const c = columns[f]
    return c ? columnLetter(c.column) : '—'
  })
  return letters.every((l) => l === '—') ? null : letters.join(' · ')
}
