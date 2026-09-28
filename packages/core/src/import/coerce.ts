import { valueValidator } from '../attributes/registry'
import type {
  AttributeOptions,
  AttributeType,
  SelectOption,
} from '../attributes/registry'
import {
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizePhone,
  normalizeUrl,
  registrableDomain,
} from '../entities/normalize'

/**
 * One spreadsheet cell → one attribute value, or the reason it is not one
 * (SPA-166, project 14 `import-4`). Pure: no database, no registry lookup —
 * the caller hands over the attribute's type and options, plus whatever the
 * mapping step declared about the column.
 *
 * The output is the write shape `setValues` takes (`planPatch` validates it
 * with `valueValidator`, and so does the last line of `coerce`): numbers for
 * number/currency/rating, `YYYY-MM-DD` for date, booleans for checkbox,
 * option **ids** for select/status/multi_select, strings for the text-like
 * types. A blank cell is `null` — no value, never a failure and never 0.
 *
 * Refusal is the point. A cell that could mean two things (`03/04/2026`
 * with no declared order), a label that is not an option (`Seed` on a
 * status with no such stage), a placeholder (`TBD`) — each is a reason the
 * mapping table can show beside its row, because per-row errors are what
 * CONTEXT.md phase 15 item 9 asks for and a silently wrong value is worse
 * than a missing one. Nothing here ever mints an option.
 */

/** Which way round a slashed date reads. Declared in the mapping, never sniffed. */
export type DateOrder = 'dmy' | 'mdy'

/**
 * The attribute's own options plus what the mapping declared about the
 * column. `dateOrder` belongs to the column, not the attribute — two sheets
 * mapped onto one date attribute can disagree — so it rides alongside:
 * `{ ...def.options, dateOrder }`.
 */
export type CoerceOptions = AttributeOptions & { dateOrder?: DateOrder }

export type CoercedValue = string | number | boolean | Array<string>

export type Coercion =
  { ok: true; value: CoercedValue | null } | { ok: false; reason: string }

const accept = (value: CoercedValue | null): Coercion => ({ ok: true, value })
const refuse = (reason: string): Coercion => ({ ok: false, reason })

/** The cell as a reason names it: quoted, and clipped so a paragraph stays a line. */
function quote(raw: string): string {
  const s = raw.trim()
  return `"${s.length > 40 ? `${s.slice(0, 39)}…` : s}"`
}

// ---------------------------------------------------------------------------
// number / currency
// ---------------------------------------------------------------------------

/**
 * The currency marks a money cell is written with. Symbols (optionally
 * prefixed, `US$`, `S$`, `HK$`), the rupee's `Rs`, and ISO codes from a known
 * list — not any three letters, or `ABC123` would read as 123.
 */
const ISO_CODES = 'USD|EUR|GBP|INR|JPY|CNY|SGD|AUD|CAD|CHF|HKD|AED|NZD'
const MARK = `(?:[A-Z]{0,2}[$€£¥₹]|Rs\\.?|${ISO_CODES})`
const LEADING_MARK = new RegExp(`^${MARK}\\s*`, 'i')
const TRAILING_MARK = new RegExp(`\\s*${MARK}$`, 'i')

/**
 * Digits with an optional decimal part. The integer part is ungrouped, or
 * grouped in thousands (`1,250,000`), or grouped the Indian way — the last
 * three digits, then pairs (`1,25,000`, `1,00,00,000`). A comma anywhere
 * else (`12,5`) is refused: it is a European decimal as often as a typo.
 */
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.\d+)?$/

function stripSign(s: string): { rest: string; negative: boolean } {
  const m = /^[-−]\s*/.exec(s)
  return m
    ? { rest: s.slice(m[0].length), negative: true }
    : { rest: s, negative: false }
}

/** `(1,250.00)` → -1250, `₹1,25,000` → 125000, `$-400` → -400, `TBD` → null. */
function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[\u00a0\u202f]/g, ' ')
  let negative = false
  const paren = /^\((.*)\)$/.exec(s)
  if (paren) {
    negative = true
    s = paren[1].trim()
  }
  const signed = (next: { rest: string; negative: boolean }) => {
    if (next.negative && negative) return false
    negative = negative || next.negative
    s = next.rest
    return true
  }
  if (!signed(stripSign(s))) return null
  s = s.replace(LEADING_MARK, '')
  if (!signed(stripSign(s))) return null
  s = s.replace(TRAILING_MARK, '')
  if (!AMOUNT.test(s)) return null
  const n = Number(s.replaceAll(',', ''))
  if (!Number.isFinite(n)) return null
  return negative && n !== 0 ? -n : n
}

