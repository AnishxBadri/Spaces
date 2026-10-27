import { Window } from 'happy-dom'

/**
 * A happy-dom window's DOM globals, installed by hand before React loads —
 * the happy-dom environment would also replace `URL`, which the database
 * setup file needs as node's. Call it from `vi.hoisted`.
 */
export function installHappyGlobals(url = 'http://localhost/'): Window {
  const win = new Window({ url })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'getComputedStyle',
    // Node has its own; events dispatched on happy-dom nodes must be its.
    'Event',
    'CustomEvent',
    'EventTarget',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  // Radix's focus scope and portal reach for the DOM's classes.
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      Reflect.set(globalThis, name, Reflect.get(win, name))
  Reflect.set(globalThis, 'requestAnimationFrame', (cb: () => void) =>
    setTimeout(cb, 0),
  )
  Reflect.set(globalThis, 'cancelAnimationFrame', (id: number) =>
    clearTimeout(id),
  )
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  return win
}
