import { execValidator } from '@tanstack/react-start'
import { describe, expect, it } from 'vitest'
import { input } from '../server/input'
import { pagedListInput } from './page-input'

/**
 * A paged list's request at its edges, through the validator a server fn
 * runs. Every case here held against the shape before it was an Effect
 * schema.
 */

const page = (value: unknown) => execValidator(input(pagedListInput), value)

describe('pagedListInput', () => {
  it('accepts an empty request', async () => {
    await expect(page({})).resolves.toEqual({})
  })

  it('accepts a full request and drops a key it does not name', async () => {
    const full = {
      conditions: [
        { slug: 'stage', op: 'is', value: 'seed' },
        { slug: 'raised', op: 'gt', value: 5 },
        { slug: 'active', op: 'is', value: true },
        { slug: 'owner', op: 'is', value: null },
        { slug: 'tags', op: 'contains', value: ['a', 'b'] },
        { slug: 'notes', op: 'empty' },
      ],
      cursor: 'abc',
      limit: 50,
      sort: { id: 'attr:stage', desc: true },
      q: 'acme',
    }
    await expect(page({ ...full, role: 'admin' })).resolves.toEqual(full)
  })

  it('accepts a null cursor and a null sort', async () => {
    await expect(page({ cursor: null, sort: null })).resolves.toEqual({
      cursor: null,
      sort: null,
    })
  })

  it.each([1, 200])('accepts a limit of %s', async (limit) => {
    await expect(page({ limit })).resolves.toEqual({ limit })
  })

  it.each([
    ['a limit of 0', { limit: 0 }],
    ['a limit of 201', { limit: 201 }],
    ['a fractional limit', { limit: 1.5 }],
    ['a limit as a string', { limit: '5' }],
    ['a null limit', { limit: null }],
    ['a long cursor', { cursor: 'x'.repeat(401) }],
    ['a long query', { q: 'x'.repeat(201) }],
    ['a null query', { q: null }],
    ['a sort with no id', { sort: { id: '', desc: false } }],
    ['a sort with no direction', { sort: { id: 'name' } }],
    ['an unknown op', { conditions: [{ slug: 's', op: 'like' }] }],
    ['an empty slug', { conditions: [{ slug: '', op: 'is' }] }],
    ['a long slug', { conditions: [{ slug: 'x'.repeat(121), op: 'is' }] }],
    [
      'a long value',
      { conditions: [{ slug: 's', op: 'is', value: 'x'.repeat(401) }] },
    ],
    ['an object value', { conditions: [{ slug: 's', op: 'is', value: {} }] }],
    [
      'fifty-one option ids',
      {
        conditions: [
          { slug: 's', op: 'is', value: Array.from({ length: 51 }, () => 'a') },
        ],
      },
    ],
    [
      'twenty-one conditions',
      {
        conditions: Array.from({ length: 21 }, () => ({
          slug: 's',
          op: 'empty',
        })),
      },
    ],
  ])('refuses %s', async (_, value) => {
    await expect(page(value)).rejects.toThrow()
  })

  it('accepts twenty conditions and fifty option ids', async () => {
    const conditions = [
      { slug: 's', op: 'is', value: Array.from({ length: 50 }, () => 'a') },
      ...Array.from({ length: 19 }, () => ({ slug: 's', op: 'empty' })),
    ]
    await expect(page({ conditions })).resolves.toEqual({ conditions })
  })
})
