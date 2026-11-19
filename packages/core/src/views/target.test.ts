import { Result, SchemaIssue, SchemaParser } from 'effect'
import { describe, expect, it } from 'vitest'
import { surfaceKey, viewTarget } from './target'

// The surface key the three view server fns take. A call with neither kind
// nor objectId is a validation error, never a silent resolve to 'company'.

const decode = SchemaParser.decodeUnknownResult(surfaceKey)
const accepts = (value: unknown) => Result.isSuccess(decode(value))
const messages = SchemaIssue.makeFormatterStandardSchemaV1()

describe('surface key', () => {
  it('takes an object surface named by kind or by id, never by neither', () => {
    expect(accepts({ surface: 'object', kind: 'deal' })).toBe(true)
    expect(
      accepts({
        surface: 'object',
        objectId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe(true)

    const neither = decode({ surface: 'object' })
    expect(Result.isFailure(neither)).toBe(true)
    if (Result.isSuccess(neither)) return
    expect(
      messages(neither.failure).issues.map((issue) => issue.message),
    ).toContain('Give exactly one of kind or objectId')

    // Both is ambiguous, so it is refused too.
    expect(
      accepts({
        surface: 'object',
        kind: 'deal',
        objectId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe(false)
  })

  it('takes a document surface, which names no object', () => {
    expect(accepts({ surface: 'document' })).toBe(true)
    // A surface value that does not exist is not a view surface.
    expect(accepts({ surface: 'task' })).toBe(false)
    // And the surface is required: there is no default discriminator.
    expect(accepts({ kind: 'company' })).toBe(false)
  })

  it('maps a page object id onto its target both ways', () => {
    expect(viewTarget('00000000-0000-4000-8000-000000000001')).toEqual({
      surface: 'object',
      objectId: '00000000-0000-4000-8000-000000000001',
    })
    expect(viewTarget(null)).toEqual({ surface: 'document' })
  })
})
