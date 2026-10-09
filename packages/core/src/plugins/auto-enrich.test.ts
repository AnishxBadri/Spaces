import { describe, expect, it } from 'vitest'
import { autoEnrichConfig, autoEnrichScopeOf, scopeWords } from './auto-enrich'

const SPACE = '00000000-0000-4000-8000-0000000000aa'

describe('autoEnrichScopeOf', () => {
  it.each([
    ['autoEnrich: true reads as deal', { autoEnrich: true }, ['deal']],
    ['autoEnrich: false reads as none', { autoEnrich: false }, []],
    ['neither key is the default, deal alone', {}, ['deal']],
    [
      'the scopes win over the legacy switch',
      { autoEnrich: true, autoEnrichScopes: ['space'] },
      ['space'],
    ],
    [
      'unknown words drop and the order is fixed',
      { autoEnrichScopes: ['meeting', 'nonsense', 'deal'] },
      ['deal', 'meeting'],
    ],
  ])('%s', (_, config, scopes) => {
    expect(autoEnrichScopeOf(config).scopes).toEqual(scopes)
  })

  it('keeps the chosen spaces, and none for a list that is not ids', () => {
    expect(
      autoEnrichScopeOf({
        autoEnrichScopes: ['space'],
        autoEnrichSpaces: [SPACE],
      }).spaces,
    ).toEqual([SPACE])
    expect(autoEnrichScopeOf({ autoEnrichSpaces: ['x'] }).spaces).toEqual([])
  })
})

describe('autoEnrichConfig', () => {
  it('writes the scope keys, drops the legacy switch and keeps plugin settings', () => {
    expect(
      autoEnrichConfig(
        { autoEnrich: true, cacheDays: 30 },
        { scopes: ['deal', 'space'], spaces: [SPACE] },
      ),
    ).toEqual({
      cacheDays: 30,
      autoEnrichScopes: ['deal', 'space'],
      autoEnrichSpaces: [SPACE],
    })
  })
})

describe('scopeWords', () => {
  it('names the scopes, or off', () => {
    expect(scopeWords({ scopes: ['deal', 'space'], spaces: [] })).toBe(
      'deal · space',
    )
    expect(scopeWords({ scopes: [], spaces: [] })).toBe('off')
  })
})
