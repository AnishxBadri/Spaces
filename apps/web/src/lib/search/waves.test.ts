import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEXICAL_DELAY_MS,
  SEMANTIC_DELAY_MS,
  searchWaves,
  takesTheList,
} from './waves'
import type { Wave } from './waves'

/**
 * The palette's two waves (SPA-129), on fake timers. `fetch` answers each
 * request with a promise the test resolves by hand, so "in flight" is a
 * state the test can hold the scheduler in.
 */

type Pending = {
  q: string
  wave: Wave
  resolve: (rows: string) => void
  reject: (e: Error) => void
}

function harness() {
  const requests: Array<Pending> = []
  const shown: Array<[string, Wave]> = []
  let failed = 0
  const waves = searchWaves<string>({
    fetch: (q, wave) =>
      new Promise((resolve, reject) => {
        requests.push({ q, wave, resolve, reject })
      }),
    show: (rows, wave) => shown.push([rows, wave]),
    fail: () => {
      failed += 1
    },
  })
  const answer = async (i: number, rows: string) => {
    requests[i]?.resolve(rows)
    await vi.advanceTimersByTimeAsync(0)
  }
  return {
    waves,
    requests,
    shown,
    answer,
    failed: () => failed,
  }
}

/** Type a phrase a letter at a time, `gap` ms apart. */
async function typeOut(
  waves: { type: (q: string) => void },
  phrase: string,
  gap = 90,
) {
  for (let n = 1; n <= phrase.length; n++) {
    waves.type(phrase.slice(0, n))
    await vi.advanceTimersByTimeAsync(gap)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('searchWaves', () => {
  it('asks lexically 180ms after the last keystroke, then semantically at 600ms, and the second answer replaces the first', async () => {
    const { waves, requests, shown, answer } = harness()

    await typeOut(waves, 'heat', 90)
    // 90ms gaps never reach the 180ms debounce, so nothing has been asked.
    expect(requests).toEqual([])

    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS - 90 - 1)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map((r) => [r.q, r.wave])).toEqual([['heat', 'lexical']])
    await answer(0, 'lexical rows')
    expect(shown).toEqual([['lexical rows', 'lexical']])

    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS - LEXICAL_DELAY_MS - 1)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map((r) => [r.q, r.wave])).toEqual([
      ['heat', 'lexical'],
      ['heat', 'semantic'],
    ])
    await answer(1, 'fused rows')
    expect(shown.at(-1)).toEqual(['fused rows', 'semantic'])
  })

  it('restarts both clocks on every keystroke: one pair of requests per pause', async () => {
    const { waves, requests } = harness()

    waves.type('he')
    await vi.advanceTimersByTimeAsync(500)
    waves.type('hea')
    await vi.advanceTimersByTimeAsync(500)
    waves.type('heat')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)

    expect(requests.map((r) => [r.q, r.wave])).toEqual([
      ['he', 'lexical'],
      ['hea', 'lexical'],
      ['heat', 'lexical'],
      ['heat', 'semantic'],
    ])
  })

  it('never fires the second wave once the selection has moved', async () => {
    const { waves, requests, answer } = harness()

    waves.type('heat rejection')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    await answer(0, 'lexical rows')
    waves.engage()
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS * 2)

    expect(requests.map((r) => r.wave)).toEqual(['lexical'])
  })

  it('drops a second wave already in flight when the user takes the list before it lands', async () => {
    const { waves, requests, shown, answer } = harness()

    waves.type('heat rejection')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    await answer(0, 'lexical rows')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS - LEXICAL_DELAY_MS)
    expect(requests.map((r) => r.wave)).toEqual(['lexical', 'semantic'])

    // Enter (or an arrow) while the request is out: no row moves under it.
    waves.engage()
    await answer(1, 'fused rows')
    expect(shown).toEqual([['lexical rows', 'lexical']])
  })

  it('arms the second wave again for the next query', async () => {
    const { waves, requests } = harness()

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    waves.engage()
    waves.type('heat rejection')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)

    expect(requests.map((r) => [r.q, r.wave])).toEqual([
      ['heat', 'lexical'],
      ['heat rejection', 'lexical'],
      ['heat rejection', 'semantic'],
    ])
  })

  it('ignores answers for a query the user has typed past, and a slow lexical answer after the fuller one', async () => {
    const { waves, requests, shown, answer } = harness()

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    // Both waves for "heat" are out; the semantic answer lands first.
    await answer(1, 'fused heat')
    await answer(0, 'lexical heat')
    expect(shown).toEqual([['fused heat', 'semantic']])

    waves.type('heath')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    waves.type('heat')
    await answer(2, 'lexical heath')
    expect(shown).toEqual([['fused heat', 'semantic']])
    expect(requests).toHaveLength(3)
  })

  it('keeps the lexical list when the second wave fails, and clears it when the lexical wave fails', async () => {
    const { waves, requests, shown, answer, failed } = harness()

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    await answer(0, 'lexical rows')
    requests[1]?.reject(new Error('network'))
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toEqual([['lexical rows', 'lexical']])
    expect(failed()).toBe(0)

    waves.type('heat r')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    requests[2]?.reject(new Error('network'))
    await vi.advanceTimersByTimeAsync(0)
    expect(failed()).toBe(1)
  })

  it('asks nothing under two characters, and nothing after stop', async () => {
    const { waves, requests } = harness()

    waves.type(' h ')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    expect(requests).toEqual([])

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(100)
    waves.stop()
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    expect(requests).toEqual([])
  })
})

describe('takesTheList', () => {
  it('is the keys cmdk moves or acts on the selection with', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'])
      expect(takesTheList({ key, ctrlKey: false })).toBe(true)
    for (const key of ['n', 'p', 'j', 'k'])
      expect(takesTheList({ key, ctrlKey: true })).toBe(true)
    for (const key of ['n', 'a', 'Backspace', ' ', 'ArrowLeft'])
      expect(takesTheList({ key, ctrlKey: false })).toBe(false)
  })
})
