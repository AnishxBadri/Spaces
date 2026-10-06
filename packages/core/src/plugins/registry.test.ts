import { describe, expect, it } from 'vitest'
import { newestPerPlugin, runsOn, updateFor } from './registry'
import type { HostVersions, VersionedEntry } from './registry'

/**
 * The satisfying rule the update badge, the Update click and
 * `SPACES_PLUGINS_AUTOUPDATE=compatible` share: newer than installed,
 * `minCore` met, sdk range admitting this host's sdk.
 */

const host: HostVersions = { core: '0.4.0', sdk: '1.1.0' }

const entry = (
  version: string,
  extra: Partial<VersionedEntry> = {},
): VersionedEntry => ({ id: 'apollo', version, sdk: '^1.0', ...extra })

describe('runsOn', () => {
  it('admits an entry with no minCore and a range this sdk meets', () => {
    expect(runsOn(entry('1.0.0'), host)).toEqual({ ok: true })
    expect(runsOn(entry('1.0.0', { minCore: '0.4.0' }), host)).toEqual({
      ok: true,
    })
  })

  it('refuses a newer core, a newer sdk major and an unreadable minCore, naming both sides', () => {
    expect(runsOn(entry('1.2.0', { minCore: '0.5.0' }), host)).toEqual({
      ok: false,
      reason: '1.2.0 needs Spaces 0.5.0 or newer; this is 0.4.0',
    })
    expect(runsOn(entry('2.0.0', { sdk: '^2.0' }), host)).toEqual({
      ok: false,
      reason: '2.0.0 needs sdk ^2.0; this host provides 1.1.0',
    })
    expect(runsOn(entry('1.3.0', { minCore: 'soon' }), host)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable minCore'),
    })
  })
})

describe('updateFor', () => {
  it('offers the newest satisfying version past the installed one', () => {
    const offer = updateFor(
      [entry('1.0.0'), entry('1.1.0'), entry('1.0.5')],
      'apollo',
      '1.0.0',
      host,
    )
    expect(offer.target?.version).toBe('1.1.0')
    expect(offer.held).toBeNull()
  })

  it('offers nothing and says why when the newest needs a newer sdk major', () => {
    const offer = updateFor(
      [entry('1.0.0'), entry('2.0.0', { sdk: '^2.0' })],
      'apollo',
      '1.0.0',
      host,
    )
    expect(offer).toEqual({
      target: null,
      held: {
        version: '2.0.0',
        reason: '2.0.0 needs sdk ^2.0; this host provides 1.1.0',
      },
    })
  })

  it('offers nothing and says why when the newest needs a newer core', () => {
    const offer = updateFor(
      [entry('1.0.0'), entry('1.1.0', { minCore: '9.0.0' })],
      'apollo',
      '1.0.0',
      host,
    )
    expect(offer.target).toBeNull()
    expect(offer.held?.reason).toBe(
      '1.1.0 needs Spaces 9.0.0 or newer; this is 0.4.0',
    )
  })

  it('offers the newest it can run when the very newest is held, and says why too', () => {
    const offer = updateFor(
      [entry('1.0.0'), entry('1.1.0'), entry('2.0.0', { sdk: '^2.0' })],
      'apollo',
      '1.0.0',
      host,
    )
    expect(offer.target?.version).toBe('1.1.0')
    expect(offer.held?.version).toBe('2.0.0')
  })

  it('offers nothing for the installed version or an older one, and nothing for another plugin', () => {
    expect(
      updateFor([entry('1.0.0'), entry('0.9.0')], 'apollo', '1.0.0', host),
    ).toEqual({ target: null, held: null })
    expect(updateFor([entry('2.0.0')], 'rss', '1.0.0', host)).toEqual({
      target: null,
      held: null,
    })
  })
})

describe('newestPerPlugin', () => {
  it('is the newest entry per id this host can run, never one it cannot', () => {
    const newest = newestPerPlugin(
      [
        entry('1.0.0'),
        entry('2.0.0', { sdk: '^2.0' }),
        { id: 'rss', version: '0.1.0', sdk: '^1.0' },
        { id: 'rss', version: '0.2.0', sdk: '^1.0', minCore: '1.0.0' },
        { id: 'old', version: '1.0.0', sdk: '^9.0' },
      ],
      host,
    )
    expect(newest.map((e) => `${e.id}@${e.version}`)).toEqual([
      'apollo@1.0.0',
      'rss@0.1.0',
    ])
  })
})
