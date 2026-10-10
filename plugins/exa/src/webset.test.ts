import { describe, expect, it } from 'vitest'
import { SPACE_ID, brief, fixtureText, northwind } from './test-fixtures.ts'
import {
  criteriaOf,
  handOf,
  itemsAfter,
  itemsUrl,
  membersByDomain,
  readPage,
  websetId,
} from './webset.ts'
import type { Item } from './webset.ts'

/** The pure half of the watch: Exa's websets JSON in, claims out. */

const page = readPage(JSON.parse(fixtureText('webset-items.json')))
const item = (url: string, id = 'witem-x'): Item => ({
  id,
  properties: { url },
})
const context = { websetId: 'webset-1', receiptId: 'receipt-1' }

describe('readPage', () => {
  it('reads every item in the recorded page, and where the next starts', () => {
    expect(page.data).toHaveLength(7)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('witem_01k79q3a07')
  })

  it('refuses a body that is not a page of items', () => {
    expect(() => readPage({ results: [] })).toThrow()
  })
})

describe('websetId', () => {
  it('is the created webset’s id', () => {
    expect(websetId(JSON.parse(fixtureText('webset-create.json')))).toBe(
      'webset_01k79q2zx3',
    )
  })
})

describe('itemsUrl', () => {
  it('asks for the first page without a cursor and escapes one it is given', () => {
    expect(itemsUrl('webset-1', null)).toBe(
      'https://api.exa.ai/websets/v0/websets/webset-1/items?limit=50',
    )
    expect(itemsUrl('webset-1', 'a b&c')).toBe(
      'https://api.exa.ai/websets/v0/websets/webset-1/items?limit=50&cursor=a%20b%26c',
    )
  })
})

describe('itemsAfter', () => {
  it('skips through the last item handed on, and takes all when it is not on the page', () => {
    const ids = (items: ReadonlyArray<Item>) => items.map((i) => i.id)
    expect(ids(itemsAfter(page.data, 'witem_01k79q3a05'))).toEqual([
      'witem_01k79q3a06',
      'witem_01k79q3a07',
    ])
    expect(itemsAfter(page.data, 'witem_01k79q3a07')).toEqual([])
    expect(itemsAfter(page.data, 'witem-elsewhere')).toHaveLength(7)
    expect(itemsAfter(page.data, null)).toHaveLength(7)
  })
})

describe('criteriaOf', () => {
  it('is the watch’s own, else the space’s, else none', () => {
    expect(criteriaOf({ criteria: ' Forklifts. ', cap: 1 }, brief)).toBe(
      'Forklifts.',
    )
    expect(criteriaOf({ criteria: '', cap: 1 }, brief)).toBe(
      brief.space.criteria,
    )
    expect(
      criteriaOf(
        { criteria: '', cap: 1 },
        { ...brief, space: { ...brief.space, criteria: '  ' } },
      ),
    ).toBeNull()
  })
})

describe('handOf', () => {
  const members = membersByDomain(brief.members)

  it('matches a member on any form of its domain', () => {
    for (const url of [
      'https://northwind-robotics.example',
      'http://www.Northwind-Robotics.example/careers',
      'https://shop.northwind-robotics.example/',
    ]) {
      const hand = handOf(item(url), SPACE_ID, members, context)
      expect(hand._tag).toBe('signal')
      expect(hand._tag === 'signal' && hand.claim.entityId).toBe(
        northwind.entityId,
      )
    }
  })

  it('titles a member’s signal by name when Exa gave no description', () => {
    const hand = handOf(
      item('https://northwind-robotics.example'),
      SPACE_ID,
      members,
      context,
    )
    expect(hand).toMatchObject({
      claim: {
        title: 'Northwind Robotics found by an Exa watch',
        key: 'web:https://northwind-robotics.example',
        receiptId: 'receipt-1',
        payload: {
          websetId: 'webset-1',
          exaItemId: 'witem-x',
          evidence: [{ url: 'https://northwind-robotics.example' }],
        },
      },
    })
  })

  it('names a candidate by its domain when Exa gave no name', () => {
    expect(
      handOf(item('https://www.liftly.example/'), SPACE_ID, members, context),
    ).toEqual({
      _tag: 'candidate',
      claim: {
        spaceId: SPACE_ID,
        name: 'liftly.example',
        domain: 'liftly.example',
        evidence: [{ url: 'https://www.liftly.example/' }],
      },
    })
  })

  it('skips an item with no domain to resolve it by', () => {
    expect(
      handOf(item('https://localhost:3000/x'), SPACE_ID, members, context),
    ).toEqual({ _tag: 'skip' })
  })

  it('cites each page once', () => {
    const hand = handOf(
      {
        id: 'witem-y',
        properties: { url: 'https://liftly.example' },
        evaluations: [
          { references: [{ url: 'https://a.example/1', title: 'One' }] },
          {
            references: [
              { url: 'https://a.example/1', title: 'One again' },
              { url: 'https://liftly.example' },
            ],
          },
        ],
      },
      SPACE_ID,
      members,
      context,
    )
    expect(hand._tag === 'candidate' && hand.claim.evidence).toEqual([
      { url: 'https://liftly.example' },
      { url: 'https://a.example/1', title: 'One' },
    ])
  })
})
