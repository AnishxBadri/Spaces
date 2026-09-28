import { describe, expect, it } from 'vitest'
import type { AttributeType, SelectOption } from '../attributes/registry'
import { coerce, summarizeColumn } from './coerce'
import type { CoerceOptions, CoercedValue, Coercion } from './coerce'

/**
 * SPA-166. Every attribute type, the shapes it accepts and the shapes it
 * refuses. No database anywhere: @spaces/core's vitest config loads no env,
 * so this file runs with Postgres stopped by construction.
 */

const ok = (value: CoercedValue): Coercion => ({ ok: true, value })

function reasonOf(out: Coercion): string {
  if (out.ok)
    throw new Error(`expected a refusal, got ${JSON.stringify(out.value)}`)
  return out.reason
}

const accepts = (
  type: AttributeType,
  options: CoerceOptions,
  cases: Array<[string, unknown]>,
) => {
  for (const [raw, value] of cases)
    expect(coerce(type, options, raw), raw).toEqual({ ok: true, value })
}

const refuses = (
  type: AttributeType,
  options: CoerceOptions,
  cases: Array<string>,
) => {
  for (const raw of cases)
    expect(coerce(type, options, raw).ok, raw).toBe(false)
}

const STAGES: Array<SelectOption> = [
  { id: 'pre_lead', label: 'Pre-lead', group: 'active' },
  { id: 'screening', label: 'Screening', group: 'active' },
  { id: 'term_sheet', label: 'Term sheet', group: 'active' },
  { id: 'dead', label: 'Dead', group: 'closed', archived: true },
]

const MODELS: Array<SelectOption> = [
  { id: 'b2b', label: 'B2B' },
  { id: 'b2c', label: 'B2C' },
  { id: 'saas', label: 'SaaS, usage-based' },
  { id: 'old', label: 'Legacy', archived: true },
]

describe('blank cells', () => {
  it('are no value for every type — never 0, never a failure', () => {
    const types: Array<AttributeType> = [
      'text',
      'number',
      'currency',
      'date',
      'checkbox',
      'select',
      'multi_select',
      'status',
      'domain',
      'email',
      'url',
      'phone',
      'rating',
      'record_reference',
      'actor_reference',
    ]
    for (const t of types) {
      expect(coerce(t, {}, ''), t).toEqual({ ok: true, value: null })
      expect(coerce(t, {}, '   '), t).toEqual({ ok: true, value: null })
      expect(coerce(t, {}, null), t).toEqual({ ok: true, value: null })
    }
  })
})

describe('text', () => {
  it('accepts any string, trimmed', () => {
    accepts('text', {}, [
      ['  Bengaluru ', 'Bengaluru'],
      ['TBD', 'TBD'],
    ])
  })
  it('refuses a cell longer than the registry allows', () => {
    refuses('text', {}, ['x'.repeat(2001)])
  })
})

describe('number', () => {
  it('strips thousands separators, currency marks and parenthesised negatives', () => {
    accepts('number', {}, [
      ['42', 42],
      ['1,250', 1250],
      ['1,250,000.5', 1250000.5],
      ['1,25,000', 125000],
      ['(400)', -400],
      ['-3.25', -3.25],
      ['$1,250', 1250],
      ['0', 0],
    ])
  })
  it('refuses placeholders, words and European or malformed grouping', () => {
    refuses('number', {}, [
      'TBD',
      'n/a',
      '12,5',
      '1,2,3',
      '1.250,00',
      '5k',
      '12%',
      '--4',
    ])
    expect(reasonOf(coerce('number', {}, 'TBD'))).toBe('"TBD" is not a number')
  })
})

describe('currency', () => {
  const usd: CoerceOptions = { code: 'USD' }
  const inr: CoerceOptions = { code: 'INR' }

  it('(1,250.00) becomes -1250 and ₹1,25,000 becomes 125000', () => {
    expect(coerce('currency', usd, '(1,250.00)')).toEqual(ok(-1250))
    expect(coerce('currency', inr, '₹1,25,000')).toEqual(ok(125000))
  })
  it('reads the marks a money column is written with', () => {
    accepts('currency', usd, [
      ['$1,250', 1250],
      ['US$ 2,000', 2000],
      ['-$400', -400],
      ['$-400', -400],
      ['($400)', -400],
      ['USD 1,000', 1000],
      ['1,000 USD', 1000],
      ['€99.50', 99.5],
    ])
    accepts('currency', inr, [
      ['Rs. 1,00,00,000', 10000000],
      ['INR 12,34,567', 1234567],
      ['₹ 5,000', 5000],
    ])
  })
  it('TBD becomes a reason, never 0', () => {
    const out = coerce('currency', usd, 'TBD')
    expect(out.ok).toBe(false)
    expect(reasonOf(out)).toContain('"TBD"')
    refuses('currency', usd, ['$', 'ABC123', '(-400)', 'about $5m'])
  })
})

