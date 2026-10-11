import { describe, expect, it } from 'vitest'
import { excerpt } from './excerpt'

const ID = '41a28ef7-5b2c-4c8e-9f00-000000000001'

describe('excerpt', () => {
  it('renders an inline mention as its name', () => {
    const out = excerpt(
      `Met [[Kalpana Systems|entity:${ID}]] about the\n\nthermal stack.`,
    )
    expect(out).toBe('Met Kalpana Systems about the thermal stack.')
    expect(out).not.toContain('[[')
    expect(out).not.toContain('entity:')
  })

  it('drops a note body’s trailing Mentions line, and only a trailing one', () => {
    expect(
      excerpt(`Mentions: [[Kalpana Systems|entity:${ID}]]\n`, {
        noteBody: true,
      }),
    ).toBe('')
    expect(
      excerpt(
        `Mentions: none yet, but [[Flent|entity:${ID}]] is close.\n\nMore.\n\nMentions: [[Flent|entity:${ID}]]`,
        { noteBody: true },
      ),
    ).toBe('Mentions: none yet, but Flent is close. More.')
  })

  it('keeps a snippet’s Mentions line unless told it is a note body', () => {
    expect(excerpt(`Mentions: [[«Flent»|entity:${ID}]]`)).toBe(
      'Mentions: «Flent»',
    )
  })

  it('cuts after rendering, so a link id never spends the length', () => {
    const out = excerpt(`[[Kalpana Systems|entity:${ID}]] raised a round`, {
      max: 16,
    })
    expect(out).toBe('Kalpana Systems ')
  })

  it('renders a link a search snippet cut at either edge', () => {
    expect(excerpt('Systems|entity:41a2]] raised. [[Flent|entity:0d')).toBe(
      'Systems raised. Flent',
    )
  })
})
