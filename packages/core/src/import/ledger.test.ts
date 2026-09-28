import { describe, expect, it } from 'vitest'
import { CORE_IDENTITY_KEYS } from '../attributes/registry'
import {
  MESSY_HEADER,
  MESSY_ROWS,
  UNIVERSAL_HEADER,
  UNIVERSAL_ROWS,
} from './ledger.fixtures'
import {
  LEDGER_LINES,
  applyLedgerDecision,
  assignLedgerField,
  autoMapLedger,
  countLedger,
  currencyOfMark,
  instrumentKey,
  isLedgerPlan,
  ledgerColumnsOf,
  ledgerDecisionsOf,
  ledgerReport,
  ledgerSentence,
  ledgerStop,
  lineBecomes,
  lineColumns,
  planLedgerBatch,
  planLedgerRow,
  readDiscount,
  summarizeLedger,
  validateLedgerMapping,
} from './ledger'
import { referenceKey } from './references'
import type { CompanyTarget, LedgerContext, PlannedLedgerRow } from './ledger'
import type { ReferenceOutcome } from './references'
import type { Mapping } from '@spaces/db/schema/import'

/**
 * SPA-170. The ledger planner is pure: these run with Postgres stopped —
 * core's vitest config loads no environment at all.
 */

const COMPANIES: CompanyTarget = {
  objectId: 'o-companies',
  kind: 'company',
  singular: 'Company',
  plural: 'Companies',
  identityKeys: [...CORE_IDENTITY_KEYS],
  creator: 'resolveEntity',
}

/** Company names that exist, by id; everything else is missing. */
function contextFor(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  found: Record<string, string>,
  held: Array<string> = [],
): LedgerContext {
  const outcomes = new Map<string, ReferenceOutcome>()
  for (const cells of rows) {
    const raw = cells[0]
    if (raw.trim() === '') continue
    const id = found[raw]
    outcomes.set(
      referenceKey(raw),
      id
        ? { status: 'found', entityId: id, name: raw }
        : { status: 'missing', identity: null },
    )
  }
  return {
    company: COMPANIES,
    lookup: new Map([[0, outcomes]]),
    held: new Set(held),
  }
}

const rowsOf = (cells: Array<Array<string>>) =>
  cells.map((c, i) => ({ rowNum: i + 1, cells: c }))

function plan(
  header: Array<string>,
  cells: Array<Array<string>>,
  mapping: Mapping = autoMapLedger(header),
  found: Record<string, string> = {},
  held: Array<string> = [],
): Array<PlannedLedgerRow> {
  return planLedgerBatch(rowsOf(cells), mapping, contextFor(cells, found, held))
}

const decide = (
  mapping: Mapping,
  ...decisions: Array<Parameters<typeof applyLedgerDecision>[1]>
): Mapping =>
  decisions.reduce((m, d) => {
    const out = applyLedgerDecision(m, d)
    if (!out.ok) throw new Error(out.reason)
    return out.mapping
  }, mapping)

describe('auto-map', () => {
  it('maps the universal tracking sheet by its headers', () => {
    const m = autoMapLedger(UNIVERSAL_HEADER)
    const fields = m.map((t) => (t.target === 'ledger' ? t.field : null))
    expect(fields).toEqual([
      'company',
      'date',
      'amount',
      'currency',
      'instrument',
      'roundKind',
      'roundDate',
      'raised',
      'preMoney',
      'cap',
      'discount',
      'vehicle',
      'markValue',
      'markDate',
    ])
    expect(validateLedgerMapping(m)).toEqual([])
  })

  it('reads the common aliases, and leaves anything else unmapped', () => {
    const m = autoMapLedger([...MESSY_HEADER, 'Notes'])
    expect(m.map((t) => (t.target === 'ledger' ? t.field : null))).toEqual([
      'company',
      'date',
      'amount',
      'currency',
      'instrument',
      'roundKind',
      'cap',
      'markValue',
      'markDate',
      null,
    ])
  })

  it('needs only the company and the cheque date and amount to advance', () => {
    const m = autoMapLedger(['Company', 'Date', 'Amount'])
    expect(validateLedgerMapping(m)).toEqual([])
    expect(
      validateLedgerMapping(autoMapLedger(['Company', 'Date'])).map(
        (p) => p.reason,
      ),
    ).toEqual(['Map the amount of our cheque'])
  })
})

