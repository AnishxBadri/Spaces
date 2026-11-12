import { execValidator } from '@tanstack/react-start'
import { describe, expect, it } from 'vitest'
import { input } from './input'

/**
 * The attribute create and update boundaries at their edges, through the
 * validator a server fn runs: the verdict and what the handler receives.
 * Every row held against the zod shapes before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'

const verdict = async (run: () => Promise<unknown>) => {
  try {
    return { ok: true, data: await run() }
  } catch {
    return { ok: false }
  }
}

const update = async (value: unknown) => {
  const { updateAttributeInput } = await import('./attributes')
  return verdict(() => execValidator(input(updateAttributeInput), value))
}

const create = async (value: unknown) => {
  const { createAttributeInput } = await import('./attributes')
  return verdict(() => execValidator(input(createAttributeInput), value))
}

const UPDATE: ReadonlyArray<[string, unknown]> = [
  ['an id alone', { id: ID }],
  ['a bad id', { id: 'x' }],
  ['no id', { name: 'x' }],
  ['a padded name', { id: ID, name: '  Stage  ' }],
  ['a blank name', { id: ID, name: '   ' }],
  ['a long name', { id: ID, name: 'a'.repeat(81) }],
  ['a null description', { id: ID, description: null }],
  ['a padded description', { id: ID, description: ' Why ' }],
  ['a long description', { id: ID, description: 'a'.repeat(501) }],
  ['undefined fields', { id: ID, name: undefined, required: undefined }],
  [
    'flags',
    { id: ID, required: true, archived: false, multi: true, indexed: true },
  ],
  ['a string flag', { id: ID, required: 'yes' }],
  ['a move', { id: ID, move: 'up' }],
  ['a bad move', { id: ID, move: 'left' }],
  [
    'options',
    {
      id: ID,
      options: [
        { label: ' Seed ' },
        { id: 'a', label: 'A', group: 'active', color: 'blue', archived: true },
      ],
    },
  ],
  ['an option with a blank label', { id: ID, options: [{ label: ' ' }] }],
  [
    'an option with a long id',
    { id: ID, options: [{ id: 'a'.repeat(61), label: 'A' }] },
  ],
  [
    'an option with a free colour',
    { id: ID, options: [{ label: 'A', color: '#fff' }] },
  ],
  [
    'an option with a bad group',
    { id: ID, options: [{ label: 'A', group: 'open' }] },
  ],
  [
    'an option with a stray key',
    { id: ID, options: [{ label: 'A', sortOrder: 1 }] },
  ],
  [
    'fifty-one options',
    { id: ID, options: Array.from({ length: 51 }, () => ({ label: 'A' })) },
  ],
  ['a currency code', { id: ID, config: { code: ' eur ' } }],
  ['a bad currency code', { id: ID, config: { code: 'EURO' } }],
  ['a numeric currency code', { id: ID, config: { code: 'E1R' } }],
  ['a rating max', { id: ID, config: { max: 10 } }],
  ['a rating max of 11', { id: ID, config: { max: 11 } }],
  ['a fractional max', { id: ID, config: { max: 2.5 } }],
  ['a precision', { id: ID, config: { precision: 0 } }],
  ['a precision of 7', { id: ID, config: { precision: 7 } }],
  ['a default', { id: ID, config: { default: { a: [1, 'b', null] } } }],
  ['a null default', { id: ID, config: { default: null } }],
  ['a NaN default', { id: ID, config: { default: Number.NaN } }],
  [
    'an ai config',
    { id: ID, config: { ai: { mode: 'classify', prompt: ' Sector? ' } } },
  ],
  ['a null ai config', { id: ID, config: { ai: null } }],
  ['a bad ai mode', { id: ID, config: { ai: { mode: 'guess', prompt: 'x' } } }],
  [
    'an enrichment key',
    { id: ID, config: { enrichmentKey: ' company.location ' } },
  ],
  ['a null enrichment key', { id: ID, config: { enrichmentKey: null } }],
  ['a blank enrichment key', { id: ID, config: { enrichmentKey: '  ' } }],
  ['long text', { id: ID, config: { longText: true } }],
  [
    'immutable fields',
    {
      id: ID,
      type: 'text',
      slug: 's',
      config: { multi: true, targetKind: 'company' },
    },
  ],
  ['a null config', { id: ID, config: null }],
]

const CREATE: ReadonlyArray<[string, unknown]> = [
  ['a text', { name: 'Notes', type: 'text' }],
  ['on an object id', { objectId: ID, name: 'Notes', type: 'text' }],
  ['on a kind', { objectKind: 'company', name: 'Notes', type: 'text' }],
  ['a bad kind', { objectKind: 'fund', name: 'Notes', type: 'text' }],
  ['a bad object id', { objectId: 'x', name: 'Notes', type: 'text' }],
  ['a padded name', { name: '  Notes ', type: 'text' }],
  ['a blank name', { name: ' ', type: 'text' }],
  ['no name', { type: 'text' }],
  ['a bad type', { name: 'Notes', type: 'markdown' }],
  ['no type', { name: 'Notes' }],
  [
    'a padded description',
    { name: 'Notes', type: 'text', description: ' Why ' },
  ],
  ['a null description', { name: 'Notes', type: 'text', description: null }],
  [
    'options',
    {
      name: 'Stage',
      type: 'select',
      options: [{ label: 'A', group: 'active', color: 'red' }],
    },
  ],
  [
    'an option with an id',
    { name: 'Stage', type: 'select', options: [{ id: 'a', label: 'A' }] },
  ],
  [
    'an option archived',
    {
      name: 'Stage',
      type: 'select',
      options: [{ label: 'A', archived: true }],
    },
  ],
  [
    'a config',
    {
      name: 'Raise',
      type: 'currency',
      config: {
        code: 'usd',
        max: 3,
        precision: 2,
        targetKind: 'person',
        targetObjectId: ID,
        multi: true,
        longText: false,
      },
    },
  ],
  [
    'a config with a bad target',
    { name: 'Ref', type: 'record_reference', config: { targetObjectId: 'x' } },
  ],
  [
    'a config with a stray key',
    { name: 'Ref', type: 'text', config: { ai: null } },
  ],
  ['a default', { name: 'Flag', type: 'checkbox', default: true }],
  ['an object default', { name: 'Flag', type: 'checkbox', default: { a: 1 } }],
  [
    'a required flag',
    { name: 'Flag', type: 'checkbox', required: true, indexed: false },
  ],
  ['a stray key', { name: 'Flag', type: 'checkbox', slug: 'flag' }],
]

describe('updateAttributeInput, characterised', () => {
  it.each(UPDATE)('%s', async (_, value) => {
    expect(await update(value)).toMatchSnapshot()
  })
})

describe('createAttributeInput, characterised', () => {
  it.each(CREATE)('%s', async (_, value) => {
    expect(await create(value)).toMatchSnapshot()
  })
})
