import { describe, expect, it } from 'vitest'
import { docOfRef, parseRef, ref } from './ref'

describe('ref grammar', () => {
  it('round-trips every kind', () => {
    const cases = [
      [
        ref.attr('e1', 'funding_stage'),
        { kind: 'attr', entityId: 'e1', slug: 'funding_stage' },
      ],
      [ref.note('n1'), { kind: 'note', entityId: 'n1' }],
      [ref.memo('m1'), { kind: 'memo', entityId: 'm1' }],
      [ref.doc('d1', 4), { kind: 'doc', entityId: 'd1', idx: 4 }],
      [ref.event('ev1'), { kind: 'event', id: 'ev1' }],
      [ref.interaction('i1'), { kind: 'interaction', id: 'i1' }],
      [ref.task('t1'), { kind: 'task', id: 't1' }],
      [ref.mandate('md1'), { kind: 'mandate', id: 'md1' }],
      [ref.term('g1'), { kind: 'term', entityId: 'g1' }],
    ] as const
    for (const [s, parsed] of cases) expect(parseRef(s)).toEqual(parsed)
  })

  it('slugs may contain colons-free punctuation; uuids pass through', () => {
    const id = '6f2c1a2b-0000-4000-8000-000000000001'
    expect(parseRef(ref.attr(id, 'priority_fund_ii'))).toEqual({
      kind: 'attr',
      entityId: id,
      slug: 'priority_fund_ii',
    })
  })

  it('rejects malformed refs', () => {
    for (const bad of [
      '',
      'attr',
      'attr:',
      'attr:e1',
      'attr:e1:',
      'doc:d1',
      'doc:d1#x',
      'doc:d1#-1',
      'doc:#1',
      'nope:1',
      'note:',
    ])
      expect(parseRef(bad), bad).toBeNull()
  })

  it('docOfRef finds the document for a chunk and nothing else', () => {
    expect(docOfRef(ref.doc('d1', 2))).toBe('d1')
    expect(docOfRef(ref.note('n1'))).toBeNull()
  })
})