describe('rating', () => {
  it('accepts whole numbers from 1 to options.max', () => {
    accepts('rating', {}, [
      ['1', 1],
      ['5', 5],
      ['4.0', 4],
    ])
    accepts('rating', { max: 10 }, [['9', 9]])
  })
  it('refuses out of bounds, fractions and words', () => {
    refuses('rating', {}, ['0', '6', '3.5', 'great'])
    expect(reasonOf(coerce('rating', { max: 3 }, '4'))).toBe(
      '"4" is outside 1 to 3',
    )
  })
})

describe('date', () => {
  it('parses ISO with or without a declared order', () => {
    accepts('date', {}, [
      ['2026-03-04', '2026-03-04'],
      ['2026-3-4', '2026-03-04'],
      ['2026/03/04', '2026-03-04'],
      ['2026-03-04T10:30:00Z', '2026-03-04'],
    ])
  })
  it('refuses an ambiguous slashed date when no order is declared', () => {
    expect(reasonOf(coerce('date', {}, '03/04/2026'))).toContain(
      'declare day-first or month-first',
    )
    // Never sniffed — even a value only one order could read.
    refuses('date', {}, ['25/12/2026'])
  })
  it('reads the declared order', () => {
    accepts('date', { dateOrder: 'dmy' }, [
      ['03/04/2026', '2026-04-03'],
      ['25.12.2026', '2026-12-25'],
    ])
    accepts('date', { dateOrder: 'mdy' }, [
      ['03/04/2026', '2026-03-04'],
      ['12-25-2026', '2026-12-25'],
    ])
  })
  it('refuses impossible dates, two-digit years and words', () => {
    refuses('date', { dateOrder: 'mdy' }, ['25/12/2026', '02/30/2026'])
    refuses('date', { dateOrder: 'dmy' }, [
      '03/04/26',
      'next week',
      '2026-13-01',
    ])
    refuses('date', {}, ['2026-02-29', 'March 4, 2026'])
    accepts('date', {}, [['2028-02-29', '2028-02-29']])
  })
})

describe('checkbox', () => {
  it('accepts yes/no, true/false, 1/0 in any case', () => {
    accepts('checkbox', {}, [
      ['yes', true],
      ['No', false],
      ['TRUE', true],
      ['false', false],
      ['1', true],
      ['0', false],
    ])
  })
  it('refuses anything else', () => {
    refuses('checkbox', {}, ['y', 'maybe', 'x', '2'])
  })
})

describe('select and status', () => {
  for (const type of ['select', 'status'] as const) {
    it(`${type}: matches option labels case-insensitively, answering the id`, () => {
      accepts(type, { options: STAGES }, [
        ['Screening', 'screening'],
        ['  term SHEET ', 'term_sheet'],
        ['pre-lead', 'pre_lead'],
      ])
    })
    it(`${type}: refuses an unknown label by name and never mints one`, () => {
      const options = { options: STAGES }
      const out = coerce(type, options, 'Seed')
      expect(reasonOf(out)).toBe('"Seed" is not an option of this attribute')
      expect(options.options).toHaveLength(4)
      // An id is not a label.
      refuses(type, options, ['term_sheet'])
    })
    it(`${type}: refuses an archived option and an attribute with none`, () => {
      expect(reasonOf(coerce(type, { options: STAGES }, 'dead'))).toContain(
        'archived',
      )
      refuses(type, {}, ['Screening'])
    })
  }
})

