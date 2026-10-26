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
import type { Condition } from '@spaces/core/views/filter'
import type { ViewRow } from '@spaces/core/writes/views/store'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import type * as ViewBarModule from './view-bar'

/**
 * The view bar: the saved views as real tabs on the bone head bar — `All`
 * with the list's total, each view with its count, `Save view…` — with
 * Filter and the table's tools on the same bar, and the chips row under it
 * while the filter holds conditions. Its `···` menu: Pin to sidebar / Unpin
 * from sidebar for any view on an object list, Rename and Delete only for a
 * view the user may edit.
 */

const liveCounts = vi.hoisted(() => ({ value: {} }))

vi.mock('#/lib/server-fns', () => ({
  countViews: vi.fn(async () => liveCounts.value),
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
  vi.stubGlobal('HTMLInputElement', win.HTMLInputElement)
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

const CITY: RegistryEntry = {
  slug: 'city',
  name: 'City',
  type: 'text',
  options: null,
  isSystem: false,
}
const DOMAIN: RegistryEntry = {
  slug: 'domain',
  name: 'Domain',
  type: 'domain',
  options: null,
  isSystem: false,
}

async function mount(opts: {
  objectId: string | null
  canEdit: boolean
  activeId?: string | null
  onApply?: (v: ViewRow | null) => void
  filter?: Array<Condition>
  onFilterChange?: (next: Array<Condition>) => void
}) {
  const { ViewBar } = bar
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ViewBar
          objectId={opts.objectId}
          registry={[CITY, DOMAIN]}
          views={[SEED]}
          counts={{ [SEED.id]: { count: 4 } }}
          total={37}
          tools={<button type="button">Columns</button>}
          activeId={opts.activeId === undefined ? SEED.id : opts.activeId}
          snapshot={{
            filter: opts.filter ?? [],
            sort: null,
            columns: {},
            extra: {},
          }}
          onApply={opts.onApply ?? (() => {})}
          selectView={() => {}}
          onFilterChange={opts.onFilterChange ?? (() => {})}
          onSaved={() => {}}
          canEdit={() => opts.canEdit}
          plural="Companies"
          pinned
        />
      </QueryClientProvider>,
    )
  })
}

const trigger = () =>
  document.querySelector('button[aria-label="More for the Seed, India view"]')

/** Turn the event loop inside `act` until `done` holds, or fail naming `what`. */
async function until(what: string, done: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (done()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  throw new Error(`never ${what}`)
}

const menu = () => document.querySelector('[role="menu"]')

/**
 * Radix opens a menu on Enter from its trigger — a toggle, so it waits for
 * the trigger to read closed first, then for the menu to mount.
 */
async function openMenu() {
  const t = trigger()
  if (!(t instanceof HTMLElement)) throw new Error('no view menu')
  await until('closed', () => t.dataset.state === 'closed' && menu() === null)
  await act(async () => {
    t.focus()
    t.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await until('opened', () => t.dataset.state === 'open' && menu() !== null)
}

const items = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) =>
    el.textContent.trim(),
  )

/** Click the button reading `label`. */
async function press(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent.trim() === label,
  )
  if (!(button instanceof HTMLElement)) throw new Error(`no ${label}`)
  await act(async () => {
    button.click()
  })
}

