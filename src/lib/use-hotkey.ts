import { useEffect, useRef } from 'react'

/**
 * A shortcut for the page — the key printed inside a control must be true,
 * so the control and the hook share one string. Three shapes:
 *
 *   'T'        a bare key: ignored while typing, inside a dialog, or with a
 *              modifier held
 *   'g ,'      a chord: the first key arms it for 800ms, the second fires;
 *              same typing/dialog guards
 *   'mod+\\'   ⌘ on Mac, Ctrl elsewhere, plus a key: fires anywhere, even
 *              while typing, because it is deliberate
 *
 * Pass `undefined` to mount nothing.
 */
export function useHotkey(key: string | undefined, handler: () => void) {
  const armed = useRef<number | null>(null)
  useEffect(() => {
    if (!key) return
    const spec = key.toLowerCase()
    const isMod = spec.startsWith('mod+')
    const modKey = isMod ? spec.slice(4) : null
    const chord = !isMod && spec.includes(' ') ? spec.split(' ') : null
    const single = !isMod && !chord ? spec : null

    function typing(e: KeyboardEvent) {
      const t = e.target
      if (!(t instanceof HTMLElement)) return false
      return (
        t.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
        t.closest('[role="dialog"]') !== null
      )
    }

    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()
      if (modKey) {
        if (!(e.metaKey || e.ctrlKey) || e.altKey || k !== modKey) return
        e.preventDefault()
        handler()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (typing(e)) return
      if (single) {
        if (k !== single) return
        e.preventDefault()
        handler()
        return
      }
      if (chord) {
        const [first, second] = chord
        const now = Date.now()
        if (armed.current !== null && now - armed.current < 800) {
          armed.current = null
          if (k === second) {
            e.preventDefault()
            handler()
          }
          return
        }
        if (k === first) {
          armed.current = now
          e.preventDefault()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [key, handler])
}
