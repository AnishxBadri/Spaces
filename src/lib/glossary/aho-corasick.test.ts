import { describe, expect, it } from 'vitest'
import { buildAutomaton, findMatches } from './aho-corasick'
import type { Pattern } from './aho-corasick'

const find = (patterns: Array<Pattern>, text: string) =>
  findMatches(buildAutomaton(patterns), text)

const P = {
  stage: { id: 't-stage', text: 'stage' },
  space: { id: 't-space', text: 'space' },
  ism: { id: 't-ism', text: 'in-space manufacturing' },
  llo: { id: 't-orbit', text: 'LEO' },
  lowEarth: { id: 't-orbit', text: 'low earth orbit' },
}

describe('findMatches', () => {
  it('finds a term and reports offsets into the original string', () => {
    const m = find([P.stage], 'The stage gate is next.')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ id: 't-stage', start: 4, end: 9 })
    expect('The stage gate is next.'.slice(m[0].start, m[0].end)).toBe('stage')
  })

  it('is case-insensitive but returns the text as written', () => {
    const m = find([P.stage], 'STAGE gate')
    expect(m[0].matched).toBe('STAGE')
    expect(m[0].id).toBe('t-stage')
  })

  it('never matches inside a longer word', () => {
    expect(find([P.stage], 'backstage pass')).toHaveLength(0)
    expect(find([P.stage], 'staged rollout')).toHaveLength(0)
    // Documented consequence of strict boundaries: plurals are missed.
    expect(find([P.stage], 'three stages')).toHaveLength(0)
  })

  it('prefers the longest term when two overlap', () => {
    const m = find([P.space, P.ism], 'We like in-space manufacturing a lot.')
    expect(m).toHaveLength(1)
    expect(m[0].id).toBe('t-ism')
    expect(m[0].matched).toBe('in-space manufacturing')
  })

  it('still matches the shorter term where the longer one does not apply', () => {
    const m = find([P.space, P.ism], 'in-space manufacturing needs space.')
    expect(m.map((x) => x.id)).toEqual(['t-ism', 't-space'])
  })

  it('maps aliases onto the same term id', () => {
    const m = find([P.llo, P.lowEarth], 'LEO and low earth orbit are the same.')
    expect(m.map((x) => x.id)).toEqual(['t-orbit', 't-orbit'])
    expect(m.map((x) => x.matched)).toEqual(['LEO', 'low earth orbit'])
  })

  it('returns matches in document order, non-overlapping', () => {
    const text = 'stage, then space, then stage again'
    const m = find([P.stage, P.space], text)
    expect(m.map((x) => x.start)).toEqual([
      text.indexOf('stage'),
      text.indexOf('space'),
      text.lastIndexOf('stage'),
    ])
  })

  it('treats hyphens as boundaries', () => {
    const m = find([P.space], 'in-space')
    expect(m).toHaveLength(1)
    expect(m[0].start).toBe(3)
  })

  it('handles an empty term set and empty input without throwing', () => {
    expect(find([], 'anything at all')).toEqual([])
    expect(find([P.stage], '')).toEqual([])
    expect(find([{ id: 'x', text: '   ' }], 'blank pattern')).toEqual([])
  })

  it('finds a term at the very start and very end', () => {
    expect(find([P.stage], 'stage')).toHaveLength(1)
    expect(find([P.stage], 'the stage')[0].end).toBe(9)
  })

  it('finds overlapping-suffix patterns via failure links', () => {
    // "her" is a suffix of "usher" — the classic case that fails without
    // inherited outputs on the failure link.
    const m = find(
      [
        { id: 'a', text: 'usher' },
        { id: 'b', text: 'her' },
      ],
      'usher and her',
    )
    expect(m.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
