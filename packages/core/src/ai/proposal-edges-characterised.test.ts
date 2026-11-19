import { describe, expect, it } from 'vitest'
import { toPatch, validateProposal } from './schema'
import type { Proposal, SchemaAttribute } from './schema'

/**
 * The edges of the AI answer check, recorded against the zod claim and
 * envelope checks before they were Effect schemas: objects that are not
 * plain, keys a JSON body can carry (`__proto__`) or cannot (a symbol),
 * numbers at their limits, blanks, nesting, and which issue a claim with
 * several wrong things is refused for. Each row keeps the verdict, the words,
 * the decoded proposal and what `toPatch` holds aside, plus the prototype of
 * every decoded value, since a class instance read as a claim must come back
 * a plain object.
 */

const field = (value: unknown, extra: Record<string, unknown> = {}) => ({
  value,
  refs: ['doc:1'],
  confidence: 0.8,
  ...extra,
})

const registry: Array<SchemaAttribute> = [
  {
    slug: 'summary',
    name: 'Summary',
    type: 'text',
    options: {},
    archived: false,
  },
  {
    slug: 'company',
    name: 'Company',
    type: 'record_reference',
    options: { targetKind: 'company' },
    archived: false,
  },
  {
    slug: 'investors',
    name: 'Investors',
    type: 'record_reference',
    options: { targetKind: 'company', multi: true },
    archived: false,
  },
  {
    slug: 'ceo',
    name: 'CEO',
    type: 'record_reference',
    options: { targetKind: 'person' },
    archived: false,
  },
]

class Claim {
  name = 'Acme'
}

class Envelope {
  value = 'x'
  refs = ['doc:1']
  confidence = 0.5
}

const nullProto = <T extends object>(o: T): T =>
  Object.assign(Object.create(null), o)

const long = (n: number) => 'a'.repeat(n)

const sym = Symbol('s')