describe('one row', () => {
  const m = autoMapLedger(UNIVERSAL_HEADER)
  const columns = ledgerColumnsOf(m)
  const decisions = ledgerDecisionsOf(columns)

  it('plans one investment, at most one round and one mark, and no balance', () => {
    const out = planLedgerRow(UNIVERSAL_ROWS[0], columns, decisions, 1)
    expect(out.errors).toEqual([])
    expect(out.events).toEqual({
      round: {
        date: '2023-03-15',
        kind: 'Seed',
        raised: 5_000_000,
        currency: 'USD',
        preMoney: 20_000_000,
        postMoney: null,
        pricePerShare: null,
        sharesOutstanding: null,
      },
      investment: {
        date: '2023-03-15',
        amount: 50_000,
        currency: 'USD',
        instrument: 'priced',
        shares: null,
        cap: null,
        discount: null,
        vehicle: 'Fund I',
        roundRow: 1,
      },
      mark: {
        date: '2025-12-31',
        fairValue: 120_000,
        currency: 'USD',
        basis: 'manual',
      },
    })
    // Events only: no aggregate, no balance, no current value on anything.
    expect(Object.keys(out.events ?? {}).sort()).toEqual([
      'investment',
      'mark',
      'round',
    ])
  })

  it('keeps money as numbers', () => {
    const out = planLedgerRow(UNIVERSAL_ROWS[2], columns, decisions, 3)
    expect(typeof out.events?.investment.amount).toBe('number')
    expect(typeof out.events?.round?.raised).toBe('number')
    expect(typeof out.events?.mark?.fairValue).toBe('number')
  })

  it('plans no round from a cap alone', () => {
    const out = planLedgerRow(UNIVERSAL_ROWS[1], columns, decisions, 2)
    expect(out.errors).toEqual([])
    expect(out.events?.round).toBeUndefined()
    expect(out.events?.investment).toMatchObject({
      instrument: 'safe_post_money',
      cap: 8_000_000,
      discount: 0.2,
      roundRow: null,
    })
  })

  it('is byte-identical when planned twice', () => {
    for (const [i, cells] of UNIVERSAL_ROWS.entries()) {
      const a = planLedgerRow(cells, columns, decisions, i + 1)
      const b = planLedgerRow(cells, columns, decisions, i + 1)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })
})

describe('the instrument', () => {
  const m = autoMapLedger(MESSY_HEADER)

  it('refuses a bare SAFE with no stored choice, naming both candidates', () => {
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[0]], m)
    expect(row.plan.verdict).toBe('no-land')
    expect(row.plan.ledger.events).toBeNull()
    expect(row.plan.ledger.needs).toContain('instrument')
    const reason = row.plan.errors.map((e) => e.reason).join(' ')
    expect(reason).toContain('"SAFE"')
    expect(reason).toContain('safe_post_money')
    expect(reason).toContain('safe_pre_money')
    expect(ledgerStop(row.plan)).toBe('decision')
  })

  it('a row with no company is the sheet’s to fix, not a decision (SPA-173)', () => {
    const cells = [...MESSY_ROWS[0]]
    cells[0] = ''
    const chosen = decide(m, {
      kind: 'instrument',
      value: instrumentKey('SAFE'),
      resolution: 'safe_post_money',
    })
    const [row] = plan(MESSY_HEADER, [cells], chosen)
    expect(row.plan.verdict).toBe('no-land')
    expect(ledgerStop(row.plan)).toBe('sheet')
  })

  it('lands once the choice is stored on the mapping', () => {
    const chosen = decide(m, {
      kind: 'instrument',
      value: instrumentKey('SAFE'),
      resolution: 'safe_post_money',
    })
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[0]], chosen)
    expect(row.plan.errors).toEqual([])
    expect(row.plan.ledger.events?.investment.instrument).toBe(
      'safe_post_money',
    )
  })

  it('decides per row when told to, and errors until the row is decided', () => {
    const perRow = decide(m, {
      kind: 'instrument',
      value: 'safe',
      resolution: 'per_row',
    })
    expect(plan(MESSY_HEADER, [MESSY_ROWS[0]], perRow)[0].plan.verdict).toBe(
      'no-land',
    )
    const decided = decide(perRow, {
      kind: 'rowInstrument',
      rowNum: 1,
      instrument: 'safe_pre_money',
    })
    expect(
      plan(MESSY_HEADER, [MESSY_ROWS[0]], decided)[0].plan.ledger.events
        ?.investment.instrument,
    ).toBe('safe_pre_money')
  })

  it('names all four when the value is not a SAFE', () => {
    const cells = [...MESSY_ROWS[1]]
    cells[4] = 'Note'
    const [row] = plan(MESSY_HEADER, [cells], m)
    expect(row.plan.errors.at(0)?.reason).toBe(
      '"Note" could be priced, safe_post_money, safe_pre_money or ccd',
    )
  })
})

