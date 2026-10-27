import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_MS, createHeldDecisions } from './held-decisions'
import type { HeldDeps } from './held-decisions'
import { alreadyDecidedMessage } from './inbox/held'
import type { HeldDecision } from './inbox/held'

/**
 * The undo hold: a decision hides its row and writes nothing until the hold
 * runs out; Undo inside it means no request at all.
 */

const ID = '00000000-0000-4000-8000-000000000001'
const accept: HeldDecision = { verb: 'accept', id: ID }

function harness() {
  const shown: Array<{ key: string; label: string; undo: () => void }> = []
  const dismissed: Array<string> = []
  const errors: Array<string> = []
  const beacons: Array<ReadonlyArray<HeldDecision>> = []
  const deps: HeldDeps = {
    now: () => 0,
    show: (key, label, undo) => void shown.push({ key, label, undo }),
    dismiss: (key) => void dismissed.push(key),
    error: (message) => void errors.push(message),
    beacon: (decisions) => {
      beacons.push(decisions)
      return true
    },
  }
  const store = createHeldDecisions(deps)
  const invalidate = vi.fn(async () => undefined)
  store.setInvalidate(invalidate)
  return { store, shown, dismissed, errors, beacons, invalidate }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the hold', () => {
  it('hides the row and shows the toast, writing nothing yet', () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    h.store.hold(ID, {
      decision: accept,
      commit,
      label: 'Accepted on Exponent',
    })
    expect(h.store.snapshot().get(ID)).toMatchObject({
      verb: 'accept',
      label: 'Accepted on Exponent',
    })
    expect(h.shown).toEqual([
      expect.objectContaining({ key: ID, label: 'Accepted on Exponent' }),
    ])
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('undo within the hold: no server call, and the row is back', async () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    vi.advanceTimersByTime(HOLD_MS - 100)
    h.shown[0]?.undo()
    expect(h.store.snapshot().has(ID)).toBe(false)
    expect(h.dismissed).toEqual([ID])
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    expect(commit).not.toHaveBeenCalled()
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('expiry: one call, then the router refreshes and the entry leaves', async () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.store.snapshot().has(ID)).toBe(false)
    // Undo after the write is too late, and does nothing.
    expect(h.store.undo(ID)).toBe(false)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('stays hidden while the write is in flight', async () => {
    const h = harness()
    let land: () => void = () => undefined
    const commit = vi.fn(
      () => new Promise<void>((resolve) => (land = () => resolve())),
    )
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(h.store.snapshot().has(ID)).toBe(true)
    expect(h.store.undo(ID)).toBe(false)
    land()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.snapshot().has(ID)).toBe(false)
  })

  it('failure brings the row back with the error', async () => {
    const h = harness()
    const commit = vi.fn(async () => {
      throw new Error('That record no longer exists')
    })
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.store.snapshot().has(ID)).toBe(false)
    expect(h.errors).toEqual(['That record no longer exists'])
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('a decision made elsewhere first refreshes silently', async () => {
    const h = harness()
    const commit = vi.fn(async () => {
      throw new Error(alreadyDecidedMessage('accepted'))
    })
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(h.errors).toEqual([])
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.store.snapshot().has(ID)).toBe(false)
  })

  it('a caller that settles its own row is not refreshed for', async () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    h.store.hold(ID, {
      decision: accept,
      commit,
      label: 'Accepted',
      invalidate: false,
    })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.invalidate).not.toHaveBeenCalled()
  })
})

describe('leaving', () => {
  it('the page going sends every held decision in one beacon, and writes none itself', async () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    const dismiss: HeldDecision = {
      verb: 'dismiss-duplicate',
      candidateId: '00000000-0000-4000-8000-000000000002',
    }
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    h.store.hold('pair', { decision: dismiss, commit, label: 'Dismissed' })
    h.store.beaconAll()
    expect(h.beacons).toEqual([[accept, dismiss]])
    expect(h.store.snapshot().size).toBe(0)
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    expect(commit).not.toHaveBeenCalled()
  })

  it('sign-out writes every held decision first', async () => {
    const h = harness()
    const commit = vi.fn(async () => undefined)
    h.store.hold(ID, { decision: accept, commit, label: 'Accepted' })
    await h.store.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(h.store.snapshot().size).toBe(0)
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
