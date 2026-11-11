import { describe, expect, it } from 'vitest'
import { noteKindInput } from './kind-input'

describe('noteKindInput', () => {
  it('accepts the two kinds', () => {
    expect(noteKindInput.options).toEqual(['note', 'memo'])
    expect(noteKindInput.safeParse('note').success).toBe(true)
    expect(noteKindInput.safeParse('memo').success).toBe(true)
  })

  it('refuses scratch', () => {
    expect(noteKindInput.safeParse('scratch').success).toBe(false)
  })
})
