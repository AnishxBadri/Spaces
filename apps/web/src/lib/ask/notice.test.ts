import { describe, expect, it } from 'vitest'
import { routeLine } from '#/lib/ai/route-line'
import {
  capLine,
  modelLine,
  stoppedWords,
  thinkingWords,
  turnNotice,
} from './notice'
import { SCOPE_DROPPED } from './scope'
import type { AskCall } from './types'

/**
 * The lines an answer prints about itself: the notice over a sensitive,
 * capped or refused turn, the thinking line, and a stopped turn's count.
 */

const call = (over: Partial<AskCall>): AskCall => ({
  tool: 'query_records',
  state: 'done',
  input: '',
  found: null,
  ...over,
})

describe('the notice row', () => {
  it('reads a turn the gate sent local from the route line, and keeps Provider · model for the foot', () => {
    const local = routeLine(
      { provider: 'ollama', model: 'llama3.2' },
      { kind: 'space', name: 'Fund II' },
      true,
    )
    expect(turnNotice('answered', local)).toEqual({
      tone: 'warning',
      sentence: 'Sensitive space in scope · answered on the local model',
      link: null,
    })
    expect(modelLine(local)).toBe('Ollama · llama3.2')
    const cloud = routeLine(
      { provider: 'anthropic', model: 'claude-opus-5' },
      null,
      false,
    )
    expect(turnNotice('answered', cloud)).toBeNull()
    expect(modelLine(cloud)).toBe(cloud)
  })

  it('names the cap from its fields, with the way to Usage', () => {
    const line = capLine({ kind: 'daily', ceiling: 200_000, used: 200_412 })
    expect(line).toBe(
      'Daily AI cap reached · 200,412 of 200,000 tokens · resets 00:00 UTC',
    )
    expect(turnNotice('capped', line)).toEqual({
      tone: 'destructive',
      sentence: line,
      link: { label: 'Usage ›', to: '/settings/usage' },
    })
  })

  it('says a refused turn sent nothing, with the way to a local model', () => {
    expect(
      turnNotice('refused', 'Refused · Sensitive material is not sent'),
    ).toEqual({
      tone: 'destructive',
      sentence: 'Sensitive space · nothing sent',
      link: { label: 'Add a local model ›', to: '/settings/models' },
    })
  })
})

describe('the thinking line', () => {
  it('reads, counting what the calls found so far, then computes', () => {
    expect(thinkingWords([])).toBe('Reading')
    expect(
      thinkingWords([
        call({ found: 3 }),
        call({ state: 'running', found: null }),
      ]),
    ).toBe('Reading 3 sources')
    expect(thinkingWords([call({ found: 3 }), call({ found: 4 })])).toBe(
      'Computing',
    )
    // A dropped chip is a scope line, not a call.
    expect(thinkingWords([call({ tool: SCOPE_DROPPED })])).toBe('Reading')
  })

  it('counts a stopped turn’s calls that came back', () => {
    expect(stoppedWords([])).toBe('Stopped')
    expect(
      stoppedWords([
        call({}),
        call({}),
        call({ state: 'failed' }),
        call({ tool: SCOPE_DROPPED, state: 'refused' }),
      ]),
    ).toBe('Stopped · 2 of 3 calls')
  })
})