describe('marks', () => {
  const m = autoMapLedger(MESSY_HEADER)

  it('a mark with no date and no declared as-of errors — never today', () => {
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[1]], m)
    expect(row.plan.verdict).toBe('no-land')
    expect(row.plan.ledger.needs).toEqual(['marksAsOf'])
  })

  it('takes the declared marks-as-of date', () => {
    const dated = decide(m, { kind: 'marksAsOf', date: '2025-09-30' })
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[1]], dated)
    expect(row.plan.ledger.events?.mark).toEqual({
      date: '2025-09-30',
      fairValue: 150_000,
      currency: 'USD',
      basis: 'manual',
    })
  })

  it('a dated mark keeps its own date over the declared one', () => {
    const dated = decide(m, { kind: 'marksAsOf', date: '2025-09-30' })
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[5]], dated)
    expect(row.plan.ledger.events?.mark?.date).toBe('2025-12-31')
  })
})

describe('the mess', () => {
  const m = autoMapLedger(MESSY_HEADER)

  it('reads the currency off a euro amount with no currency cell', () => {
    expect(currencyOfMark('€25,000')).toBe('EUR')
    expect(currencyOfMark('$25,000')).toBeNull()
    expect(currencyOfMark('US$25,000')).toBe('USD')
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[2]], m)
    expect(row.plan.ledger.events?.investment).toMatchObject({
      amount: 25_000,
      currency: 'EUR',
    })
  })

  it('a row naming no currency takes the declared one, and errors without', () => {
    const cells = [...MESSY_ROWS[1]]
    cells[3] = ''
    cells[7] = ''
    expect(plan(MESSY_HEADER, [cells], m)[0].plan.ledger.needs).toEqual([
      'currency',
    ])
    const withDefault = decide(m, { kind: 'currency', code: 'SGD' })
    expect(
      plan(MESSY_HEADER, [cells], withDefault)[0].plan.ledger.events?.investment
        .currency,
    ).toBe('SGD')
  })

  it('a slashed date waits on the date order, then reads as declared', () => {
    expect(plan(MESSY_HEADER, [MESSY_ROWS[3]], m)[0].plan.ledger.needs).toEqual(
      ['dateOrder'],
    )
    const dmy = decide(m, { kind: 'dateOrder', order: 'dmy' })
    expect(
      plan(MESSY_HEADER, [MESSY_ROWS[3]], dmy)[0].plan.ledger.events?.investment
        .date,
    ).toBe('2025-04-03')
    const mdy = decide(m, { kind: 'dateOrder', order: 'mdy' })
    expect(
      plan(MESSY_HEADER, [MESSY_ROWS[3]], mdy)[0].plan.ledger.events?.investment
        .date,
    ).toBe('2025-03-04')
  })

  it('a cap with no round data plans no round', () => {
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[4]], m)
    expect(row.plan.errors).toEqual([])
    expect(row.plan.ledger.events?.round).toBeUndefined()
    expect(row.plan.ledger.events?.investment.cap).toBe(8_000_000)
  })

  it('round figures with no round kind stop the row rather than invent one', () => {
    const header = ['Company', 'Date', 'Amount', 'Currency', 'Type', 'Raised']
    const [row] = plan(header, [
      ['Acme', '2024-01-01', '1000', 'USD', 'Priced', '2000000'],
    ])
    expect(row.plan.verdict).toBe('no-land')
    expect(row.plan.errors.at(0)?.reason).toBe(
      'round figures with no round kind',
    )
  })
})

