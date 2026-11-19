import { describe, expect, it } from 'vitest'
import { readAiConfig, readOptionProposals } from './attribute-ai'
import { readKeyTerms } from './key-terms'

/**
 * The model-answer and stored-config readers that drop what they cannot
 * read rather than refusing it: what each keeps, and in what shape. Recorded
 * against the zod readers before they were Effect schemas.
 */

class Holder {}

const sym = Symbol('s')

const term = (value: unknown, refs: unknown = ['doc:1#p2']) => ({
  value,
  refs,
})

const KEY_TERM_ANSWERS: ReadonlyArray<[string, unknown]> = [
  ['null', null],
  ['a string', 'x'],
  ['an array', [term('1x')]],
  ['a date', new Date(0)],
  ['a map', new Map([['pro_rata', term('Yes')]])],
  ['a class instance', Object.assign(new Holder(), { pro_rata: term('Yes') })],
  [
    'a null-prototype answer',
    Object.assign(Object.create(null), { pro_rata: term('Yes') }),
  ],
  ['an inherited term', Object.create({ pro_rata: term('Yes') })],
  [
    'a __proto__ key',
    JSON.parse(
      '{"__proto__": {"value": "x", "refs": ["a"]}, "pro_rata": {"value": "Yes", "refs": ["a"]}}',
    ),
  ],
  ['a symbol key', { [sym]: 1, pro_rata: term('Yes') }],
  [
    'a full answer',
    {
      liquidation_preference: term('1x non-participating'),
      pro_rata: term('  Yes,\n  for   Series A  ', [' a ', 'a', '', 'b']),
      governing_law: term('Delaware'),
    },
  ],
  ['an unknown term', { carry: term('20%'), pro_rata: term('Yes') }],
  ['a null term', { pro_rata: null }],
  ['an undefined term', { pro_rata: undefined }],
  ['a bare string term', { pro_rata: 'Yes' }],
  ['a term with an extra key', { pro_rata: { ...term('Yes'), why: 'x' } }],
  ['a term without refs', { pro_rata: { value: 'Yes' } }],
  ['a term with null refs', { pro_rata: term('Yes', null) }],
  ['a term with empty refs', { pro_rata: term('Yes', []) }],
  ['a term with blank refs', { pro_rata: term('Yes', [' ', '']) }],
  ['a term with a numeric ref', { pro_rata: term('Yes', [1]) }],
  ['a term with a numeric value', { pro_rata: term(5) }],
  ['a term with an empty value', { pro_rata: term('  ') }],
  ['a term saying not found', { pro_rata: term('Not found.') }],
  ['a term saying n/a', { pro_rata: term('N/A') }],
  ['a term that is a date', { pro_rata: new Date(0) }],
  [
    'a term that is a class instance',
    { pro_rata: Object.assign(new Holder(), term('Yes')) },
  ],
  ['a term with inherited fields', { pro_rata: Object.create(term('Yes')) }],
  ['a term that is an array', { pro_rata: ['Yes', ['a']] }],
  ['a term from the other kind', { litigation: term('None pending') }],
]

describe('readKeyTerms, characterised', () => {
  for (const [name, raw] of KEY_TERM_ANSWERS) {
    it(name, () => {
      expect(readKeyTerms('legal', raw)).toMatchSnapshot()
    })
  }
})

const ai = { mode: 'classify', prompt: 'Which sector?', lane: 'classify' }

const STORED_CONFIGS: ReadonlyArray<[string, string, unknown]> = [
  ['a classify config', 'select', ai],
  ['a classify config on text', 'text', ai],
  [
    'with variables',
    'text',
    {
      mode: 'prompt',
      prompt: 'Read {{a}}',
      variables: ['a'],
      lane: 'synthesize',
    },
  ],
  [
    'with undefined variables',
    'text',
    {
      mode: 'summarize',
      prompt: 'x',
      variables: undefined,
      lane: 'synthesize',
    },
  ],
  [
    'with null variables',
    'text',
    { ...ai, mode: 'summarize', variables: null },
  ],
  [
    'with a numeric variable',
    'text',
    { ...ai, mode: 'summarize', variables: [1] },
  ],
  ['with an extra key', 'select', { ...ai, extra: 1 }],
  [
    'with the lane of another mode',
    'text',
    { ...ai, mode: 'summarize', lane: 'research' },
  ],
  ['with an unknown lane', 'select', { ...ai, lane: 'extract' }],
  ['with an unknown mode', 'select', { ...ai, mode: 'guess' }],
  ['without a prompt', 'select', { mode: 'classify', lane: 'classify' }],
  ['with an empty prompt', 'select', { ...ai, prompt: '' }],
  ['with a numeric prompt', 'select', { ...ai, prompt: 5 }],
  ['a date', 'select', new Date(0)],
  ['a class instance', 'select', Object.assign(new Holder(), ai)],
  ['inherited fields', 'select', Object.create(ai)],
  ['a string', 'select', 'classify'],
  ['null', 'select', null],
  ['an array', 'select', [ai]],
]

describe('readAiConfig, characterised', () => {
  for (const [name, type, stored] of STORED_CONFIGS) {
    it(name, () => {
      expect(readAiConfig({ type, options: { ai: stored } })).toMatchSnapshot()
    })
  }
  it('no options', () => {
    expect(readAiConfig({ type: 'select', options: null })).toBeNull()
  })
})

const RATIONALES: ReadonlyArray<[string, string | null]> = [
  ['null', null],
  ['one line', 'Proposed new option "Fintech" for Sector (sector).'],
  [
    'an escaped quote',
    'Proposed new option "SPV \\"B\\"" for Type (fund_type).',
  ],
  [
    'a unicode escape',
    'Proposed new option "\\u00e9t\\u00e9" for Season (season).',
  ],
  ['an empty label', 'Proposed new option "" for Sector (sector).'],
  ['a bad escape', 'Proposed new option "a\\qb" for Sector (sector).'],
  ['an unquoted label', 'Proposed new option Fintech for Sector (sector).'],
  [
    'two lines among prose',
    'The deck says so.\nProposed new option "A" for X (x).\nAnd more.\nProposed new option "B" for Y (y).',
  ],
]

describe('readOptionProposals, characterised', () => {
  for (const [name, rationale] of RATIONALES) {
    it(name, () => {
      expect(readOptionProposals(rationale)).toMatchSnapshot()
    })
  }
})
