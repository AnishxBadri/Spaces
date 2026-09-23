import { describe, expect, it } from 'vitest'
import { buildAutomaton, findMatches } from './aho-corasick'
import { mentionedTermIds, termAutomaton, termPatterns } from './terms'

/**
 * The shared builder (SPA-34). The editor decoration and the server link
 * sync both build their matcher through `termAutomaton`, so what is asserted
 * here is asserted for both: a term that highlights links, and nothing links
 * that would not highlight.
 */

const PUE = {
  id: 't-pue',
  name: 'PUE',
  aliases: ['power usage effectiveness'],
}
const STAGE = { id: 't-stage', name: 'stage', aliases: [] }

describe('termPatterns', () => {
  it('emits the name and every alias under the term id', () => {
    expect(termPatterns([PUE, STAGE])).toEqual([
      { id: 't-pue', text: 'PUE' },
      { id: 't-pue', text: 'power usage effectiveness' },
      { id: 't-stage', text: 'stage' },
    ])
  })

  it('is empty for no terms, and the automaton matches nothing', () => {
    expect(termPatterns([])).toEqual([])
    expect(mentionedTermIds(termAutomaton([]), 'PUE everywhere')).toEqual(
      new Set(),
    )
  })
})

describe('termAutomaton + mentionedTermIds', () => {
  const automaton = termAutomaton([PUE, STAGE])

  it('is exactly the automaton buildAutomaton makes of termPatterns', () => {
    expect(automaton).toEqual(buildAutomaton(termPatterns([PUE, STAGE])))
  })

  it('collapses repeats to one id per term', () => {
    expect(mentionedTermIds(automaton, 'PUE, PUE and again pue.')).toEqual(
      new Set(['t-pue']),
    )
  })

  it('reaches a term through its alias', () => {
    expect(
      mentionedTermIds(automaton, 'Power Usage Effectiveness was 1.1'),
    ).toEqual(new Set(['t-pue']))
  })

  it('keeps the whole-word rule the highlight keeps', () => {
    expect(mentionedTermIds(automaton, 'backstage stages PUEs')).toEqual(
      new Set(),
    )
  })

  it('links exactly the ids the highlight would decorate', () => {
    const text =
      'Seed stage. PUE of 1.2 — power usage effectiveness — at [[PUE]].'
    const highlighted = new Set(findMatches(automaton, text).map((m) => m.id))
    expect(mentionedTermIds(automaton, text)).toEqual(highlighted)
    expect(highlighted).toEqual(new Set(['t-pue', 't-stage']))
  })
})