describe('multi_select', () => {
  it('splits on commas and semicolons, matching each label', () => {
    accepts('multi_select', { options: MODELS }, [
      ['B2B', ['b2b']],
      ['b2b, B2C', ['b2b', 'b2c']],
      ['B2C; b2b; B2C', ['b2c', 'b2b']],
      ['SaaS, usage-based', ['saas']],
    ])
  })
  it('refuses the whole cell, naming each unknown label', () => {
    expect(
      reasonOf(coerce('multi_select', { options: MODELS }, 'B2B, Fintech')),
    ).toBe('"Fintech" is not an option of this attribute')
    expect(
      reasonOf(coerce('multi_select', { options: MODELS }, 'Fintech; AI; B2B')),
    ).toBe('"Fintech", "AI" are not options of this attribute')
    refuses('multi_select', { options: MODELS }, ['B2B, legacy'])
    refuses('multi_select', {}, ['B2B'])
  })
})

describe('domain', () => {
  it('delegates to the identity normalizers: registrable domain, lowercase', () => {
    accepts('domain', {}, [
      ['https://www.Acme.com/about', 'acme.com'],
      ['app.deel.com', 'deel.com'],
      ['gmail.com', 'gmail.com'],
    ])
  })
  it('refuses non-domains, and free mail on an identity-backed attribute', () => {
    refuses('domain', {}, ['not a domain', 'localhost', 'TBD'])
    expect(
      reasonOf(coerce('domain', { identityKey: 'domain' }, 'gmail.com')),
    ).toContain('free mail')
    accepts('domain', { identityKey: 'domain' }, [
      ['www.stripe.com', 'stripe.com'],
    ])
  })
})

describe('email', () => {
  it('accepts a well-formed address, stored as written', () => {
    accepts('email', {}, [
      [' Founder@Startup.io ', 'Founder@Startup.io'],
      ['first.last+deals@gmail.com', 'first.last+deals@gmail.com'],
    ])
  })
  it('refuses what normalizeEmail refuses', () => {
    refuses('email', {}, [
      'founder',
      'founder@',
      '@startup.io',
      'founder@localhost',
    ])
  })
})

describe('url', () => {
  it('delegates to normalizeUrl: absolute http(s), a bare host gains https', () => {
    accepts('url', {}, [
      ['https://acme.com/team', 'https://acme.com/team'],
      ['acme.com', 'https://acme.com/'],
    ])
  })
  it('refuses non-URLs, and a non-LinkedIn page on a LinkedIn identity', () => {
    refuses('url', {}, ['not a url', 'ftp://acme.com', 'TBD'])
    accepts('url', { identityKey: 'linkedin' }, [
      ['linkedin.com/in/anish', 'https://linkedin.com/in/anish'],
    ])
    refuses('url', { identityKey: 'linkedin' }, ['https://twitter.com/anish'])
  })
})

describe('phone', () => {
  it('accepts a plausible number, stored as written', () => {
    accepts('phone', {}, [
      ['+91 98450 11223', '+91 98450 11223'],
      ['(415) 555-0134', '(415) 555-0134'],
    ])
  })
  it('refuses words and implausible lengths', () => {
    refuses('phone', {}, ['call me', '12345', 'TBD'])
  })
})

describe('record_reference and actor_reference', () => {
  it('are refused here — import-6 matches them', () => {
    refuses('record_reference', { targetKind: 'company' }, ['Acme'])
    refuses('actor_reference', {}, ['anish@fund.example'])
    expect(reasonOf(coerce('record_reference', {}, 'Acme'))).toContain(
      'next step',
    )
  })
})

describe('summarizeColumn', () => {
  it('counts what parses and names each failing row with its reason', () => {
    const amounts = [
      ...Array.from({ length: 19 }, () => '$1,250'),
      '(400)',
      'TBD',
      '',
      ...Array.from({ length: 18 }, () => '2,000'),
      'n/a',
    ]
    const summary = summarizeColumn('currency', { code: 'USD' }, amounts)
    expect(summary.total).toBe(40)
    expect(summary.parsed).toBe(38)
    expect(summary.failures).toEqual([
      { row: 20, raw: 'TBD', reason: '"TBD" is not a number' },
      { row: 40, raw: 'n/a', reason: '"n/a" is not a number' },
    ])
  })
  it('shows a column where nothing parses', () => {
    const summary = summarizeColumn('status', { options: STAGES }, [
      'Seed',
      'Seed',
      null,
    ])
    expect(summary).toMatchObject({ parsed: 0, total: 2 })
    expect(summary.failures.map((f) => f.reason)).toEqual([
      '"Seed" is not an option of this attribute',
      '"Seed" is not an option of this attribute',
    ])
  })
})
