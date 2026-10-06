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

/**
 * Every mounted `useHotkeys`, in effect order, behind one document listener.
 * - One armed chord for the whole page, not one per instance: a key that
 *   completes an armed chord is consumed by it and reaches no single-key
 *   binding in any instance.
 * - Any other key still visits each instance, as separate listeners did.
 */
const instances = new Set<{ current: Array<Binding> }>()
let armed: { key: string; at: number } | null = null

/** The handler of a mounted chord `first second`, if any instance has one. */
function chordHandler(first: string, second: string) {
  for (const inst of instances) {
    for (const [spec, handler] of inst.current) {
      if (spec.toLowerCase() === `${first} ${second}`) return handler
    }
  }
  return null
}

function onKey(e: KeyboardEvent) {
  const k = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  const now = Date.now()
  const arm = armed
  armed = null
  const live = arm && now - arm.at < CHORD_WINDOW_MS ? arm.key : null
  const guarded = mod || e.altKey || isTyping(e)

  if (live !== null && !guarded) {
    const handler = chordHandler(live, k)
    if (handler) {
      e.preventDefault()
      handler()
      return
    }
  }

  // A handler may unmount an instance mid-dispatch; skip the ones it did.
  for (const inst of [...instances]) {
    if (!instances.has(inst)) continue
    for (const [spec, handler] of inst.current) {
      const s = spec.toLowerCase()
      if (s.startsWith('mod+')) {
        if (mod && !e.altKey && k === s.slice(4)) {
          e.preventDefault()
          handler()
          break
        }
        continue
      }
      if (guarded) continue
      if (s.includes(' ')) {
        const [first] = s.split(' ')
        // An armed prefix whose second key completed nothing just disarms.
        if (live === first) continue
        if (k === first) {
          armed = { key: first, at: now }
          e.preventDefault()
          break
        }
        continue
      }
      if (k === s) {
        e.preventDefault()
        handler()
        break
      }
    }
  }
}

/** Many bindings; every instance shares one listener and one armed chord. */
export function useHotkeys(bindings: Array<Binding>) {
  const latest = useRef(bindings)
  latest.current = bindings
  // Re-register only when the set of keys changes; handlers read live.
  const signature = bindings.map(([k]) => k.toLowerCase()).join(' ')

  useEffect(() => {
    if (!signature) return
    const inst = latest
    if (instances.size === 0) document.addEventListener('keydown', onKey)
    instances.add(inst)
    return () => {
      instances.delete(inst)
      if (instances.size === 0) {
        document.removeEventListener('keydown', onKey)
        armed = null
      }
    }
  }, [signature])
}

/** One binding. Pass `undefined` to mount nothing. */
export function useHotkey(key: string | undefined, handler: () => void) {
  useHotkeys(key ? [[key, handler]] : [])
}