describe('the view menu', () => {
  it('pins a view someone else owns, then unpins it, its one verb a button', async () => {
    await mount({ objectId: SEED.objectId, canEdit: false })
    // A menu of one is that item: no `···`, the verb itself.
    expect(trigger()).toBeNull()
    await press('Pin to sidebar')
    expect(localStorage.getItem('chassis:pinned-views')).toBe(
      JSON.stringify([SEED.id]),
    )

    await press('Unpin from sidebar')
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
    expect(controls).toEqual(['Save view…', 'Filter', 'Columns'])
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

describe('a dirty view', () => {
  it('prints its 0 when its filter matched nothing, then the pine square, then Update view', async () => {
    liveCounts.value = { [SEED.id]: { count: 0 } }
    await mount({
      objectId: SEED.objectId,
      canEdit: true,
      filter: [{ slug: 'city', op: 'contains', value: 'Atlantis' }],
    })
    const seed = () =>
      Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
        t.textContent.startsWith('Seed, India'),
      )
    await until('counted', () => seed()?.textContent === 'Seed, India0')
    const tab = seed()
    expect(tab?.querySelector('[data-tab-count]')?.textContent).toBe('0')
    expect(tab?.lastElementChild?.hasAttribute('data-view-dirty')).toBe(true)
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (b) => b.textContent.trim() === 'Update view',
      ),
    ).toBe(true)
    liveCounts.value = {}
  })
})

describe('the filter chips', () => {
  const chips = () =>
    Array.from(document.querySelectorAll('[data-filter-chip]')).map((c) =>
      c.textContent.replace('×', '').trim(),
    )
  const picker = () => document.querySelector('[data-attribute-picker]')

  async function pickAttribute(name: string) {
    await until('the picker', () => picker() !== null)
    const item = Array.from(
      document.querySelectorAll('[data-attribute-picker] [cmdk-item]'),
    ).find((el) => el.textContent.trim() === name)
    if (!(item instanceof HTMLElement)) throw new Error(`no ${name} to pick`)
    await act(async () => {
      item.click()
    })
  }

  it('shows no row while the filter is empty', async () => {
    await mount({ objectId: SEED.objectId, canEdit: false, activeId: null })
    expect(document.querySelector('[data-filter-chips]')).toBeNull()
  })

  it('reads each condition, removes one by its ×, and clears them all', async () => {
    const changes: Array<Array<Condition>> = []
    const city: Condition = { slug: 'city', op: 'contains', value: 'Pune' }
    const empty: Condition = { slug: 'domain', op: 'empty' }
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      activeId: null,
      filter: [city, empty],
      onFilterChange: (next) => changes.push(next),
    })
    expect(chips()).toEqual(['City containsPune', 'Domain is empty'])
    const remove = document.querySelector(
      'button[aria-label="Remove City contains Pune"]',
    )
    if (!(remove instanceof HTMLElement)) throw new Error('no ×')
    await act(async () => {
      remove.click()
    })
    expect(changes.at(-1)).toEqual([empty])
    await press('Clear')
    expect(changes.at(-1)).toEqual([])
  })

  it('adds a condition from Add condition, through the attribute picker', async () => {
    const changes: Array<Array<Condition>> = []
    const city: Condition = { slug: 'city', op: 'contains', value: 'Pune' }
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      activeId: null,
      filter: [city],
      onFilterChange: (next) => changes.push(next),
    })
    await press('Add condition')
    await pickAttribute('Domain')
    expect(changes.at(-1)).toEqual([city, { slug: 'domain', op: 'contains' }])
  })
})

describe('the Filter popover', () => {
  it('opens straight into the attribute picker while empty, and a pick makes the condition', async () => {
    const changes: Array<Array<Condition>> = []
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      activeId: null,
      onFilterChange: (next) => changes.push(next),
    })
    await press('Filter')
    await until('the picker', () =>
      Boolean(document.querySelector('[data-attribute-picker]')),
    )
    expect(document.body.textContent).not.toContain('No conditions')
    const city = Array.from(document.querySelectorAll('[cmdk-item]')).find(
      (el) => el.textContent.trim() === 'City',
    )
    if (!(city instanceof HTMLElement)) throw new Error('no City')
    await act(async () => {
      city.click()
    })
    expect(changes.at(-1)).toEqual([{ slug: 'city', op: 'contains' }])
  })

  it('opens on the conditions, with Add condition and Clear in its foot, once there are some', async () => {
    await mount({
      objectId: SEED.objectId,
      canEdit: false,
      activeId: null,
      filter: [{ slug: 'city', op: 'contains', value: 'Pune' }],
    })
    await press('Filter1')
    await until('the conditions', () =>
      Boolean(document.querySelector('[data-filter-conditions]')),
    )
    expect(document.querySelector('[data-attribute-picker]')).toBeNull()
    const foot = Array.from(
      document.querySelectorAll('[data-filter-conditions] button'),
    ).map((b) => b.textContent.trim())
    expect(foot.slice(-2)).toEqual(['Add condition', 'Clear'])
  })
})
