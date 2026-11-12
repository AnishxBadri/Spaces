import { describe, expect, it } from 'vitest'
import { decodeValue, valueValidator } from './registry'
import type { AttributeDef } from './registry'

/**
 * Characterisation of `valueValidator`: for every attribute type, a table of
 * values — valid, each kind of invalid, and the edges — with the verdict, the
 * stored value on accept and the first issue's message on refuse. The
 * message is what the record page, the import preview and the attribute
 * dialog print, so the snapshot pins the words as well as the verdict.
 */

type Def = Pick<AttributeDef, 'type' | 'options'>

const verdict = (def: Def, value: unknown, held?: unknown) => {
  const parsed = decodeValue(valueValidator(def, held), value)
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: parsed.message }
}

const UUID = '7f8c2b1e-4c1d-4b6e-9a3f-2d1e0c9b8a7f'
const long = (n: number) => 'a'.repeat(n)

const options = [
  { id: 'seed', label: 'Seed' },
  { id: 'series_a', label: 'Series A' },
  { id: 'angel', label: 'Angel', archived: true },
]

/** The edges every type is fed, beside its own cases. */
const EDGES: ReadonlyArray<unknown> = [
  '',
  ' ',
  null,
  undefined,
  0,
  5,
  '5',
  true,
  [],
  ['x'],
  {},
  Number.NaN,
  Number.POSITIVE_INFINITY,
]

