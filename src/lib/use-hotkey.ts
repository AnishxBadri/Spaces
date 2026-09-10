import { useEffect } from 'react'

/**
 * A bare-key shortcut for the page — the key printed inside a button must be
 * true, so the button and the hook share one string. Ignored while typing
 * (inputs, textareas, contenteditable), inside an open dialog, and with any
 * modifier held. Pass `undefined` to mount nothing.
 */
export function useHotkey(key: string | undefined, handler: () => void) {
  useEffect(() => {
    if (!key) return
    const wanted = key.toLowerCase()
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== wanted) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
          t.closest('[role="dialog"]'))
      )
        return
      e.preventDefault()
      handler()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [key, handler])
}
