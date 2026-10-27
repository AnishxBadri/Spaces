import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as ReactQuery from '@tanstack/react-query'
import type * as ReactRouter from '@tanstack/react-router'
import type * as PaletteModule from './command-palette'
import type * as PageActionsModule from '#/lib/page-actions'
import type * as ServerFns from '#/lib/server-fns'

/**
 * The palette is a window over the scrim: the solid shadow, never the
 * dithered one, over a bone-deep scrim, and one fixed size whatever it is
 * showing — nothing typed, typing, still looking, nothing found, a step.
 * Mounted whole, with the router, the query cache and the two searches
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

// `zzqx` finds nothing in either wave; anything else keeps Passages looking.
vi.mock('#/lib/server-fns', async (original) => ({
  ...(await original<typeof ServerFns>()),
  searchAll: async () => [],
  searchPassages: ({ data }: { data: { q: string } }) =>
    data.q === 'zzqx' ? Promise.resolve([]) : new Promise(() => {}),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let palette: typeof PaletteModule
let pageActions: typeof PageActionsModule

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
  pageActions = await import('#/lib/page-actions')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

const content = () => {
  const el = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
  if (!el) throw new Error('no window')
  return el
}

/** The window's size as drawn, and every class that could resize it. */
function box() {
  const el = content()
  return {
    className: el.className,
    pane: el.querySelector('aside[aria-label="Preview"]')?.className ?? null,
  }
}

function type(value: string) {
  const el = document.querySelector('input')
  if (!el) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    'value',
  )?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

describe('the palette window', () => {
  it('lifts on the solid shadow over a bone-deep scrim', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    const { CommandPalette } = palette
    act(() => root.render(<CommandPalette open onOpenChange={() => {}} />))

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay?.className).toContain('bg-bone-deep/60')
    // The scrim's own ground replaces the dialog default; nothing blurs.
    expect(overlay?.className).not.toContain('bg-black')
    expect(overlay?.className).not.toMatch(/backdrop-blur|\bblur\b/)
    expect(content().className).toContain('shadow-solid')
    expect(content().className).not.toContain('shadow-dither')

    act(() => root.unmount())
    host.remove()
    // Radix's focus scope hands focus back on a timer; let it run here.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it('keeps one fixed size in every state: nothing typed, typing, still looking, nothing found, a step', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    const { CommandPalette, PALETTE_SIZE } = palette
    const step: PageActionsModule.ActionStep = {
      mode: 'File in',
      subject: 'Flent',
      placeholder: 'Find a space…',
      heading: 'Spaces',
      choices: async () => [{ id: 's1', label: 'Climate', meta: '4' }],
      pick: async (c) => c,
    }
    function Page() {
      pageActions.usePageActions(
        [{ id: 'file-in-space', label: 'File in a space…', step }],
        'Flent',
      )
      return null
    }
    act(() =>
      root.render(
        <>
          <Page />
          <CommandPalette open onOpenChange={() => {}} />
        </>,
      ),
    )
    const sizes: Array<ReturnType<typeof box>> = []

    // Nothing typed, on a record: its verbs.
    expect(document.querySelector('[data-group="actions"]')).not.toBeNull()
    sizes.push(box())

    type('hal')
    sizes.push(box())

    await wait(700)
    expect(
      document.querySelector('[data-group="passages"] [data-running]'),
    ).not.toBeNull()
    sizes.push(box())

    type('zzqx')
    await wait(700)
    expect(document.querySelector('[data-nothing]')?.textContent).toBe(
      'Nothing found',
    )
    sizes.push(box())

    type('fil')
    await wait(0)
    act(() => {
      document
        .querySelector<HTMLElement>('[data-group="actions"] [cmdk-item]')
        ?.click()
    })
    await wait(0)
    expect(document.querySelector('[data-mode]')?.textContent).toBe('File in ›')
    sizes.push(box())

    const drawn = sizes[0]?.className.split(' ') ?? []
    expect(drawn).toContain('w-[min(1060px,calc(100vw-2rem))]')
    expect(drawn).toContain('h-[min(560px,calc(100dvh-4rem))]')
    for (const cls of PALETTE_SIZE.split(' ')) expect(drawn).toContain(cls)
    // Nothing else sizes it: the primitive's widths are merged away.
    expect(drawn).not.toContain('sm:max-w-[35rem]')
    expect(drawn).not.toContain('w-full')
    for (const size of sizes) expect(size).toEqual(sizes[0])
    // Nothing widens or caps the window by what it holds.
    expect(sizes[0]?.className).not.toContain('has-[[data-preview]]')
    expect(document.body.innerHTML).not.toContain('max-h-[420px]')

    act(() => root.unmount())
    host.remove()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