const TABLE: ReadonlyArray<{
  name: string
  def: Def
  cases: ReadonlyArray<unknown>
  held?: ReadonlyArray<{ held: unknown; value: unknown }>
}> = [
  {
    name: 'text',
    def: { type: 'text', options: {} },
    cases: ['hello', '  padded  ', long(2000), long(2001)],
  },
  {
    name: 'number',
    def: { type: 'number', options: {} },
    cases: [-1.5, 1e21, Number.MAX_SAFE_INTEGER, '1.5', [5]],
  },
  {
    name: 'currency',
    def: { type: 'currency', options: { code: 'USD' } },
    cases: [-1.5, 1000000.25, '1000'],
  },
  {
    name: 'rating',
    def: { type: 'rating', options: {} },
    cases: [1, 3, 6, -1, 2.5, '3'],
  },
  {
    name: 'rating max 10',
    def: { type: 'rating', options: { max: 10 } },
    cases: [10, 11, 1],
  },
  {
    name: 'date',
    def: { type: 'date', options: {} },
    cases: [
      '2026-07-30',
      '30/07/2026',
      '2026-7-30',
      '2026-13-45',
      ' 2026-07-30',
      '2026-07-30T00:00:00Z',
      20260730,
      'P7D',
    ],
  },
  {
    name: 'checkbox',
    def: { type: 'checkbox', options: {} },
    cases: [false, 'true', 1],
  },
  {
    name: 'select',
    def: { type: 'select', options: { options } },
    cases: ['seed', 'ipo', 'Seed', 'angel', ['seed']],
    held: [
      { held: 'angel', value: 'angel' },
      { held: 'seed', value: 'angel' },
      { held: ['angel'], value: 'angel' },
    ],
  },
  {
    name: 'select without options',
    def: { type: 'select', options: {} },
    cases: ['seed'],
  },
  {
    name: 'status',
    def: { type: 'status', options: { options } },
    cases: ['seed', 'ipo', 'angel'],
  },
  {
    name: 'multi_select',
    def: { type: 'multi_select', options: { options } },
    cases: [
      ['seed', 'series_a'],
      ['seed', 'seed'],
      'seed',
      ['ipo'],
      ['seed', 'ipo'],
      ['angel'],
      [5],
      Array.from({ length: 51 }, () => 'seed'),
      Array.from({ length: 51 }, () => 'ipo'),
    ],
    held: [
      { held: ['angel'], value: ['angel', 'seed'] },
      { held: 'angel', value: ['angel'] },
    ],
  },
  {
    name: 'multi_select without options',
    def: { type: 'multi_select', options: {} },
    cases: [['seed']],
  },
  {
    name: 'domain',
    def: { type: 'domain', options: {} },
    cases: [
      'acme.io',
      'not a domain',
      'gmail.com',
      ' ACME.io ',
      long(255),
      long(256),
      ['acme.io'],
    ],
  },
  {
    name: 'domain identity',
    def: { type: 'domain', options: { identityKey: 'domain' } },
    cases: ['acme.io', 'gmail.com', ' ACME.io ', 'not a domain', long(256)],
  },
  {
    name: 'domain multi',
    def: { type: 'domain', options: { multi: true } },
    cases: [
      ['acme.io', 'acme.io'],
      [' https://www.Acme.io/about '],
      ['acme.io', 'ACME.io'],
      'acme.io',
      [5],
      [long(256)],
      Array.from({ length: 51 }, (_, i) => `d${i}.io`),
    ],
  },
  {
    name: 'domain multi identity',
    def: { type: 'domain', options: { multi: true, identityKey: 'domain' } },
    cases: [
      ['acme.io', 'ACME.IO', 'www.acme.io'],
      [' https://www.acme.io/about '],
      ['gmail.com'],
      ['acme.io', 'gmail.com'],
      ['not a domain'],
      [''],
      [' '],
      'acme.io',
      Array.from({ length: 51 }, (_, i) => `d${i}.io`),
    ],
  },
  {
    name: 'email',
    def: { type: 'email', options: {} },
    cases: [
      'ana@acme.io',
      'Ana@Acme.io',
      'not an email',
      'ana@',
      ' ana@acme.io ',
      `${long(250)}@acme.io`,
      `${long(300)}`,
      ['ana@acme.io'],
    ],
  },
  {
    name: 'email identity',
    def: { type: 'email', options: { identityKey: 'email' } },
    cases: ['ana@acme.io', 'info@acme.io', 'not an email'],
  },
  {
    name: 'email multi identity',
    def: { type: 'email', options: { multi: true, identityKey: 'email' } },
    cases: [
      ['ana@acme.io', 'Ana@Acme.io'],
      [' ana@acme.io '],
      ['info@acme.io'],
      ['not an email'],
      ['ana@acme.io', 'bad'],
      [''],
      'ana@acme.io',
      [`${long(250)}@acme.io`],
      Array.from({ length: 51 }, (_, i) => `p${i}@acme.io`),
    ],
  },
  {
    name: 'email multi',
    def: { type: 'email', options: { multi: true } },
    cases: [
      ['ana@acme.io', 'ana@acme.io'],
      ['Ana@acme.io', 'ana@acme.io'],
    ],
  },
  {
    name: 'url',
    def: { type: 'url', options: {} },
    cases: [
      'https://acme.io',
      'http://acme.io/a?b=c',
      'acme.io',
      'ftp://acme.io',
      'mailto:ana@acme.io',
      'javascript:alert(1)',
      'https://',
      ' https://acme.io',
      `https://acme.io/${long(480)}`,
      `https://acme.io/${long(490)}`,
    ],
  },
  {
    name: 'url identity linkedin',
    def: { type: 'url', options: { identityKey: 'linkedin' } },
    cases: [
      'https://www.linkedin.com/in/anish/',
      'https://example.com/team',
      'linkedin.com/in/anish',
    ],
  },
  {
    name: 'phone',
    def: { type: 'phone', options: {} },
    cases: [
      '+14155552671',
      '+1 (415) 555-2671',
      ' +44 20 7946 0958 ',
      '4155552671',
      'call me',
      '+1',
      `+${'1'.repeat(16)}`,
      long(41),
      `+1 ${'5'.repeat(38)}`,
    ],
    held: [
      { held: '415-555-2671', value: '415-555-2671' },
      { held: ['415-555-2671'], value: ' 415-555-2671 ' },
    ],
  },
  {
    name: 'phone multi',
    def: { type: 'phone', options: { multi: true } },
    cases: [
      ['+1 415 555 2671', '+14155552671'],
      ['+14155552671', 'call me'],
      '+14155552671',
      Array.from(
        { length: 51 },
        (_, i) => `+1415555${String(i).padStart(4, '0')}`,
      ),
    ],
    held: [{ held: ['415-555-2671'], value: ['415-555-2671', '+14155552671'] }],
  },
  {
    name: 'record_reference',
    def: { type: 'record_reference', options: { targetKind: 'company' } },
    cases: [UUID, UUID.toUpperCase(), 'not-a-uuid', [UUID]],
  },
  {
    name: 'record_reference multi',
    def: {
      type: 'record_reference',
      options: { targetKind: 'person', multi: true },
    },
    cases: [
      [UUID],
      [UUID, UUID],
      UUID,
      ['not-a-uuid'],
      Array.from({ length: 100 }, () => UUID),
      Array.from({ length: 101 }, () => UUID),
    ],
  },
  {
    name: 'actor_reference',
    def: { type: 'actor_reference', options: {} },
    cases: ['user_1', 'current-user', long(64), long(65)],
  },
]

describe('valueValidator, characterised', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const results = [...row.cases, ...EDGES].map((value) => ({
        value,
        ...verdict(row.def, value),
      }))
      const held = (row.held ?? []).map((c) => ({
        held: c.held,
        value: c.value,
        ...verdict(row.def, c.value, c.held),
      }))
      expect({ results, held }).toMatchSnapshot()
    })
  }
})