// ---------------------------------------------------------------------------
// date
// ---------------------------------------------------------------------------

const YEAR_FIRST = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/
const YEAR_LAST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (d > days) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
}

function coerceDate(raw: string, order: DateOrder | undefined): Coercion {
  const s = raw.trim()
  const first = YEAR_FIRST.exec(s)
  if (first) {
    const iso = isoDate(Number(first[1]), Number(first[2]), Number(first[3]))
    return iso ? accept(iso) : refuse(`${quote(raw)} is not a calendar date`)
  }
  const last = YEAR_LAST.exec(s)
  if (!last) return refuse(`${quote(raw)} is not a date`)
  if (last[3].length === 2)
    return refuse(`${quote(raw)} has a two-digit year — write it in full`)
  if (!order)
    return refuse(
      `${quote(raw)} reads two ways — declare day-first or month-first for this column`,
    )
  const [a, b] = [Number(last[1]), Number(last[2])]
  const iso =
    order === 'dmy'
      ? isoDate(Number(last[3]), b, a)
      : isoDate(Number(last[3]), a, b)
  return iso
    ? accept(iso)
    : refuse(
        `${quote(raw)} is not a calendar date read ${order === 'dmy' ? 'day-first' : 'month-first'}`,
      )
}

// ---------------------------------------------------------------------------
// select / status / multi_select
// ---------------------------------------------------------------------------

const labelKey = (s: string) => s.trim().toLowerCase()

type OptionMatch =
  | { kind: 'live'; id: string }
  | { kind: 'archived'; label: string }
  | { kind: 'unknown' }

function matchOption(
  options: ReadonlyArray<SelectOption>,
  label: string,
): OptionMatch {
  const key = labelKey(label)
  const hits = options.filter((o) => labelKey(o.label) === key)
  const live = hits.find((o) => !o.archived)
  if (live) return { kind: 'live', id: live.id }
  const archived = hits.at(0)
  return archived
    ? { kind: 'archived', label: archived.label }
    : { kind: 'unknown' }
}

function coerceSingleOption(
  options: ReadonlyArray<SelectOption>,
  raw: string,
): Coercion {
  const hit = matchOption(options, raw)
  if (hit.kind === 'live') return accept(hit.id)
  if (hit.kind === 'archived')
    return refuse(`"${hit.label}" is an archived option — pick a current one`)
  return refuse(`${quote(raw)} is not an option of this attribute`)
}

/**
 * A multi-select cell is one label, or several separated by commas or
 * semicolons. The whole cell is tried as one label first, so an option whose
 * label itself holds a comma still matches. Every label must be an option:
 * one unknown refuses the cell, naming each unknown, rather than importing
 * the known half and dropping the rest in silence.
 */
function coerceMultiOption(
  options: ReadonlyArray<SelectOption>,
  raw: string,
): Coercion {
  const whole = matchOption(options, raw)
  if (whole.kind === 'live') return accept([whole.id])
  const labels = raw
    .split(/[,;]/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const ids: Array<string> = []
  const unknown: Array<string> = []
  const archived: Array<string> = []
  for (const label of labels) {
    const hit = matchOption(options, label)
    if (hit.kind === 'live') {
      if (!ids.includes(hit.id)) ids.push(hit.id)
    } else if (hit.kind === 'archived') archived.push(`"${hit.label}"`)
    else unknown.push(quote(label))
  }
  if (unknown.length === 1)
    return refuse(`${unknown[0]} is not an option of this attribute`)
  if (unknown.length > 1)
    return refuse(`${unknown.join(', ')} are not options of this attribute`)
  if (archived.length > 0)
    return refuse(
      `${archived.join(', ')} ${archived.length === 1 ? 'is an archived option' : 'are archived options'} — pick current ones`,
    )
  return accept(ids)
}

// ---------------------------------------------------------------------------
// the rest
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['yes', 'true', '1'])
const FALSE_WORDS = new Set(['no', 'false', '0'])

