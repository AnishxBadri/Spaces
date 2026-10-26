import { describe, expect, it } from 'vitest'
import { waitingTitle } from './waiting-title'

/** The title a waiting suggestion reads by on a record's rail. */
describe('a waiting suggestion’s title', () => {
  const names: Record<string, string> = { founders: 'Founders' }
  const name = (slug: string) => names[slug] ?? slug

  it('names a patch by its first attribute, its source and how many more', () => {
    const payload = {
      founders: { value: [], refs: [], confidence: 1 },
      team_size: { value: 9, refs: [], confidence: 1 },
      location: { value: 'Pune', refs: [], confidence: 1 },
      sector: { value: 'x', refs: [], confidence: 1 },
    }
    expect(
      waitingTitle(
        { kind: 'attribute_patch', payload, source: 'Apollo' },
        name,
      ),
    ).toBe('Founders from Apollo +3')
    expect(
      waitingTitle(
        {
          kind: 'attribute_patch',
          payload: { founders: payload.founders },
          source: null,
        },
        name,
      ),
    ).toBe('Founders')
  })

  it('reads a note or task by its title and a space tag by its label', () => {
    expect(
      waitingTitle(
        {
          kind: 'task',
          payload: { title: 'Call Ada', due: null },
          source: null,
        },
        name,
      ),
    ).toBe('Call Ada')
    expect(
      waitingTitle(
        { kind: 'space_tag', payload: { label: 'Proptech' }, source: null },
        name,
      ),
    ).toBe('Proptech')
  })

  it('falls back to the kind’s own name', () => {
    expect(
      waitingTitle({ kind: 'supersedes', payload: {}, source: null }, name),
    ).toBe('Newer version')
    expect(
      waitingTitle({ kind: 'note', payload: {}, source: null }, name),
    ).toBe('Note')
  })
})
