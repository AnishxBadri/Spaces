import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData, nonEmpty, uuid } from './job-data'

const U = 'a3bb189e-8bf9-4888-9912-ace4e6543002'

const payload = Schema.Struct({
  documentId: uuid,
  userId: nonEmpty,
  capture: Schema.optional(Schema.Struct({ objectId: uuid })),
})

describe('decodeJobData', () => {
  it('hands back the decoded payload', () => {
    expect(decodeJobData(payload, { documentId: U, userId: 'u' })).toEqual(
      Result.succeed({ documentId: U, userId: 'u' }),
    )
  })

  it('names every failing field by its path, all at once', () => {
    const decoded = decodeJobData(payload, {
      documentId: 'x',
      capture: { objectId: 'y' },
    })
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) return
    expect(decoded.failure).toContain('documentId: Invalid UUID')
    expect(decoded.failure).toContain('userId: ')
    expect(decoded.failure).toContain('capture.objectId: Invalid UUID')
    expect(decoded.failure.split('; ')).toHaveLength(3)
  })

  it('says (root) for a payload that is not an object', () => {
    const decoded = decodeJobData(payload, null)
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) return
    expect(decoded.failure).toMatch(/^\(root\): /)
  })
})
