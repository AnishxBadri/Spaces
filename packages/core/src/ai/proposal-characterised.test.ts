import { describe, expect, it } from 'vitest'
import { toPatch, validateProposal } from './schema'
import type { SchemaAttribute } from './schema'

/**
 * Characterisation of the AI answer check: what `validateProposal` accepts,
 * what it refuses and the words of each refusal, and the claims `toPatch`
 * holds aside. The refusal reaches the review queue as written.
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
    slug: 'rating',
    name: 'Rating',
    type: 'rating',
    options: {},
    archived: false,
  },
  {
    slug: 'sector',
    name: 'Sector',
    type: 'select',
    options: {
      options: [
        { id: 'fintech', label: 'Fintech' },
        { id: 'crypto', label: 'Crypto', archived: true },
      ],
    },
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
    slug: 'founders',
    name: 'Founders',
    type: 'record_reference',
    options: { targetKind: 'person', multi: true },
    archived: false,
  },
  {
    slug: 'owner',
    name: 'Owner',
    type: 'actor_reference',
    options: {},
    archived: false,
  },
  { slug: 'gone', name: 'Gone', type: 'text', options: {}, archived: true },
]

const long = (n: number) => 'a'.repeat(n)

const PROPOSALS: ReadonlyArray<[string, unknown]> = [
  ['not an object', 'text'],
  ['null', null],
  ['an array', [field('x')]],
  ['a date', new Date(0)],
  ['empty', {}],
  ['a valid text', { summary: field('A fund') }],
  ['an unknown slug', { nope: field('x') }],
  ['an archived attribute', { gone: field('x') }],
  ['an owner', { owner: field('user_1') }],
  ['an envelope without value', { summary: { refs: [], confidence: 1 } }],
  ['an envelope with an extra key', { summary: field('x', { why: 'y' }) }],
  ['an envelope with confidence 2', { summary: field('x', { confidence: 2 }) }],
  [
    'an envelope with confidence NaN',
    { summary: field('x', { confidence: Number.NaN }) },
  ],
  ['an envelope with a numeric ref', { summary: field('x', { refs: [1] }) }],
  ['an envelope that is a string', { summary: 'x' }],
  ['a text too long', { summary: field(long(2001)) }],
  ['a rating as a string', { rating: field('3') }],
  ['a rating of 2.5', { rating: field(2.5) }],
  ['an archived option', { sector: field('crypto') }],
  ['an unknown option', { sector: field('defi') }],
  [
    'a company claim',
    { company: field({ name: ' Acme ', domain: 'acme.io' }) },
  ],
  ['a claim with a blank name', { company: field({ name: '  ' }) }],
  ['a claim without a name', { company: field({ domain: 'acme.io' }) }],
  ['a claim with an extra key', { company: field({ name: 'Acme', id: 'x' }) }],
  [
    'a claim with two extra keys',
    { company: field({ name: 'Acme', id: 'x', url: 'y' }) },
  ],
  [
    'a claim with an extra key and a blank name',
    { company: field({ name: ' ', id: 'x' }) },
  ],
  [
    'a claim with an extra key before a bad email',
    { company: field({ id: 'x', name: 'Acme', email: 'nope' }) },
  ],
  [
    'a claim with a bad domain and a bad email',
    { company: field({ name: 'Acme', domain: 5, email: 'nope' }) },
  ],
  ['a claim that is null', { company: field(null) }],
  ['a claim that is a date', { company: field(new Date(0)) }],
  [
    'a claim list with a bad second claim',
    { founders: field([{ name: 'Ana' }, { name: '' }]) },
  ],
  [
    'a claim list of 101 bad claims',
    { founders: field(Array.from({ length: 101 }, () => ({ name: '' }))) },
  ],
  [
    'a claim with a bad email',
    { company: field({ name: 'Acme', email: 'nope' }) },
  ],
  [
    'a claim with a long domain',
    { company: field({ name: 'Acme', domain: long(256) }) },
  ],
  ['a claim with a long name', { company: field({ name: long(501) }) }],
  ['a claim as a string', { company: field('Acme') }],
  [
    'a claim list on a single reference',
    { company: field([{ name: 'Acme' }]) },
  ],
  [
    'a person claim list',
    {
      founders: field([
        {
          name: 'Ana',
          role: ' CEO ',
          linkedin: ' https://linkedin.com/in/ana ',
        },
        { name: 'Bo', email: 'bo@acme.io' },
      ]),
    },
  ],
  [
    'a claim list with a blank role',
    { founders: field([{ name: 'Ana', role: ' ' }]) },
  ],
  ['a claim list of strings', { founders: field(['Ana']) }],
  ['a single claim on a list', { founders: field({ name: 'Ana' }) }],
  [
    'too many claims',
    { founders: field(Array.from({ length: 101 }, () => ({ name: 'A' }))) },
  ],
  [
    'two bad fields at once',
    { summary: field(5), rating: field(9), sector: field('fintech') },
  ],
]

describe('validateProposal, characterised', () => {
  for (const [name, raw] of PROPOSALS) {
    it(name, () => {
      const check = validateProposal(registry, raw)
      const patch = check.ok ? toPatch(registry, check.proposal) : null
      expect({ check, patch }).toMatchSnapshot()
    })
  }
})
