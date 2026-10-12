import { useEffect, useState } from 'react'
import { askWebSources } from '#/lib/server-fns'
import type { WebSource } from '#/lib/server-fns'

/**
 * The plugins a turn can mount, as the dock's web chip and the space head's
 * Find companies read them. Asked once a minute per browser, whoever asks.
 */

const FRESH_MS = 60_000

let cached: { at: number; sources: ReadonlyArray<WebSource> } | null = null
let asking: Promise<ReadonlyArray<WebSource>> | null = null

function ask(): Promise<ReadonlyArray<WebSource>> {
  if (cached !== null && Date.now() - cached.at < FRESH_MS)
    return Promise.resolve(cached.sources)
  asking ??= askWebSources()
    .then((sources) => {
      cached = { at: Date.now(), sources }
      return sources
    })
    .finally(() => {
      asking = null
    })
  return asking
}

export function useWebSources(): ReadonlyArray<WebSource> {
  const [sources, setSources] = useState<ReadonlyArray<WebSource>>(
    () => cached?.sources ?? [],
  )
  useEffect(() => {
    let alive = true
    ask().then(
      (next) => {
        if (alive) setSources(next)
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])
  return sources
}

/** Forget what was asked; a test starts clean. */
export const forgetWebSources = () => {
  cached = null
}
