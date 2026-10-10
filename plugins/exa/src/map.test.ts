import { describe, expect, it } from 'vitest'
import { citeSignals, exaMessage, searchHits, toSignal } from './map.ts'
import { fixtureNames, fixtureText } from './test-fixtures.ts'

/** The pure half: Exa's JSON in, claims and sentences out. */

describe('searchHits', () => {
  it('reads every hit in the recorded answer, in Exa’s order', () => {
    const hits = searchHits(JSON.parse(fixtureText('search.json')))
    expect(hits).toHaveLength(5)
    expect(hits.at(1)?.author).toBeNull()
  })

  it('keeps one hit per URL', () => {
    const hit = { url: 'https://a.example/x', title: 'X' }
    expect(searchHits({ results: [hit, hit] })).toHaveLength(1)
  })

  it('refuses a body with no results', () => {
    expect(() => searchHits({ error: 'nope' })).toThrow()
  })
})

describe('toSignal', () => {
  it('claims a web signal keyed on the URL, with what Exa said in the payload', () => {
    expect(
      toSignal('entity-0', {
        id: 'exa-1',
        url: 'https://a.example/x',
        title: 'X raises',
        publishedDate: '2026-09-28T07:30:00.000Z',
        author: null,
        score: 0.4,
        highlights: ['X raised a seed.', ' '],
      }),
    ).toEqual({
      _tag: 'signal',
      entityId: 'entity-0',
      kind: 'web',
      key: 'web:https://a.example/x',
      url: 'https://a.example/x',
      title: 'X raises',
      publishedAt: '2026-09-28T07:30:00.000Z',
      payload: { exaId: 'exa-1', score: 0.4, highlights: ['X raised a seed.'] },
    })
  })

  it('claims nothing it was not given', () => {
    expect(toSignal('entity-0', { url: 'https://a.example/y' })).toEqual({
      _tag: 'signal',
      entityId: 'entity-0',
      kind: 'web',
      key: 'web:https://a.example/y',
      url: 'https://a.example/y',
      payload: {},
    })
  })
})

describe('citeSignals', () => {
  const refs = ['event:s1', 'event:s2'] as const

  it('swaps each place-holding ref for its signal, in any bracket form', () => {
    expect(
      citeSignals('A [event:hit-1]. B [event:hit-2, event:hit-1].', refs),
    ).toBe('A [event:s1]. B [event:s2, event:s1].')
  })

  it('leaves a ref with no hit behind it as written', () => {
    expect(citeSignals('C [event:hit-3] D [event:hit-0]', refs)).toBe(
      'C [event:hit-3] D [event:hit-0]',
    )
  })
})

describe('exaMessage', () => {
  it('is Exa’s own sentence', () => {
    expect(exaMessage(fixtureText('error-401.json'))).toBe(
      'Invalid API key. Check the key in your Exa dashboard and try again.',
    )
  })

  it('is the body as it came when it is not Exa’s error shape', () => {
    expect(exaMessage(' Bad Gateway ')).toBe('Bad Gateway')
    expect(exaMessage('')).toBe('(no message)')
  })
})

const KEYISH = /api_?key|token|secret|password|authorization/i

describe('the fixtures', () => {
  it.each(fixtureNames())('%s carries no key material', (name) => {
    const names: Array<string> = []
    JSON.parse(fixtureText(name), (key: string, value: unknown) => {
      names.push(key)
      return value
    })
    expect(names.filter((k) => KEYISH.test(k))).toEqual([])
  })
})