describe('the batch', () => {
  it('two rows for one company plan one holding and two investments', () => {
    const rows = plan(MESSY_HEADER, [MESSY_ROWS[5], MESSY_ROWS[6]])
    expect(rows.map((r) => r.plan.verdict)).toEqual(['create', 'create'])
    expect(rows[0].plan.ledger.company).toBe(rows[1].plan.ledger.company)
    expect(rows.map((r) => r.plan.ledger.birthsHolding)).toEqual([true, false])
    // The company's create rides on the first row only.
    expect(rows[0].plan.alsoCreates?.length).toBe(1)
    expect(rows[1].plan.alsoCreates).toBeUndefined()
    const counts = countLedger(rows.map((r) => r.plan))
    expect(counts).toMatchObject({ holdings: 1, births: 1, investments: 2 })
  })

  it('a company that already has a holding births none', () => {
    const rows = plan(
      MESSY_HEADER,
      [MESSY_ROWS[5], MESSY_ROWS[6]],
      autoMapLedger(MESSY_HEADER),
      { Zepto: 'e-zepto' },
      ['e-zepto'],
    )
    expect(rows.map((r) => r.plan.verdict)).toEqual(['attach', 'attach'])
    expect(rows.map((r) => r.plan.ledger.birthsHolding)).toEqual([false, false])
    expect(rows[0].plan.entityId).toBe('e-zepto')
  })

  it('a missing company without Create missing is the row error', () => {
    const m = decide(autoMapLedger(MESSY_HEADER), {
      kind: 'createMissing',
      on: false,
    })
    const [row] = plan(MESSY_HEADER, [MESSY_ROWS[5]], m)
    expect(row.plan.verdict).toBe('no-land')
    expect(row.plan.errors.at(0)?.reason).toBe('"Zepto" · no such company')
  })

  it('one round, named by two cheques, is planned once', () => {
    const header = UNIVERSAL_HEADER
    const a = [...UNIVERSAL_ROWS[0]]
    const b = [...UNIVERSAL_ROWS[0]]
    b[2] = '10000'
    b[7] = ''
    const rows = plan(header, [a, b])
    expect(rows[0].plan.ledger.events?.round).toBeDefined()
    expect(rows[1].plan.ledger.events?.round).toBeUndefined()
    expect(rows[1].plan.ledger.events?.investment.roundRow).toBe(1)
    expect(countLedger(rows.map((r) => r.plan)).rounds).toBe(1)
  })

  it('the universal sheet plans twelve investments over eleven holdings', () => {
    const rows = plan(UNIVERSAL_HEADER, UNIVERSAL_ROWS)
    expect(rows.every((r) => r.plan.errors.length === 0)).toBe(true)
    const counts = countLedger(rows.map((r) => r.plan))
    expect(counts).toMatchObject({
      holdings: 11,
      births: 11,
      investments: 12,
      rounds: 9,
      marks: 7,
      noLand: 0,
    })
    expect(ledgerSentence(counts)).toBe(
      '11 holdings · 12 investments · 9 rounds · 7 marks.',
    )
  })

  it('is a function of the rows and the mapping — byte-identical twice', () => {
    const m = decide(
      autoMapLedger(MESSY_HEADER),
      { kind: 'instrument', value: 'safe', resolution: 'safe_post_money' },
      { kind: 'marksAsOf', date: '2025-09-30' },
      { kind: 'dateOrder', order: 'dmy' },
    )
    const a = plan(MESSY_HEADER, MESSY_ROWS, m)
    const b = plan(MESSY_HEADER, MESSY_ROWS, m)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.every((r) => r.plan.errors.length === 0)).toBe(true)
    expect(a.every((r) => isLedgerPlan(r.plan))).toBe(true)
  })
})

