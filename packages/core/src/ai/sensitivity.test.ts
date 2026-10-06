import { describe, expect, it } from 'vitest'
import { resolveSensitivity } from './sensitivity'
import type { SensitivityInputs } from './sensitivity'

/**
 * SPA-61. The resolver is pure: no Postgres, no drizzle. Six cases — one per
 * authored input plus nothing sensitive — and the two that make the OR
 * cautious.
 */

const NONE: SensitivityInputs = {
  own: false,
  spaces: [],
  binding: null,
  workspaceDefault: 'normal',
}

describe('resolveSensitivity', () => {
  it('own flag', () => {
    expect(resolveSensitivity({ ...NONE, own: true })).toEqual({
      sensitivity: 'sensitive',
      via: { kind: 'own' },
    })
  })

  it('filed space', () => {
    expect(
      resolveSensitivity({
        ...NONE,
        spaces: [{ name: 'Hydrogen', sensitive: true }],
      }),
    ).toEqual({
      sensitivity: 'sensitive',
      via: { kind: 'space', name: 'Hydrogen' },
    })
  })

  it('ancestor space — the nearest sensitive one is named', () => {
    expect(
      resolveSensitivity({
        ...NONE,
        spaces: [
          { name: 'Electrolysers', sensitive: false },
          { name: 'Green hydrogen', sensitive: false },
          { name: 'Hydrogen', sensitive: true },
        ],
      }),
    ).toEqual({
      sensitivity: 'sensitive',
      via: { kind: 'space', name: 'Hydrogen' },
    })
  })

  it('binding', () => {
    expect(
      resolveSensitivity({
        ...NONE,
        binding: { sensitivity: 'sensitive', name: 'Board drive' },
      }),
    ).toEqual({
      sensitivity: 'sensitive',
      via: { kind: 'binding', name: 'Board drive' },
    })
    expect(
      resolveSensitivity({ ...NONE, binding: { sensitivity: 'inherit' } }),
    ).toEqual({ sensitivity: 'normal' })
  })

  it('workspace default', () => {
    expect(
      resolveSensitivity({ ...NONE, workspaceDefault: 'sensitive' }),
    ).toEqual({ sensitivity: 'sensitive', via: { kind: 'default' } })
  })

  it('nothing sensitive', () => {
    expect(
      resolveSensitivity({
        ...NONE,
        spaces: [{ name: 'Aerospace', sensitive: false }],
        binding: { sensitivity: 'inherit' },
      }),
    ).toEqual({ sensitivity: 'normal' })
  })

  it('is a cautious OR: filed in two places, one sensitive, resolves sensitive', () => {
    expect(
      resolveSensitivity({
        ...NONE,
        spaces: [
          { name: 'Aerospace', sensitive: false },
          { name: 'Hydrogen', sensitive: true },
        ],
      }).sensitivity,
    ).toBe('sensitive')
  })

  it('a record filed nowhere resolves the workspace default rather than throwing', () => {
    expect(resolveSensitivity(NONE)).toEqual({ sensitivity: 'normal' })
    expect(
      resolveSensitivity({ ...NONE, workspaceDefault: 'sensitive' })
        .sensitivity,
    ).toBe('sensitive')
  })

  it('no input can make another less sensitive: own wins over an inherit binding and a normal default', () => {
    expect(
      resolveSensitivity({
        own: true,
        spaces: [{ name: 'Aerospace', sensitive: false }],
        binding: { sensitivity: 'inherit' },
        workspaceDefault: 'normal',
      }).sensitivity,
    ).toBe('sensitive')
  })
})
