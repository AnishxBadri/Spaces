import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { noteKindInput } from './kind-input'

const accepts = Schema.is(noteKindInput)

describe('noteKindInput', () => {
  it('accepts the two kinds', () => {
    expect(noteKindInput.literals).toEqual(['note', 'memo'])
    expect(accepts('note')).toBe(true)
    expect(accepts('memo')).toBe(true)
  })

  it('refuses scratch', () => {
    expect(accepts('scratch')).toBe(false)
  })
})
