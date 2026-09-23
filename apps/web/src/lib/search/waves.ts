/**
 * When Cmd-K asks, and which answer it may show (SPA-129). Pure — timers and
 * two callbacks, no React, no Effect — so the palette holds one and a test
 * drives it with fake timers.
 *
 * Two waves per query:
 *
 * - **lexical**, 180ms after the last keystroke, as the palette always has:
 *   names, notes, documents, tasks. It embeds nothing, so typing a word
 *   bills no provider call per letter.
 * - **semantic**, 600ms after the last keystroke: the same fused query plus
 *   the vector lane. Its answer replaces the list.
 *
 * The second wave is **suppressed once the user has taken the list** —
 * moved the selection (arrow keys, or the pointer over a row) or pressed
 * Enter — both before it fires and after, while it is in flight: no row
 * ever moves under the cursor. A new keystroke is a new query, and the
 * list is the user's to lose again.
 *
 * Nothing about the second wave is drawn: no spinner, no "searching by
 * meaning" row (DESIGN.md §Motion: no load choreography — pages appear
 * settled). The list simply updates, or does not.
 */

export const LEXICAL_DELAY_MS = 180
export const SEMANTIC_DELAY_MS = 600

export type Wave = 'lexical' | 'semantic'

export type SearchWavesOptions<T> = {
  /** Ask the server; `wave` says whether to add the vector lane. */
  fetch: (q: string, wave: Wave) => Promise<T>
  /** An answer the palette may show — the current query's, still wanted. */
  show: (rows: T, wave: Wave) => void
  /**
   * The lexical wave failed. A failed second wave calls nothing: the
   * lexical list is already a whole answer, so it stays.
   */
  fail: () => void
}

export type SearchWaves = {
  /** The query changed. */
  type: (q: string) => void
  /** The user moved the selection or pressed Enter: the list is theirs. */
  engage: () => void
  /** The palette closed: nothing pending may land. */
  stop: () => void
}

export function searchWaves<T>(opts: SearchWavesOptions<T>): SearchWaves {
  let generation = 0
  let engaged = false
  let semanticShown = false
  let timers: Array<ReturnType<typeof setTimeout>> = []

  const clear = () => {
    for (const t of timers) clearTimeout(t)
    timers = []
  }

  const launch = (q: string, wave: Wave, gen: number) => {
    opts.fetch(q, wave).then(
      (rows) => {
        // Out-of-order answers would otherwise show results for a query
        // the user has already typed past.
        if (gen !== generation) return
        if (wave === 'semantic') {
          if (engaged) return
          semanticShown = true
        } else if (semanticShown) {
          // A slow lexical answer must not undo the fuller one.
          return
        }
        opts.show(rows, wave)
      },
      () => {
        if (gen === generation && wave === 'lexical' && !semanticShown)
          opts.fail()
      },
    )
  }

  return {
    type(raw) {
      clear()
      generation += 1
      engaged = false
      semanticShown = false
      const q = raw.trim()
      if (q.length < 2) return
      const gen = generation
      timers.push(
        setTimeout(() => launch(q, 'lexical', gen), LEXICAL_DELAY_MS),
        setTimeout(() => {
          if (!engaged) launch(q, 'semantic', gen)
        }, SEMANTIC_DELAY_MS),
      )
    },
    engage() {
      engaged = true
    },
    stop() {
      clear()
      generation += 1
    },
  }
}

/**
 * The keys that move cmdk's selection or act on it — what `engage` means
 * from the keyboard. cmdk also binds Ctrl+N/P and, with `vimBindings`
 * (its default), Ctrl+J/K.
 */
export function takesTheList(e: { key: string; ctrlKey: boolean }): boolean {
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'Home':
    case 'End':
    case 'Enter':
      return true
    case 'n':
    case 'p':
    case 'j':
    case 'k':
      return e.ctrlKey
    default:
      return false
  }
}