const PROPOSALS: ReadonlyArray<[string, unknown]> = [
  // The answer itself.
  ['a number', 5],
  ['undefined', undefined],
  ['a function', () => 1],
  ['a map', new Map([['summary', field('x')]])],
  ['a class instance', new Envelope()],
  ['a null-prototype answer', nullProto({ summary: field('x') })],
  [
    'an answer with a __proto__ key',
    JSON.parse(
      '{"__proto__": {"value": "x", "refs": [], "confidence": 1}, "summary": {"value": "y", "refs": [], "confidence": 1}}',
    ),
  ],
  ['an answer with a symbol key', { [sym]: 1, summary: field('x') }],
  ['an answer with a constructor key', { constructor: 1, summary: field('x') }],
  ['an answer with an inherited field', Object.create({ summary: field('x') })],
  ['an answer with an undefined field', { summary: undefined }],
  ['an answer with a null field', { summary: null }],

  // The envelope.
  ['an envelope whose value is undefined', { summary: field(undefined) }],
  ['an envelope whose value is null', { summary: field(null) }],
  ['an envelope without refs', { summary: { value: 'x', confidence: 1 } }],
  ['an envelope without confidence', { summary: { value: 'x', refs: [] } }],
  ['an envelope with empty refs', { summary: field('x', { refs: [] }) }],
  [
    'an envelope with repeated and blank refs',
    { summary: field('x', { refs: ['a', 'a', ''] }) },
  ],
  ['an envelope with nested refs', { summary: field('x', { refs: [['a']] }) }],
  ['an envelope with null refs', { summary: field('x', { refs: null }) }],
  ['an envelope with a string ref', { summary: field('x', { refs: 'a' }) }],
  ['confidence 0', { summary: field('x', { confidence: 0 }) }],
  ['confidence -0', { summary: field('x', { confidence: -0 }) }],
  ['confidence 1', { summary: field('x', { confidence: 1 }) }],
  [
    'confidence just over 1',
    { summary: field('x', { confidence: 1.0000001 }) },
  ],
  ['confidence just under 0', { summary: field('x', { confidence: -0.0001 }) }],
  [
    'confidence Infinity',
    { summary: field('x', { confidence: Number.POSITIVE_INFINITY }) },
  ],
  [
    'confidence -Infinity',
    { summary: field('x', { confidence: Number.NEGATIVE_INFINITY }) },
  ],
  ['confidence as a string', { summary: field('x', { confidence: '0.5' }) }],
  ['confidence null', { summary: field('x', { confidence: null }) }],
  ['confidence as a boolean', { summary: field('x', { confidence: true }) }],
  ['an envelope that is a date', { summary: new Date(0) }],
  ['an envelope that is a map', { summary: new Map() }],
  ['an envelope that is a class instance', { summary: new Envelope() }],
  ['an envelope that is an array', { summary: ['x', ['doc:1'], 0.5] }],
  ['a null-prototype envelope', { summary: nullProto(field('x')) }],
  [
    'an envelope with a __proto__ key',
    {
      summary: JSON.parse(
        '{"value": "x", "refs": [], "confidence": 1, "__proto__": {"a": 1}}',
      ),
    },
  ],
  ['an envelope with a symbol key', { summary: { ...field('x'), [sym]: 1 } }],
  [
    'an envelope with an undefined extra key',
    { summary: field('x', { why: undefined }) },
  ],
  ['an envelope with inherited fields', { summary: Object.create(field('x')) }],

  // One claim.
  ['a name of 500', { company: field({ name: long(500) }) }],
  ['a name of 500 padded', { company: field({ name: ` ${long(500)} ` }) }],
  ['an empty name', { company: field({ name: '' }) }],
  ['a numeric name', { company: field({ name: 5 }) }],
  ['a null name', { company: field({ name: null }) }],
  ['an undefined name', { company: field({ name: undefined }) }],
  ['an empty domain', { company: field({ name: 'Acme', domain: '' }) }],
  [
    'a padded domain',
    { company: field({ name: 'Acme', domain: ' acme.io ' }) },
  ],
  ['a null domain', { company: field({ name: 'Acme', domain: null }) }],
  [
    'an undefined domain',
    { company: field({ name: 'Acme', domain: undefined }) },
  ],
  ['a domain of 255', { company: field({ name: 'Acme', domain: long(255) }) }],
  [
    'a padded email',
    { company: field({ name: 'Acme', email: ' bo@acme.io ' }) },
  ],
  [
    'a mixed-case email',
    { company: field({ name: 'Acme', email: 'Bo@Acme.IO' }) },
  ],
  ['an empty email', { company: field({ name: 'Acme', email: '' }) }],
  [
    'an email without a dot',
    { company: field({ name: 'Acme', email: 'bo@acme' }) },
  ],
  [
    'an email with a plus',
    { company: field({ name: 'Acme', email: 'bo+x@acme.io' }) },
  ],
  [
    'an email with two dots',
    { company: field({ name: 'Acme', email: 'b..o@acme.io' }) },
  ],
  [
    'an email with a non-ascii letter',
    { company: field({ name: 'Acme', email: 'bø@acme.io' }) },
  ],
  [
    'an email of 255',
    { company: field({ name: 'Acme', email: `${long(247)}@acme.io` }) },
  ],
  [
    'an email of 256',
    { company: field({ name: 'Acme', email: `${long(248)}@acme.io` }) },
  ],
  [
    'an email of 256 without a dot',
    { company: field({ name: 'Acme', email: `${long(252)}@acm` }) },
  ],
  [
    'an extra key, a missing name and a bad email',
    { company: field({ id: 1, email: 'nope' }) },
  ],
  [
    'an inherited extra key',
    {
      company: field(Object.assign(Object.create({ id: 'x' }), { name: 'A' })),
    },
  ],
  [
    'a non-enumerable extra key',
    {
      company: field(
        Object.defineProperty({ name: 'A' }, 'id', {
          value: 'x',
          enumerable: false,
        }),
      ),
    },
  ],
  [
    'an envelope with an inherited extra key',
    {
      summary: Object.assign(Object.create({ why: 'y' }), field('x')),
    },
  ],
  [
    'an answer with a non-enumerable symbol key',
    Object.defineProperty({ summary: field('x') }, sym, {
      value: 1,
      enumerable: false,
    }),
  ],
  ['an answer with a numeric key', { 1: field('x'), summary: field('y') }],
  [
    'a padded linkedin',
    { company: field({ name: 'Acme', linkedin: ' linkedin.com/x ' }) },
  ],
  ['a blank linkedin', { company: field({ name: 'Acme', linkedin: '  ' }) }],
  [
    'a linkedin of 501',
    { company: field({ name: 'Acme', linkedin: long(501) }) },
  ],
  ['a role on a company', { company: field({ name: 'Acme', role: ' CFO ' }) }],
  ['a role of 201', { company: field({ name: 'Acme', role: long(201) }) }],
  [
    'a person claim with a domain',
    { ceo: field({ name: 'Ana', domain: 'x' }) },
  ],
  ['a claim that is a map', { company: field(new Map([['name', 'Acme']])) }],
  ['a claim that is a class instance', { company: field(new Claim()) }],
  ['a null-prototype claim', { company: field(nullProto({ name: 'Acme' })) }],
  [
    'a claim with an inherited name',
    { company: field(Object.create({ name: 'Acme' })) },
  ],
  [
    'a claim with a __proto__ key',
    { company: field(JSON.parse('{"name": "Acme", "__proto__": {"a": 1}}')) },
  ],
  ['a claim with a symbol key', { company: field({ name: 'Acme', [sym]: 1 }) }],
  [
    'a claim with a constructor key',
    { company: field({ name: 'Acme', constructor: 'x' }) },
  ],
  [
    'a claim with an undefined extra key',
    { company: field({ name: 'Acme', id: undefined }) },
  ],
  ['a claim that is a function', { company: field(() => 1) }],
  ['a claim that is a number', { company: field(5) }],
  ['a claim that is undefined', { company: field(undefined) }],

  // Which issue a claim is refused for.
  ['a bad name and a bad domain', { company: field({ name: '', domain: 5 }) }],
  ['a bad email before a missing name', { company: field({ email: 'nope' }) }],
  [
    'a bad role and a bad linkedin',
    { ceo: field({ name: 'Ana', role: '', linkedin: '' }) },
  ],
  [
    'an extra key, a bad role and a bad linkedin',
    { ceo: field({ zz: 1, name: 'Ana', linkedin: '', role: '' }) },
  ],
  [
    'two extra keys and nothing else wrong',
    { company: field({ b: 1, name: 'Acme', a: 2 }) },
  ],
  [
    'an extra key that is an attribute key',
    { company: field({ name: 'Acme', value: 'x' }) },
  ],
  [
    'a long invalid email',
    { company: field({ name: 'Acme', email: long(300) }) },
  ],
  ['a long blank name', { company: field({ name: ` ${' '.repeat(600)} ` }) }],

  // A list of claims.
  ['an empty list', { investors: field([]) }],
  [
    'a list of 100',
    { investors: field(Array.from({ length: 100 }, () => ({ name: 'A' }))) },
  ],
  ['a nested list', { investors: field([[{ name: 'A' }]]) }],
  ['a list holding null', { investors: field([{ name: 'A' }, null]) }],
  ['a list that is a date', { investors: field(new Date(0)) }],
  ['a list that is a map', { investors: field(new Map()) }],
  [
    'a list of 101 with one bad claim at the end',
    {
      investors: field([
        ...Array.from({ length: 100 }, () => ({ name: 'A' })),
        { name: '' },
      ]),
    },
  ],
  [
    'a list with an extra key in its second claim',
    { investors: field([{ name: 'A' }, { name: 'B', id: 'x' }]) },
  ],
  [
    'a list of class instances',
    { investors: field([new Claim(), new Claim()]) },
  ],
  // eslint-disable-next-line no-sparse-arrays -- a hole reads as undefined
  ['a sparse list', { investors: field([{ name: 'A' }, , { name: 'B' }]) }],

  // Several attributes at once.
  [
    'an unknown slug and a bad claim, in input order',
    { company: field({ name: '' }), nope: field('x'), summary: field(5) },
  ],
]

