import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEXICAL_DELAY_MS, SEMANTIC_DELAY_MS, searchWaves } from './waves'
import type { Wave } from './waves'

/**
 * The palette's two waves, on fake timers: Records first, Passages a beat
 * later into a group of its own. `fetch` answers each request with a
 * promise the test resolves by hand, so "in flight" is a state the test can
 * hold the scheduler in.
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
  const started: Array<Wave> = []
  const failed: Array<Wave> = []
  const lane = (wave: Wave) => ({
    fetch: (q: string) =>
      new Promise<string>((resolve, reject) => {
        requests.push({ q, wave, resolve, reject })
      }),
    show: (rows: string) => shown.push([rows, wave]),
    fail: () => failed.push(wave),
  })
  const waves = searchWaves<string, string>({
    lexical: lane('lexical'),
    semantic: lane('semantic'),
    start: (wave) => started.push(wave),
  })
  const answer = async (i: number, rows: string) => {
    requests[i]?.resolve(rows)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { waves, requests, shown, started, failed, answer }
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
  it('asks for Records 180ms after the last keystroke, then Passages at 600ms, each into its own group', async () => {
    const { waves, requests, shown, started, answer } = harness()

    await typeOut(waves, 'heat', 90)
    // 90ms gaps never reach the 180ms debounce, so nothing has been asked.
    expect(requests).toEqual([])

    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS - 90 - 1)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map((r) => [r.q, r.wave])).toEqual([['heat', 'lexical']])
    expect(started).toEqual(['lexical'])
    await answer(0, 'records')
    expect(shown).toEqual([['records', 'lexical']])

    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS - LEXICAL_DELAY_MS - 1)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map((r) => [r.q, r.wave])).toEqual([
      ['heat', 'lexical'],
      ['heat', 'semantic'],
    ])
    // The head can run from here: the request is out.
    expect(started).toEqual(['lexical', 'semantic'])
    await answer(1, 'passages')
    // The second answer is added beside the first, never in its place.
    expect(shown).toEqual([
      ['records', 'lexical'],
      ['passages', 'semantic'],
    ])
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

  it('ignores answers for a query the user has typed past', async () => {
    const { waves, requests, shown, answer } = harness()

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    await answer(1, 'passages heat')
    await answer(0, 'records heat')
    // Either order lands: they fill different groups.
    expect(shown).toEqual([
      ['passages heat', 'semantic'],
      ['records heat', 'lexical'],
    ])

    waves.type('heath')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    waves.type('heat')
    await answer(2, 'records heath')
    expect(shown).toHaveLength(2)
    expect(requests).toHaveLength(3)
  })

  it('reports a failure to the wave that failed only', async () => {
    const { waves, requests, shown, failed, answer } = harness()

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    await answer(0, 'records')
    requests[1]?.reject(new Error('network'))
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toEqual([['records', 'lexical']])
    expect(failed).toEqual(['semantic'])
  })

  it('asks nothing under two characters, and nothing after stop', async () => {
    const { waves, requests, answer, shown } = harness()

    waves.type(' h ')
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    expect(requests).toEqual([])

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(100)
    waves.stop()
    await vi.advanceTimersByTimeAsync(SEMANTIC_DELAY_MS)
    expect(requests).toEqual([])

    waves.type('heat')
    await vi.advanceTimersByTimeAsync(LEXICAL_DELAY_MS)
    waves.stop()
    await answer(0, 'records')
    expect(shown).toEqual([])
  })
})
