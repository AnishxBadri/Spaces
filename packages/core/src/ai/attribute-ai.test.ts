import { describe, expect, it } from 'vitest'
import {
  aiModesFor,
  buildAiConfig,
  optionProposalLine,
  promptVariables,
  readAiConfig,
  readOptionProposals,
  renderAiPrompt,
} from './attribute-ai'

describe('the mode × type matrix', () => {
  it('offers only the modes a type can hold', () => {
    expect(aiModesFor('text')).toEqual(['summarize', 'prompt', 'research'])
    expect(aiModesFor('text')).not.toContain('classify')
    expect(aiModesFor('select')).toEqual(['classify'])
    expect(aiModesFor('select')).not.toContain('summarize')
    expect(aiModesFor('multi_select')).toEqual(['classify'])
    expect(aiModesFor('status')).toEqual(['classify'])
    expect(aiModesFor('checkbox')).toEqual(['classify'])
    expect(aiModesFor('number')).toEqual(['prompt'])
    expect(aiModesFor('currency')).toEqual(['prompt'])
    expect(aiModesFor('date')).toEqual(['prompt'])
    expect(aiModesFor('url')).toEqual(['research'])
    expect(aiModesFor('domain')).toEqual(['research'])
    for (const t of [
      'email',
      'phone',
      'rating',
      'record_reference',
      'actor_reference',
    ])
      expect(aiModesFor(t)).toEqual([])
  })

  it('builds the lane from the mode and refuses a mode the type cannot hold', () => {
    expect(
      buildAiConfig('text', { mode: 'summarize', prompt: 'Why?' }, []),
    ).toEqual({
      ok: true,
      config: { mode: 'summarize', prompt: 'Why?', lane: 'synthesize' },
    })
    const refused = buildAiConfig('text', { mode: 'classify', prompt: '' }, [])
    expect(refused).toEqual({
      ok: false,
      message: 'Classify is not a mode a text attribute can hold',
    })
    expect(
      buildAiConfig('select', { mode: 'summarize', prompt: '' }, []).ok,
    ).toBe(false)
  })

  it('reads the variables off the prompt, refusing a slug the object lacks', () => {
    expect(
      buildAiConfig(
        'text',
        {
          mode: 'prompt',
          prompt: 'Given {{sector}} and {{ stage }}, {{sector}}?',
        },
        ['sector', 'stage'],
      ),
    ).toEqual({
      ok: true,
      config: {
        mode: 'prompt',
        prompt: 'Given {{sector}} and {{ stage }}, {{sector}}?',
        variables: ['sector', 'stage'],
        lane: 'synthesize',
      },
    })
    expect(
      buildAiConfig('text', { mode: 'prompt', prompt: '{{nope}}' }, ['x']).ok,
    ).toBe(false)
    expect(promptVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
    expect(renderAiPrompt('A {{a}}, B {{ b }}', { a: '1' })).toBe(
      'A 1, B (blank)',
    )
  })

  it('reads a stored config back, or null when it cannot run', () => {
    const ai = { mode: 'classify', prompt: 'x', lane: 'classify' }
    expect(readAiConfig({ type: 'select', options: { ai } })).toEqual(ai)
    expect(readAiConfig({ type: 'text', options: { ai } })).toBeNull()
    expect(readAiConfig({ type: 'text', options: {} })).toBeNull()
    expect(readAiConfig({ type: 'text', options: null })).toBeNull()
  })
})

describe('the registry proposal line', () => {
  it('round-trips, quotes and parentheses included', () => {
    const p = { slug: 'fund_type', name: 'Type (legal)', label: 'SPV "B"' }
    const rationale = [
      optionProposalLine(p),
      'The deck says so.',
      optionProposalLine({ ...p, label: 'Evergreen' }),
    ].join('\n')
    expect(readOptionProposals(rationale)).toEqual([
      p,
      { ...p, label: 'Evergreen' },
    ])
    expect(readOptionProposals(null)).toEqual([])
    expect(readOptionProposals('Proposed new option X for y (z).')).toEqual([])
  })
})
