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

import type * as PageModule from './space-page'
import type * as TabsModule from './space-tabs'
import type { Space } from './space-tabs'
import type * as PrefModule from '#/lib/record-tab-pref'
import type * as RouterModule from '@tanstack/react-router'
import type { SpaceTab } from '#/lib/spaces/page'

/**
 * The space page as the owner approved it (D73, D74), mounted under a memory
 * router on a happy-dom `Window`: the head, the three readouts, the details
 * column and the five tabs. Server fns are stubs; the toast is captured so
 * the untag's Undo can be pressed.
 */

const fns = vi.hoisted(() => {
  const made = new Map<string, ReturnType<typeof vi.fn>>()
  const get = (name: string) => {
    let fn = made.get(name)
    if (!fn) {
      fn = vi.fn(async () => [])
      made.set(name, fn)
    }
    return fn
  }
  return { get, made }
})

vi.mock('#/lib/server-fns', () => {
  const names = [
    'archiveSpace',
    'clipUrl',
    'createNote',
    'createSpace',
    'createTerm',
    'deleteDocument',
    'deleteTerm',
    'finalizeDocumentUpload',
    'getDocumentDownloadUrl',
    'getDocumentText',
    'listEntityTasks',
    'listSpaces',
    'moveSpace',
    'prepareDocumentUpload',
    'renameSpace',
    'restoreSpace',
    'saveSpaceAsTemplate',
    'searchEntities',
    'setEntitySensitive',
    'setSpaceCriteria',
    'setTaskDone',
    'tagIntoSpace',
    'untagFromSpace',
    'updateTerm',
  ]
  return Object.fromEntries(names.map((n) => [n, fns.get(n)]))
})

const toasts = vi.hoisted(() => {
  type Action = { label: string; onClick: () => void }
  const shown: Array<{ message: string; action?: Action }> = []
  const toast = Object.assign(
    (message: string, opts?: { action?: Action }) => {
      shown.push(opts?.action ? { message, action: opts.action } : { message })
    },
    { error: () => {}, success: () => {} },
  )
  return { shown, toast }
})

vi.mock('sonner', () => ({ toast: toasts.toast }))

