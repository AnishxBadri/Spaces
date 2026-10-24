/**
 * When Cmd-K asks, and which answers it may show. Pure — timers and
 * callbacks, no React, no Effect — so the palette holds one and a test
 * drives it with fake timers.
 *
 * Two waves per query, each with its own group:
 *
 * - **lexical**, 180ms after the last keystroke: Records. It embeds
 *   nothing, so typing a word bills no provider call per letter.
 * - **semantic**, 600ms after the last keystroke: Passages, the vector lane
 *   alone. Its answer fills its own group below Records and never replaces
 *   or reorders a row above it.
 *
 * - An answer lands only while its query is still the one typed: a slow
 *   answer to a query typed past is dropped.
 * - `start` says a wave's request went out, so the palette can mark its
 *   group head as running while it is pending.
 */

export const LEXICAL_DELAY_MS = 180
export const SEMANTIC_DELAY_MS = 600

export type Wave = 'lexical' | 'semantic'

/** One wave's request and where its answer goes. */
export type WaveLane<T> = {
  fetch: (q: string) => Promise<T>
  show: (rows: T) => void
  /** The request failed; the group shows nothing. */
  fail: () => void
}

export type SearchWavesOptions<TLexical, TSemantic> = {
  lexical: WaveLane<TLexical>
  semantic: WaveLane<TSemantic>
  /** A wave's request went out for the current query. */
  start?: (wave: Wave) => void
}

export type SearchWaves = {
  /** The query changed. */
  type: (q: string) => void
  /** The palette closed: nothing pending may land. */
  stop: () => void
}

export function searchWaves<TLexical, TSemantic>(
  opts: SearchWavesOptions<TLexical, TSemantic>,
): SearchWaves {
  let generation = 0
  let timers: Array<ReturnType<typeof setTimeout>> = []

  const clear = () => {
    for (const t of timers) clearTimeout(t)
    timers = []
  }

  function launch<T>(lane: WaveLane<T>, wave: Wave, q: string, gen: number) {
    opts.start?.(wave)
    lane.fetch(q).then(
      (rows) => {
        if (gen === generation) lane.show(rows)
      },
      () => {
        if (gen === generation) lane.fail()
      },
    )
  }

  return {
    type(raw) {
      clear()
      generation += 1
      const q = raw.trim()
      if (q.length < 2) return
      const gen = generation
      timers.push(
        setTimeout(
          () => launch(opts.lexical, 'lexical', q, gen),
          LEXICAL_DELAY_MS,
        ),
        setTimeout(
          () => launch(opts.semantic, 'semantic', q, gen),
          SEMANTIC_DELAY_MS,
        ),
      )
    },
    stop() {
      clear()
      generation += 1
    },
  }
}
