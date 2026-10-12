import { describe, expect, it } from 'vitest'
import { answerBlocks, answerMarkdown, citedRefs } from './answer'
import type { AskRef } from './types'

/**
 * The answer renderer's citation rule (D70): every claim block carries a
 * ref the turn stored, or it is withheld.
 */

const ACME: AskRef = {
  ref: 'record:00000000-0000-4000-8000-00000000000a',
  label: 'Acme',
  href: '/companies/00000000-0000-4000-8000-00000000000a',
  entityId: '00000000-0000-4000-8000-00000000000a',
}
const DECK: AskRef = {
  ref: 'doc:00000000-0000-4000-8000-00000000000d#3',
  label: 'Deck.pdf, p.4',
  href: null,
  entityId: '00000000-0000-4000-8000-00000000000d',
}

describe('answerBlocks', () => {
  it('refuses an unreferenced claim block and keeps the cited ones', () => {
    const blocks = answerBlocks(
      [
        `Acme raised a Series A [${ACME.ref}].`,
        '',
        'Acme is the best company in the world.',
        '',
        '## Where it stands',
        '',
        'Three things stand out:',
        `- Revenue doubled [${DECK.ref}]`,
        '- Everyone loves them',
      ].join('\n'),
      [ACME, DECK],
    )
    expect(blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'refused',
      'heading',
      'paragraph',
      'item',
      'refused',
    ])
    const first = blocks.at(0)
    expect(first?.kind === 'paragraph' && first.segments).toEqual([
      { kind: 'text', text: 'Acme raised a Series A ', strong: false },
      { kind: 'ref', ref: ACME },
      { kind: 'text', text: '.', strong: false },
    ])
  })

  it('drops a citation the turn did not store, so it cannot carry a claim', () => {
    const blocks = answerBlocks(
      'Made up [record:00000000-0000-4000-8000-0000000000ff].',
      [ACME],
    )
    expect(blocks).toEqual([{ kind: 'refused' }])
  })

  it('refuses a table with no cited row, keeps one with', () => {
    const table = (cell: string) =>
      ['| Deal | Stage |', '| --- | --- |', `| ${cell} | Series A |`].join('\n')
    expect(answerBlocks(table('Acme'), [ACME]).at(0)?.kind).toBe('refused')
    expect(answerBlocks(table(`Acme [${ACME.ref}]`), [ACME]).at(0)?.kind).toBe(
      'table',
    )
  })

  it('withholds nothing while streaming', () => {
    expect(answerBlocks('Acme is great.', [], false).at(0)?.kind).toBe(
      'paragraph',
    )
  })
})

describe('citedRefs and answerMarkdown', () => {
  it('reads every cited ref once, and writes chips as words with withheld claims left out', () => {
    const body = `Acme raised [${ACME.ref}, ${DECK.ref}].\n\nUncited.\n\n- Again [${ACME.ref}]`
    expect(citedRefs(body)).toEqual([ACME.ref, DECK.ref])
    expect(answerMarkdown(answerBlocks(body, [ACME, DECK]))).toBe(
      'Acme raised (Acme; Deck.pdf, p.4).\n\n- Again (Acme)',
    )
  })
})