const protoOf = (v: unknown): string => {
  if (typeof v !== 'object' || v === null) return typeof v
  if (Array.isArray(v)) return `array of ${v.map(protoOf).join(', ')}`
  const p: unknown = Object.getPrototypeOf(v)
  if (p === null) return 'null-prototype'
  return p === Object.prototype ? 'plain' : 'other'
}

describe('validateProposal at the edges, characterised', () => {
  for (const [name, raw] of PROPOSALS) {
    it(name, () => {
      const check = validateProposal(registry, raw)
      const patch = check.ok ? toPatch(registry, check.proposal) : null
      const protos = check.ok
        ? Object.fromEntries(
            Object.entries(check.proposal).map(([slug, f]) => [
              slug,
              { field: protoOf(f), value: protoOf(f.value) },
            ]),
          )
        : null
      const keys = check.ok
        ? Object.fromEntries(
            Object.entries(check.proposal).map(([slug, f]) => [
              slug,
              Object.keys(f),
            ]),
          )
        : null
      expect({ check, patch, protos, keys }).toMatchSnapshot()
    })
  }
})

/**
 * `toPatch` reads claims again on its own, from a proposal it is handed: a
 * value that does not read as claims is held aside as nothing at all.
 */
const PROPOSED: ReadonlyArray<[string, Proposal]> = [
  ['a valid claim', { company: field({ name: ' Acme ', domain: 'acme.io' }) }],
  ['a claim list', { investors: field([{ name: 'A' }, { name: 'B ' }]) }],
  ['an invalid claim', { company: field({ name: '' }) }],
  [
    'a list with one invalid claim',
    { investors: field([{ name: 'A' }, { name: '' }]) },
  ],
  ['a claim with an extra key', { company: field({ name: 'A', id: 'x' }) }],
  ['a list on a single reference', { company: field([{ name: 'A' }]) }],
  ['a single claim on a list', { investors: field({ name: 'A' }) }],
  [
    'a list of 101 on a list',
    { investors: field(Array.from({ length: 101 }, () => ({ name: 'A' }))) },
  ],
  [
    'undefined keys dropped',
    {
      company: field({
        name: 'A',
        domain: undefined,
        email: undefined,
        role: undefined,
        linkedin: undefined,
      }),
    },
  ],
  ['a class instance claim', { company: field(new Claim()) }],
  ['an unknown slug', { nope: field({ name: 'A' }) }],
  ['a text value', { summary: field(' as is ') }],
  ['a null claim', { company: field(null) }],
]

describe('toPatch, characterised', () => {
  for (const [name, proposal] of PROPOSED) {
    it(name, () => {
      expect(toPatch(registry, proposal)).toMatchSnapshot()
    })
  }
})