// The composer reads the session from the app route; the trigger is the test.
vi.mock('./task-composer', () => ({
  TaskComposer: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let page: typeof PageModule
let tabs: typeof TabsModule
let pref: typeof PrefModule
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
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('IntersectionObserver', StubObserver)
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  page = await import('./space-page')
  tabs = await import('./space-tabs')
  pref = await import('#/lib/record-tab-pref')
  router = await import('@tanstack/react-router')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  localStorage.clear()
  toasts.shown.length = 0
  for (const fn of fns.made.values()) fn.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const company = (
  id: string,
  name: string,
  stage: string | null,
  deals: number,
  filedAt: string,
): Space['companies'][number] => ({
  id,
  name,
  stage,
  geo: 'London',
  taggedVia: 'manual',
  filedAt,
  deals,
})

const spc: Space = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Property ops',
  slug: 'property-ops',
  path: 'proptech.property_ops',
  parentId: '00000000-0000-4000-8000-000000000002',
  isSeeded: false,
  criteria: null,
  createdAt: '2026-09-16T10:00:00.000Z',
  lastFiled: { on: '2026-10-06T09:00:00.000Z', days: 2 },
  stageOptions: [
    { id: 'pre_seed', label: 'Pre-seed' },
    { id: 'seed', label: 'Seed' },
    { id: 'series_a', label: 'Series A' },
    { id: 'bootstrapped', label: 'Bootstrapped' },
  ],
  archive: null,
  archivedUnder: null,
  ancestors: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Proptech' }],
  parent: {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Proptech',
    path: 'proptech',
    archived: false,
  },
  children: [
    {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Leasing',
      companies: 2,
      memos: 0,
    },
  ],
  companies: [
    company('c1', 'Tenantry', 'seed', 0, '2026-10-06T09:00:00.000Z'),
    company('c2', 'Arbor', 'series_a', 2, '2026-10-01T09:00:00.000Z'),
    company('c3', 'Corbel', 'bootstrapped', 0, '2026-09-20T09:00:00.000Z'),
  ],
  records: [],
  filed: [
    {
      id: 'n1',
      title: 'Property ops thesis',
      kind: 'memo',
      snippet: 'Operators win.',
      updatedAt: '2026-10-05T09:00:00.000Z',
    },
  ],
  sources: [],
  inheritedSources: [],
  contacts: [],
  inheritedContacts: [
    {
      id: 'p1',
      name: 'Ada Lane',
      headline: 'CEO',
      companies: 'Tenantry',
      companyId: 'c1',
      companyName: 'Tenantry',
    },
  ],
  notes: [
    { id: 'n2', title: 'Market map', updatedAt: '2026-10-04T09:00:00.000Z' },
  ],
}

const terms = [
  {
    id: 't1',
    name: 'NOI',
    aliases: [],
    definitionMd: 'Net operating income.',
    spaceId: spc.id,
    spaceName: spc.name,
  },
  {
    id: 't2',
    name: 'Cap rate',
    aliases: [],
    definitionMd: 'Income over value.',
    spaceId: '00000000-0000-4000-8000-000000000002',
    spaceName: 'Proptech',
  },
]

async function mount(tab: SpaceTab, onTabChange = (_: SpaceTab) => {}) {
  const { SpacePageView } = page
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const rootRoute = createRootRoute({
    component: () => (
      <SpacePageView
        spc={spc}
        terms={terms}
        sensitivity={{ sensitivity: 'normal', own: false }}
        tab={tab}
        onTabChange={onTabChange}
      />
    ),
  })
  const r = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const header = () => {
  const el = document.querySelector('header')
  if (!el) throw new Error('no header')
  return el
}

const text = (el: Element | null) => (el?.textContent ?? '').trim()

const buttonNamed = (name: RegExp) => {
  const hit = Array.from(document.querySelectorAll('button')).find((b) =>
    name.test(b.getAttribute('aria-label') ?? text(b)),
  )
  if (!hit) throw new Error(`no button ${name}`)
  return hit
}

describe('the space head', () => {
  it('draws the stamp, the crumb of ancestors with the created date, the double rule', async () => {
    await mount('notes')
    const head = header()
    expect(text(head.querySelector('[data-stamp]'))).toBe('Space · depth 1')
    const crumb = text(head.querySelector('nav[aria-label="Breadcrumb"]'))
    expect(crumb).toContain('Proptech')
    expect(crumb).toContain('created 2026-09-16')
    expect(head.className).toContain('double-rule')
    expect(text(head.querySelector('h1'))).toBe('Property ops')
  })

  it('has Note here as its only button beside the toggle and the menu', async () => {
    await mount('notes')
    const buttons = Array.from(header().querySelectorAll('button')).filter(
      (b) =>
        b.getAttribute('role') !== 'switch' &&
        !(b.getAttribute('aria-label') ?? '').startsWith('More for'),
    )
    expect(buttons.map((b) => text(b))).toEqual(['Note hereN'])
  })

  it('reads three readouts, none of them a tab count', async () => {
    await mount('notes')
    const strip = header().querySelector('.border-t.border-hairline')
    const cells = Array.from(strip?.children ?? [])
    expect(cells).toHaveLength(3)
    const labels = cells.map((c) => text(c.lastElementChild))
    expect(labels).toEqual(['In pipeline', 'Last filed', 'Funding stage'])
    expect(text(cells[0]?.firstElementChild ?? null)).toBe('1 of 3')
    expect(text(cells[1]?.firstElementChild ?? null)).toBe('10-06 · 2d')
    for (const tab of ['Companies', 'Notes', 'Files', 'People', 'Records']) {
      expect(labels).not.toContain(tab)
    }
  })

  it('draws the stage bar summing to the companies, bootstrapped last', async () => {
    await mount('notes')
    const stages = Array.from(
      header().querySelectorAll('[data-stage-bar] li[data-stage]'),
    )
    expect(stages.map((s) => s.getAttribute('data-stage'))).toEqual([
      'seed',
      'series_a',
      'bootstrapped',
    ])
    const sum = stages
      .map((s) => Number(text(s.querySelector('span'))))
      .reduce((a, b) => a + b, 0)
    expect(sum).toBe(spc.companies.length)
  })
})

describe('the details column', () => {
  it('holds Map, Glossary and Tasks in that order', async () => {
    await mount('notes')
    const column = document.querySelector('aside[aria-label="Details"]')
    const heads = Array.from(column?.querySelectorAll('h2') ?? []).map((h) =>
      text(h),
    )
    expect(heads).toEqual(['Map', 'Glossary', 'Tasks'])
    expect(column?.className).toContain('bg-bone')
    expect(column?.className).toContain('xl:w-80')
  })

  it('marks an inherited term with the space it came from', async () => {
    await mount('notes')
    const inherited = document.querySelector('[data-term="Cap rate"]')
    expect(text(inherited)).toContain('from Proptech')
    const own = document.querySelector('[data-term="NOI"]')
    expect(text(own)).not.toContain('from')
  })

  it('ends Tasks on an add row that T opens', async () => {
    await mount('notes')
    expect(text(buttonNamed(/Add a task/))).toContain('T')
  })
})

describe('the tabs', () => {
  it('shows five tabs with counts on the 44px bone head, empty ones grey at 0', async () => {
    await mount('notes')
    const list = document.querySelector('[role="tablist"]')
    expect(list?.className).toContain('h-11')
    expect(list?.className).toContain('bg-bone')
    const tabsShown = Array.from(document.querySelectorAll('[role="tab"]')).map(
      (t) => text(t),
    )
    expect(tabsShown).toEqual([
      'Companies3',
      'Notes2',
      'Files0',
      'People1',
      'Records0',
    ])
    const files = Array.from(document.querySelectorAll('[role="tab"]')).at(2)
    expect(files?.querySelector('[data-tab-count]')?.className).toContain(
      'text-graphite',
    )
    expect(text(document.querySelector('[aria-selected="true"]'))).toMatch(
      /^Notes/,
    )
  })

  it('hands a tab change to the route', async () => {
    const changed: Array<SpaceTab> = []
    await mount('notes', (t) => changed.push(t))
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
        .at(0)
        ?.click()
    })
    expect(changed).toEqual(['companies'])
  })

  it('remembers the last tab per browser', async () => {
    const { rememberRecordTab, useLastRecordTab } = pref
    let seen: string | null = null
    function Probe() {
      seen = useLastRecordTab('space')
      return null
    }
    act(() => root.render(<Probe />))
    expect(seen).toBeNull()
    act(() => rememberRecordTab('space', 'files'))
    expect(seen).toBe('files')
    expect(localStorage.getItem('record-tab:space')).toBe('files')
  })
})

describe('the Notes tab', () => {
  it('filters Filed and Mentions, and says Referenced nowhere', async () => {
    await mount('notes')
    expect(text(buttonNamed(/^Filed/))).toBe('Filed 1')
    expect(document.body.textContent).toContain('Property ops thesis')
    await act(async () => buttonNamed(/^Mentions/).click())
    expect(document.body.textContent).toContain('Market map')
    expect(document.body.textContent).not.toContain('Property ops thesis')
    expect(document.body.textContent).not.toMatch(/Referenced/i)
  })
})

describe('the Companies tab', () => {
  const rowNames = () =>
    Array.from(document.querySelectorAll('a[href^="/companies/"]')).map((a) =>
      text(a.querySelector('.font-medium')),
    )

  it('sorts by funding stage and filters to the pipeline or the watched', async () => {
    await mount('companies')
    expect(text(buttonNamed(/Tag a company into/))).toContain(
      'Tag a company into Property ops…',
    )
    expect(rowNames()).toEqual(['Tenantry', 'Arbor', 'Corbel'])
    await act(async () => buttonNamed(/^Watching/).click())
    expect(rowNames()).toEqual(['Tenantry', 'Corbel'])
    await act(async () => buttonNamed(/^In pipeline/).click())
    expect(rowNames()).toEqual(['Arbor'])
  })

  it('shows the select box and × on hover only', async () => {
    await mount('companies')
    const box = buttonNamed(/^Select Tenantry/)
    expect(box.className).toContain('opacity-0')
    expect(box.className).toContain('group-hover:opacity-100')
    const untag = buttonNamed(/^Untag Tenantry/)
    expect(untag.className).toContain('opacity-0')
    expect(untag.className).toContain('group-hover:opacity-100')
    await act(async () => box.click())
    expect(buttonNamed(/^Select Tenantry/).className).toContain('opacity-100')
  })

  it('untags with one write and offers Undo, which re-files', async () => {
    await mount('companies')
    await act(async () => buttonNamed(/^Untag Tenantry/).click())
    // The row fades for its exit before the write goes.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const untag = fns.get('untagFromSpace')
    expect(untag).toHaveBeenCalledTimes(1)
    expect(untag).toHaveBeenCalledWith({
      data: { entityId: 'c1', spaceId: spc.id },
    })
    const shown = toasts.shown.at(-1)
    expect(shown?.message).toBe('Tenantry untagged from Property ops')
    expect(shown?.action?.label).toBe('Undo')
    await act(async () => shown?.action?.onClick())
    expect(fns.get('tagIntoSpace')).toHaveBeenCalledWith({
      data: { entityId: 'c1', spaceId: spc.id },
    })
  })
})

describe('the readouts helper', () => {
  it('reads a dash when no company is staged', () => {
    const empty: Space = { ...spc, companies: [], lastFiled: null }
    const cells = tabs.spaceReadouts(empty)
    expect(cells.map((c) => c.value)).toEqual(['0 of 0', '—', '—'])
  })
})
