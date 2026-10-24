import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
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

import type * as IndexModule from './spaces-index'
import type { SpacesIndex } from './spaces-index'
import type * as RouterModule from '@tanstack/react-router'

/**
 * The spaces index, mounted under a memory router on a
 * happy-dom `Window`: the label row, the tree, the last filed lane, the
 * archived fold and the New space window. Server fns are stubs.
 */

const fns = vi.hoisted(() => ({
  restoreSpace: vi.fn(async () => ({ spaces: 1 })),
  createSpace: vi.fn(async () => ({ id: 'new' })),
  applySpaceTemplate: vi.fn(async () => ({ id: 'new' })),
  listTemplates: vi.fn(async () => []),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('sonner', () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let view: typeof IndexModule
let router: typeof RouterModule

class StubObserver {
  observe() {}
  disconnect() {}
}

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('IntersectionObserver', StubObserver)
  vi.stubGlobal('ResizeObserver', StubObserver)
  vi.stubGlobal('scrollTo', () => {})
  // The window is a Radix dialog: its focus scope dispatches the DOM's events.
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  view = await import('./spaces-index')
  router = await import('@tanstack/react-router')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

/** Let a closed dialog's focus scope run its deferred event while stubbed. */
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

afterEach(async () => {
  act(() => root.unmount())
  await tick()
  document.body.replaceChildren()
})

type Row = SpacesIndex['spaces'][number]

const row = (
  id: string,
  name: string,
  parentId: string | null,
  depth: number,
  lastFiled: string | null,
  companies = 0,
): Row => ({
  id,
  name,
  slug: id,
  path: id,
  parentId,
  isSeeded: false,
  depth,
  companies,
  memos: 0,
  terms: 0,
  lastFiled,
})

const tree: Array<Row> = [
  row('proptech', 'Proptech', null, 0, '2026-09-30', 5),
  row('ops', 'Property ops', 'proptech', 1, '2026-10-06', 14),
  row('leasing', 'Leasing', 'ops', 2, null, 4),
  row('construction', 'Construction tech', 'proptech', 1, '2026-08-20'),
  row('fintech', 'Fintech', null, 0, null),
]

const index = (archived: SpacesIndex['archived'] = []): SpacesIndex => ({
  today: '2026-10-10',
  spaces: tree,
  archived,
})

async function mount(data: SpacesIndex) {
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const rootRoute = createRootRoute({
    loader: () => null,
    component: () => <view.SpacesIndexPage index={data} />,
  })
  const r = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
}

const mapRows = () => [...document.querySelectorAll('section ol > li')]
const rowNamed = (name: string) => {
  const li = mapRows().find((el) => el.textContent.includes(name))
  if (!li) throw new Error(`no row ${name}`)
  return li
}
const buttonNamed = (name: string) => {
  const b = [...document.querySelectorAll('button')].find(
    (el) => el.textContent.trim() === name,
  )
  if (!b) throw new Error(`no button ${name}`)
  return b
}

describe('the market map', () => {
  it('heads the list with a caps label on a hairline and lowercase lanes', async () => {
    await mount(index())
    const head = document.querySelector('section > div')
    expect(head?.className).toContain('border-hairline')
    expect(head?.className).not.toContain('bg-bone')
    expect(head?.querySelector('h2')?.className).toContain('label-caps')
    expect(head?.textContent).toContain('companiesmemostermslast filed')
    expect(document.body.textContent).toContain('5 spaces · 3 nested')
  })

  it('draws 36px rows, ruled only under a top-level group', async () => {
    await mount(index())
    const spaceRows = mapRows().slice(0, tree.length)
    for (const li of spaceRows) expect(li.className).toContain('h-row')
    expect(
      spaceRows
        .filter((li) => li.className.includes('border-b'))
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Construction tech'),
      expect.stringContaining('Fintech'),
    ])
  })

  it('hangs children off ├ and └ in rule grey', async () => {
    await mount(index())
    const markOf = (name: string) =>
      rowNamed(name).querySelector('span[aria-hidden]')
    expect(markOf('Property ops')?.textContent).toBe('├')
    expect(markOf('Leasing')?.textContent).toBe('└')
    expect(markOf('Construction tech')?.textContent).toBe('└')
    expect(markOf('Property ops')?.className).toContain('text-rule')
    expect(rowNamed('Proptech').querySelector('svg')).not.toBeNull()
  })

  it('prints last filed as day and age, or a dash', async () => {
    await mount(index())
    expect(rowNamed('Property ops').textContent).toContain('10-06 · 4d')
    expect(rowNamed('Fintech').textContent.endsWith('—')).toBe(true)
  })
})

describe('the archived fold', () => {
  it('is absent when nothing is archived', async () => {
    await mount(index())
    expect(document.body.textContent).not.toContain('archived')
  })

  it('lists archived spaces on show, and Restore restores', async () => {
    await mount(
      index([
        {
          id: 'launch',
          name: 'Launch',
          within: 'Space infra',
          spaces: 1,
          archivedOn: '2026-10-08',
        },
      ]),
    )
    expect(document.body.textContent).toContain('1 archived')
    expect(document.body.textContent).not.toContain('Launch')
    await act(async () => buttonNamed('show').click())
    expect(document.body.textContent).toContain('Launch')
    await act(async () => buttonNamed('Restore').click())
    expect(fns.restoreSpace).toHaveBeenCalledWith({ data: { id: 'launch' } })
  })
})

describe('the New space window', () => {
  const dialog = () => document.querySelector('[role="dialog"]')

  it('has a title only, the three fields, and Cancel closes it', async () => {
    await mount(index())
    const open = [...document.querySelectorAll('button')].find(
      (b) => b.closest('header') !== null,
    )
    if (!open) throw new Error('no New space in the head')
    await act(async () => open.click())
    const d = dialog()
    expect(d?.querySelector('h2')?.textContent).toBe('New space')
    expect(d?.textContent).not.toMatch(/\besc\b/)
    expect(d?.querySelector('[data-slot="dialog-description"]')).toBeNull()
    expect(d?.textContent).toContain('Name')
    expect(d?.textContent).toContain('Inside')
    expect(d?.textContent).toContain('Top level')
    expect(d?.textContent).toContain('Stamp a saved breakdown')
    expect(d?.textContent).toContain('Create space')
    await act(async () => buttonNamed('Cancel').click())
    await tick()
    expect(dialog()).toBeNull()
  })
})
