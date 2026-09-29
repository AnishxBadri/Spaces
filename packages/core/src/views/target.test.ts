import { describe, expect, it } from 'vitest'
import { surfaceKey, viewTarget } from './target'

// views-1 (D2): the surface key the three view server fns take. The old
// `objectKey` refine accepted a call with neither kind nor objectId and
// resolved it to 'company'; that call is now a validation error.

describe('surface key', () => {
  it('takes an object surface named by kind or by id, never by neither', () => {
    expect(
      surfaceKey.safeParse({ surface: 'object', kind: 'deal' }).success,
    ).toBe(true)
    expect(
      surfaceKey.safeParse({
        surface: 'object',
        objectId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true)

    const neither = surfaceKey.safeParse({ surface: 'object' })
    expect(neither.success).toBe(false)
    expect(JSON.stringify(neither.error)).toContain(
      'Give exactly one of kind or objectId',
    )

    // Both is ambiguous, so it is refused too.
    expect(
      surfaceKey.safeParse({
        surface: 'object',
        kind: 'deal',
        objectId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false)
  })

  it('takes a document surface, which names no object', () => {
    expect(surfaceKey.safeParse({ surface: 'document' }).success).toBe(true)
    // A surface value that does not exist is not a view surface.
    expect(surfaceKey.safeParse({ surface: 'task' }).success).toBe(false)
    // And the surface is required: there is no default discriminator.
    expect(surfaceKey.safeParse({ kind: 'company' }).success).toBe(false)
  })

  it('maps a page object id onto its target both ways', () => {
    expect(viewTarget('00000000-0000-4000-8000-000000000001')).toEqual({
      surface: 'object',
      objectId: '00000000-0000-4000-8000-000000000001',
    })
    expect(viewTarget(null)).toEqual({ surface: 'document' })
  })
})
