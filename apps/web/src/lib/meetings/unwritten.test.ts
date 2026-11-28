import { describe, expect, it } from 'vitest'
import { isUnwritten } from './unwritten'

/** The grace hour: a recorded meeting owes a write-up only an hour after it ends. */

const ended = '2026-10-15T10:00:00.000Z'
const after = (minutes: number) =>
  new Date(Date.parse(ended) + minutes * 60_000)
const meeting = {
  noteId: null,
  cancelled: false,
  endsAt: ended,
  nothingToNote: false,
}

describe('isUnwritten', () => {
  it('waits an hour after a recorded meeting ends', () => {
    const recorded = { ...meeting, recorded: true }
    expect(isUnwritten(recorded, after(0))).toBe(false)
    expect(isUnwritten(recorded, after(59))).toBe(false)
    expect(isUnwritten(recorded, after(60))).toBe(true)
  })

  it('owes one at once when nobody attending has a recorder', () => {
    expect(isUnwritten({ ...meeting, recorded: false }, after(0))).toBe(true)
  })

  it('owes none once written, or when cancelled', () => {
    const late = after(120)
    expect(
      isUnwritten({ ...meeting, recorded: false, noteId: 'n1' }, late),
    ).toBe(false)
    expect(
      isUnwritten({ ...meeting, recorded: false, cancelled: true }, late),
    ).toBe(false)
  })

  it('owes none once a member marked it nothing to note', () => {
    const late = after(120)
    expect(
      isUnwritten({ ...meeting, recorded: false, nothingToNote: true }, late),
    ).toBe(false)
    expect(
      isUnwritten({ ...meeting, recorded: true, nothingToNote: true }, late),
    ).toBe(false)
  })
})