describe('the report', () => {
  it('lists each company with its events in date order', () => {
    const rows = plan(UNIVERSAL_HEADER, UNIVERSAL_ROWS)
    const report = ledgerReport(rows)
    const pixxel = report.find((c) => c.name === 'Pixxel')
    expect(pixxel?.rows).toEqual([1, 8])
    expect(pixxel?.events.map((e) => e.text)).toEqual([
      'round Seed 2023-03-15',
      'investment $50,000 priced',
      'round Series B 2024-06-20',
      'investment $30,000 priced',
      'mark $120,000 2025-12-31',
    ])
  })
})

describe('the mapping step', () => {
  it('assigns a field, and takes it from the column that held it', () => {
    const m = autoMapLedger(['Company', 'Date', 'Amount', 'Other'])
    const out = assignLedgerField(m, 'amount', 3)
    expect(out.mapping[2]).toEqual({ target: 'ignore' })
    expect(out.mapping[3]).toEqual({ target: 'ledger', field: 'amount' })
    const off = assignLedgerField(out.mapping, 'amount', null)
    expect(off.mapping[3]).toEqual({ target: 'ignore' })
  })

  it('a new date column joins the order the others share', () => {
    const m = decide(autoMapLedger(['Company', 'Date', 'Amount', 'As of']), {
      kind: 'dateOrder',
      order: 'dmy',
    })
    const cleared = assignLedgerField(m, 'markDate', null).mapping
    const back = assignLedgerField(cleared, 'markDate', 3).mapping
    expect(back[3]).toEqual({
      target: 'ledger',
      field: 'markDate',
      dateOrder: 'dmy',
    })
  })

  it('summarises what the decisions panel shows', () => {
    const s = summarizeLedger(rowsOf(MESSY_ROWS), autoMapLedger(MESSY_HEADER))
    expect(s.instruments.map((v) => [v.raw, v.rows, v.resolution])).toEqual([
      ['SAFE', 1, null],
      ['Priced', 5, 'priced'],
      ['Post-money SAFE', 1, 'safe_post_money'],
    ])
    expect(s.marksWithoutDate).toBe(1)
    expect(s.dates).toEqual({ ambiguous: 1, flips: 1 })
    expect(s.groups).toMatchObject({ company: 7, round: 5, cheque: 7, mark: 2 })
    // SAFE, marks as of, date order.
    expect(s.open).toBe(3)
  })

  it('draws what row 1 becomes, and the columns each line reads', () => {
    const m = autoMapLedger(UNIVERSAL_HEADER)
    const cheque = LEDGER_LINES.find((l) => l.label.startsWith('Date'))
    const money = LEDGER_LINES.find((l) => l.label.startsWith('Raised'))
    if (!cheque || !money) throw new Error('lines')
    expect(lineBecomes(cheque, UNIVERSAL_ROWS[0], m)).toBe(
      '2023-03-15 · $50,000 · USD',
    )
    expect(lineColumns(cheque, m)).toBe('B · C · D')
    expect(lineBecomes(money, UNIVERSAL_ROWS[0], m)).toBe('$5M · $20M pre')
  })

  it('reads a discount as a fraction', () => {
    expect(readDiscount('20%')).toEqual({ kind: 'ok', value: 0.2 })
    expect(readDiscount('0.15')).toEqual({ kind: 'ok', value: 0.15 })
    expect(readDiscount('20')).toEqual({ kind: 'ok', value: 0.2 })
  })
})
