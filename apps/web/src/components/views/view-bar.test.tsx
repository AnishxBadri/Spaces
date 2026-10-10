import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ViewRow } from '@spaces/core/writes/views/store'
import type * as ViewBarModule from './view-bar'

/**
 * The view bar: the saved views as real tabs on the bone head bar — `All`
 * with the list's total, each view with its count, `+ view` — with Filter and
 * the table's tools on the same bar. Its `···` menu: Pin to sidebar / Unpin
 * for any view on an object list, Rename and Delete only for a view the user
 * may edit.
 */

vi.mock('#/lib/server-fns', () => ({
  countViews: vi.fn(async () => ({})),
  deleteView: vi.fn(async () => ({ ok: true })),
  saveView: vi.fn(async () => ({ id: 'x' })),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, { error: () => undefined }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let bar: typeof ViewBarModule

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('PointerEvent', win.PointerEvent)
  vi.stubGlobal('FocusEvent', win.FocusEvent)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  // What Radix's menu and focus scope reach for.
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('MutationObserver', win.MutationObserver)
  vi.stubGlobal('ResizeObserver', win.ResizeObserver)
  vi.stubGlobal('DOMRect', win.DOMRect)
  vi.stubGlobal('NodeFilter', win.NodeFilter)
  vi.stubGlobal('HTMLButtonElement', win.HTMLButtonElement)
  vi.stubGlobal('SVGElement', win.SVGElement)
  vi.stubGlobal('ShadowRoot', win.ShadowRoot)
  vi.stubGlobal('DocumentFragment', win.DocumentFragment)
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame.bind(win))
  vi.stubGlobal('cancelAnimationFrame', win.cancelAnimationFrame.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  bar = await import('./view-bar')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  localStorage.clear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

const SEED: ViewRow = {
  id: '00000000-0000-4000-8000-000000000004',
  surface: 'object',
  objectId: '00000000-0000-4000-8000-000000000009',
  name: 'Seed, India',
  filter: [],
  sort: null,
  columns: {},
  extra: {},
  visibility: 'shared',
  createdBy: 'someone-else',
  updatedAt: '2026-10-10T00:00:00.000Z',
}

async function mount(opts: {
  objectId: string | null
  canEdit: boolean
  activeId?: string | null
  onApply?: (v: ViewRow | null) => void
}) {
  const { ViewBar } = bar
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ViewBar
          objectId={opts.objectId}
          registry={[]}
          views={[SEED]}
          counts={{ [SEED.id]: { count: 4 } }}
          total={37}
          tools={<button type="button">Columns</button>}
          activeId={opts.activeId === undefined ? SEED.id : opts.activeId}
          snapshot={{ filter: [], sort: null, columns: {}, extra: {} }}
          onApply={opts.onApply ?? (() => {})}
          selectView={() => {}}
          onFilterChange={() => {}}
          onSaved={() => {}}
          canEdit={() => opts.canEdit}
        />
      </QueryClientProvider>,
    )
  })
}

const trigger = () =>
  document.querySelector('button[aria-label="View menu for Seed, India"]')

/** Radix opens a menu on Enter from its trigger. */
async function openMenu() {
  const t = trigger()
  if (!(t instanceof HTMLElement)) throw new Error('no view menu')
  await act(async () => {
    t.focus()
    t.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const items = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) =>
    el.textContent.trim(),
  )

async function choose(label: string) {
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent.trim() === label,
  )
  if (!(item instanceof HTMLElement)) throw new Error(`no ${label}`)
  await act(async () => {
    item.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('the view menu', () => {
  it('pins a view someone else owns, then unpins it', async () => {
    await mount({ objectId: SEED.objectId, canEdit: false })
    await openMenu()
    expect(items()).toEqual(['Pin to sidebar'])
    await choose('Pin to sidebar')
    expect(localStorage.getItem('chassis:pinned-views')).toBe(
      JSON.stringify([SEED.id]),
    )

    await openMenu()
    expect(items()).toEqual(['Unpin'])
    await choose('Unpin')
    expect(localStorage.getItem('chassis:pinned-views')).toBe('[]')
  })

  it('carries Rename and Delete for a view the user may edit', async () => {
    await mount({ objectId: SEED.objectId, canEdit: true })
    await openMenu()
    expect(items()).toEqual(['Pin to sidebar', 'Rename…', 'Delete view'])
  })

  it('offers no pin on a list with no object, and no menu with nothing in it', async () => {
    await mount({ objectId: null, canEdit: true })
    await openMenu()
    expect(items()).toEqual(['Rename…', 'Delete view'])
    act(() => root.unmount())
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await mount({ objectId: null, canEdit: false })
    expect(trigger()).toBeNull()
  })
})

describe('the tab bar', () => {
  const tabs = () =>
    Array.from(document.querySelectorAll('[role="tab"]')).map((t) => ({
      text: t.textContent.trim(),
      selected: t.getAttribute('aria-selected'),
    }))

  it('draws All with the total and each view with its count, as real tabs', async () => {
    await mount({ objectId: SEED.objectId, canEdit: false, activeId: null })
    expect(tabs()).toEqual([
      { text: 'All37', selected: 'true' },
      { text: 'Seed, India4', selected: 'false' },
    ])
    const list = document.querySelector('[role="tablist"]')
    expect(list?.closest('[data-tab-bar]')?.className).toContain('bg-bone')
  })

  it('carries + view, Filter and the tools on the same bar, outside the tablist', async () => {
    await mount({ objectId: SEED.objectId, canEdit: false, activeId: null })
    const barEl = document.querySelector('[data-tab-bar]')
    if (!(barEl instanceof HTMLElement)) throw new Error('no bar')
    const controls = Array.from(barEl.querySelectorAll('button'))
      .filter((b) => b.getAttribute('role') !== 'tab')
      .map((b) => b.textContent.trim())
    expect(controls).toEqual(['+ view', 'Filter', 'Columns'])
    expect(
      barEl.querySelector('[role="tablist"]')?.querySelectorAll('button'),
    ).toHaveLength(2)
    // One bar: nothing of the view bar renders outside it.
    expect(document.querySelectorAll('[data-tab-bar]')).toHaveLength(1)
  })

  it('applies a view from its tab and All from the first', async () => {
    const applied: Array<string | null> = []
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      activeId: null,
      onApply: (v) => applied.push(v?.id ?? null),
    })
    const [all, seed] = Array.from(document.querySelectorAll('[role="tab"]'))
    if (!(all instanceof HTMLElement && seed instanceof HTMLElement))
      throw new Error('tabs missing')
    await act(async () => {
      seed.click()
    })
    expect(applied).toEqual([SEED.id])
    act(() => root.unmount())
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      onApply: (v) => applied.push(v?.id ?? null),
    })
    const first = document.querySelector('[role="tab"]')
    if (!(first instanceof HTMLElement)) throw new Error('no All')
    await act(async () => {
      first.click()
    })
    expect(applied).toEqual([SEED.id, null])
  })
})
