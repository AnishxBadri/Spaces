import { useEffect, useRef } from 'react'

/**
 * Shortcuts for the page — the key printed inside a control must be true,
 * so the control and the hook share one string. Three shapes:
 *
 *   'T'        a bare key: ignored while typing, inside a dialog, or with a
 *              modifier held
 *   'g ,'      a chord: the first key arms it for 800ms, the second fires;
 *              same typing/dialog guards
 *   'mod+\\'   ⌘ on Mac, Ctrl elsewhere, plus a key: fires anywhere, even
 *              while typing, because it is deliberate
 */
export type Binding = [key: string, handler: () => void]

export const CHORD_WINDOW_MS = 800

function isTyping(e: KeyboardEvent) {
  const t = e.target
  if (!(t instanceof HTMLElement)) return false
  return (
    t.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
    t.closest('[role="dialog"]') !== null
  )
}

/** Many bindings, one listener; chords share one armed state. */
export function useHotkeys(bindings: Array<Binding>) {
  const armed = useRef<{ key: string; at: number } | null>(null)
  const latest = useRef(bindings)
  latest.current = bindings
  // Re-register only when the set of keys changes; handlers read live.
  const signature = bindings.map(([k]) => k.toLowerCase()).join(' ')

  useEffect(() => {
    if (!signature) return
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey
      const now = Date.now()
      const arm = armed.current
      armed.current = null
      for (const [spec, handler] of latest.current) {
        const s = spec.toLowerCase()
        if (s.startsWith('mod+')) {
          if (mod && !e.altKey && k === s.slice(4)) {
            e.preventDefault()
            handler()
            return
          }
          continue
        }
        if (mod || e.altKey || isTyping(e)) continue
        if (s.includes(' ')) {
          const [first, second] = s.split(' ')
          if (arm && arm.key === first && now - arm.at < CHORD_WINDOW_MS) {
            if (k === second) {
              e.preventDefault()
              handler()
              return
            }
            continue
          }
          if (k === first) {
            armed.current = { key: first, at: now }
            e.preventDefault()
            return
          }
          continue
        }
        if (k === s) {
          e.preventDefault()
          handler()
          return
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [signature])
}

/** One binding. Pass `undefined` to mount nothing. */
export function useHotkey(key: string | undefined, handler: () => void) {
  useHotkeys(key ? [[key, handler]] : [])
}
