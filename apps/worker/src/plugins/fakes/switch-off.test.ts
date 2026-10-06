import { describe, expect, it, vi } from 'vitest'
import {
  FAKE_PROVIDERS_ENV,
  fakeProvidersOn,
  loadFakeProviders,
} from './switch'

/**
 * With the flag unset the fakes are not even imported: the registry module
 * is replaced by one that records being loaded, and only the flag on loads
 * it. Its own file, because the mock replaces the module for the whole file.
 */

const loads = vi.hoisted(() => ({ count: 0 }))

vi.mock('./registry', () => {
  loads.count += 1
  return {
    cassetteProviders: () => ({ standIn: () => null }),
  }
})

describe('SPACES_FAKE_PROVIDERS', () => {
  it('is on for exactly "1"', () => {
    expect(fakeProvidersOn({ [FAKE_PROVIDERS_ENV]: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(fakeProvidersOn({ [FAKE_PROVIDERS_ENV]: value })).toBe(false)
  })

  it('off: no fakes, and the fake modules are never imported', async () => {
    expect(await loadFakeProviders({})).toBeNull()
    expect(await loadFakeProviders({ [FAKE_PROVIDERS_ENV]: '0' })).toBeNull()
    expect(loads.count).toBe(0)
  })

  it('on: the fakes are imported and handed back', async () => {
    expect(
      await loadFakeProviders({ [FAKE_PROVIDERS_ENV]: '1' }),
    ).not.toBeNull()
    expect(loads.count).toBe(1)
  })
})