function coerceShape(
  type: AttributeType,
  options: CoerceOptions,
  raw: string,
): Coercion {
  const s = raw.trim()
  switch (type) {
    case 'text':
      return accept(s)
    case 'number':
    case 'currency': {
      const n = parseAmount(s)
      return n === null ? refuse(`${quote(raw)} is not a number`) : accept(n)
    }
    case 'rating': {
      const max = options.max ?? 5
      if (!/^\d+(?:\.0+)?$/.test(s))
        return refuse(`${quote(raw)} is not a whole number from 1 to ${max}`)
      const n = Number(s)
      return n >= 1 && n <= max
        ? accept(n)
        : refuse(`${quote(raw)} is outside 1 to ${max}`)
    }
    case 'date':
      return coerceDate(raw, options.dateOrder)
    case 'checkbox': {
      const k = s.toLowerCase()
      if (TRUE_WORDS.has(k)) return accept(true)
      if (FALSE_WORDS.has(k)) return accept(false)
      return refuse(`${quote(raw)} is not yes/no, true/false or 1/0`)
    }
    case 'select':
    case 'status':
      return coerceSingleOption(options.options ?? [], s)
    case 'multi_select':
      return coerceMultiOption(options.options ?? [], s)
    case 'domain': {
      // An identity-backed domain refuses free mail, exactly as its
      // validator does; any other domain field takes whatever host it is.
      const norm = options.identityKey
        ? normalizeDomain(s)
        : registrableDomain(s)
      if (norm) return accept(norm)
      return registrableDomain(s)
        ? refuse(`${quote(raw)} is free mail and identifies no record`)
        : refuse(`${quote(raw)} is not a domain`)
    }
    case 'email':
      // Stored as written: `normalizeEmail` is the matching form (it folds
      // gmail's dots and +tags), which is a claim about identity, not the
      // address the person gave.
      return normalizeEmail(s)
        ? accept(s)
        : refuse(`${quote(raw)} is not an email address`)
    case 'url': {
      const url = normalizeUrl(s)
      if (!url) return refuse(`${quote(raw)} is not a web address`)
      if (options.identityKey === 'linkedin' && !normalizeLinkedin(url))
        return refuse(`${quote(raw)} is not a LinkedIn profile or company page`)
      return accept(url)
    }
    case 'phone':
      return normalizePhone(s)
        ? accept(s)
        : refuse(`${quote(raw)} is not a phone number`)
    case 'record_reference':
      return refuse(
        'record references are matched to records in the next step, not read from the cell',
      )
    case 'actor_reference':
      return refuse(
        'workspace members are matched in the next step, not read from the cell',
      )
  }
}

/**
 * One cell. `null` or blank is no value. Every accepted value is also run
 * through the registry's own `valueValidator`, so what this answers `ok` is
 * exactly what the one write path will take — length limits, archived
 * options and identity refusals included — and a disagreement surfaces here
 * as a reason instead of as a failed write in the middle of an import.
 */
export function coerce(
  type: AttributeType,
  options: CoerceOptions,
  raw: string | null,
): Coercion {
  if (raw === null || raw.trim() === '') return accept(null)
  const out = coerceShape(type, options, raw)
  if (!out.ok || out.value === null) return out
  const check = valueValidator({ type, options }).safeParse(out.value)
  if (check.success) return out
  const issue = check.error.issues.at(0)
  return refuse(`${quote(raw)}: ${issue ? issue.message : 'not accepted'}`)
}

export type ColumnFailure = { row: number; raw: string; reason: string }

export type ColumnSummary = {
  /** Non-blank cells that coerced. */
  parsed: number
  /** Non-blank cells — a blank is no value, neither a parse nor a failure. */
  total: number
  /** Each refused cell; `row` is its index in `rawValues`. */
  failures: Array<ColumnFailure>
}

/**
 * The truth about one mapped column — "38 of 40 values parse" — and the rows
 * behind the two that do not. What the mapping step (SPA-165) shows per
 * column; `parsed === 0 && total > 0` is the column where nothing parses.
 */
export function summarizeColumn(
  type: AttributeType,
  options: CoerceOptions,
  rawValues: ReadonlyArray<string | null>,
): ColumnSummary {
  const summary: ColumnSummary = { parsed: 0, total: 0, failures: [] }
  rawValues.forEach((raw, row) => {
    if (raw === null || raw.trim() === '') return
    summary.total += 1
    const out = coerce(type, options, raw)
    if (out.ok) summary.parsed += 1
    else summary.failures.push({ row, raw, reason: out.reason })
  })
  return summary
}
