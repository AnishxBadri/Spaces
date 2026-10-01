import { describe, expect, it } from 'vitest'
import { parseSdkRange, satisfiesSdk } from './range.ts'
import { SDK_VERSION } from './version.ts'

describe('satisfiesSdk', () => {
  it('names both sides when the range wants a newer major — the loader writes this verbatim', () => {
    const check = satisfiesSdk('^2.0', '1.0.0')
    expect(check).toEqual({
      ok: false,
      reason: 'requires sdk ^2.0, host provides 1.0.0',
    })
    // The demo line: what an operator would read on a degraded row.
    if (!check.ok) console.info(`[sdk] degraded: ${check.reason}`)
  })

  it('defaults the host to SDK_VERSION', () => {
    expect(satisfiesSdk('^1.0')).toEqual({ ok: true })
    expect(satisfiesSdk('^2.0')).toEqual({
      ok: false,
      reason: `requires sdk ^2.0, host provides ${SDK_VERSION}`,
    })
  })

  describe('caret', () => {
    it.each([
      ['^1.0', '1.0.0', true],
      ['^1.0', '1.9.3', true],
      ['^1.2.3', '1.2.2', false],
      ['^1.2.3', '1.2.3', true],
      ['^1.2.3', '2.0.0', false],
      ['^1', '1.99.0', true],
      ['^0.2.3', '0.2.9', true],
      ['^0.2.3', '0.3.0', false],
      ['^0.0.3', '0.0.3', true],
      ['^0.0.3', '0.0.4', false],
      ['^0.0', '0.0.9', true],
      ['^0.0', '0.1.0', false],
    ])('%s against %s → %s', (range, host, ok) => {
      expect(satisfiesSdk(range, host).ok).toBe(ok)
    })
  })

  describe('tilde', () => {
    it.each([
      ['~1.2', '1.2.0', true],
      ['~1.2.3', '1.2.9', true],
      ['~1.2.3', '1.2.2', false],
      ['~1.2.3', '1.3.0', false],
      ['~1', '1.9.0', true],
      ['~1', '2.0.0', false],
    ])('%s against %s → %s', (range, host, ok) => {
      expect(satisfiesSdk(range, host).ok).toBe(ok)
    })
  })

  describe('exact', () => {
    it.each([
      ['1.0.0', '1.0.0', true],
      ['1.0.0', '1.0.1', false],
      ['1.0.1', '1.0.0', false],
    ])('%s against %s → %s', (range, host, ok) => {
      expect(satisfiesSdk(range, host).ok).toBe(ok)
    })
  })

  it('compares a prerelease host as its release triple', () => {
    expect(satisfiesSdk('^1.1', '1.1.0-rc.1').ok).toBe(true)
  })

  it('refuses what it cannot read, saying so', () => {
    for (const range of ['>=1.0', '1.x', '^1.0 || ^2.0', '1.2', '', 'latest']) {
      expect(parseSdkRange(range)).toBeNull()
      const check = satisfiesSdk(range)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/^unreadable sdk range/)
    }
  })
})
