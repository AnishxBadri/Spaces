import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** What a fixed pane's folder body takes to scroll and remember its place. */
export type FolderScroll = {
  ref: RefObject<HTMLDivElement | null>
  onScroll: () => void
}

/**
 * Where each tab of one page was scrolled to. Only the open tab mounts, so
 * it holds the number, not the node. A new `scope` (another record under
 * the same route) forgets the last one's places: it opens at the top.
 */
type TabScrollMemory = {
  keep: (scope: string, tab: string, top: number) => void
  recall: (scope: string, tab: string) => number
}

export function tabScrollMemory(): TabScrollMemory {
  let scope: string | null = null
  const tops = new Map<string, number>()
  const enter = (next: string) => {
    if (next === scope) return
    scope = next
    tops.clear()
  }
  return {
    keep(s, tab, top) {
      enter(s)
      tops.set(tab, top)
    },
    recall(s, tab) {
      enter(s)
      return tops.get(tab) ?? 0
    },
  }
}

/**
 * The folder body's scroller in a fixed pane: each tab keeps its own place,
 * restored before paint when it opens again. Below `xl` the body does not
 * scroll, so setting its `scrollTop` is a no-op and the page scrolls as one.
 */
export function useFolderScroll(scope: string, tab: string): FolderScroll {
  const ref = useRef<HTMLDivElement>(null)
  const [memory] = useState(tabScrollMemory)
  // The scroll handler files under the tab now open: a scroll the switch
  // itself causes (a shorter tab clamping) lands after this is updated.
  const open = useRef({ scope, tab })

  useLayoutEffect(() => {
    open.current = { scope, tab }
    const el = ref.current
    if (el) el.scrollTop = memory.recall(scope, tab)
  }, [memory, scope, tab])

  const onScroll = () => {
    const el = ref.current
    if (el) memory.keep(open.current.scope, open.current.tab, el.scrollTop)
  }
  return { ref, onScroll }
}
