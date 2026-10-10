import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as ReactQuery from '@tanstack/react-query'
import type * as ReactRouter from '@tanstack/react-router'
import type * as PaletteModule from './command-palette'

/**
 * The palette is a window over the scrim (D70, amended): the solid shadow,
 * never the dithered one, over a bone-deep scrim; and it widens while the
 * preview pane is open. Mounted whole, with the router and the query cache
 * stubbed.
 */

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof ReactRouter>()),
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}))

vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof ReactQuery>()),
  useQuery: () => ({ data: [] }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let palette: typeof PaletteModule

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('HTMLInputElement', win.HTMLInputElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  vi.stubGlobal('ResizeObserver', win.ResizeObserver)
  // Radix's focus scope and portal reach for the rest of the DOM's classes.
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  palette = await import('./command-palette')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

describe('the palette window', () => {
  it('lifts on the solid shadow over a bone-deep scrim, and widens for the pane', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    const { CommandPalette } = palette
    act(() => root.render(<CommandPalette open onOpenChange={() => {}} />))

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    const content = document.querySelector('[data-slot="dialog-content"]')
    expect(overlay?.className).toContain('bg-bone-deep/60')
    // The scrim's own ground replaces the dialog default; nothing blurs.
    expect(overlay?.className).not.toContain('bg-black')
    expect(overlay?.className).not.toMatch(/backdrop-blur|\bblur\b/)
    expect(content?.className).toContain('shadow-solid')
    expect(content?.className).not.toContain('shadow-dither')
    expect(content?.className).toContain(
      'sm:has-[[data-preview]]:max-w-[66rem]',
    )

    act(() => root.unmount())
    host.remove()
    // Radix's focus scope hands focus back on a timer; let it run here.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
