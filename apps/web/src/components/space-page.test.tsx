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
import type * as FilingModule from './filing-row'
import type * as RailRowModule from './record/space-rail-row'
import type { Space } from './space-tabs'
import type * as PrefModule from '#/lib/record-tab-pref'
import type * as RouterModule from '@tanstack/react-router'
import type { SpaceTab } from '#/lib/spaces/page'
import type { SpaceWatching } from '#/lib/server-fns'

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
    'addSpaceWatch',
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
    'moveIntoSubspace',
    'moveSpace',
    'prepareDocumentUpload',
    'renameSpace',
    'restoreSpace',
    'runWatchNow',
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
let filing: typeof FilingModule
let railRow: typeof RailRowModule

/** The space's status stream, fed by hand: what `/api/job-status` would send. */
class FakeEventSource {
  static readonly CLOSED = 2
  static opened: Array<FakeEventSource> = []
  readonly url: string
  readyState = 1
  private readonly listeners = new Map<
    string,
    Array<(message: { data: string }) => void>
  >()
  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }
  addEventListener(type: string, fn: (message: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) })
  }
}

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
  vi.stubGlobal('EventSource', FakeEventSource)
  // The Add watch window is a Radix dialog: its focus scope and portal
  // reach for the rest of the DOM's classes.
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('CustomEvent', win.CustomEvent)
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  page = await import('./space-page')
  tabs = await import('./space-tabs')
  pref = await import('#/lib/record-tab-pref')
  router = await import('@tanstack/react-router')
  filing = await import('./filing-row')
  railRow = await import('./record/space-rail-row')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  localStorage.clear()
  toasts.shown.length = 0
  FakeEventSource.opened = []
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

/** What the server holds now; a stubbed write may change it. */
const served: { current: SpaceWatching } = {
  current: { watches: [], engines: [], installed: [], moving: [] },
}

/** No watch, no engine: the lanes' resting state. */
const noWatches: SpaceWatching = {
  watches: [],
  engines: [],
  installed: [],
  moving: [],
}

/**
 * The page under a root route whose loads re-read `served`, so a
 * `router.invalidate()` after a save draws what the server now holds.
 */
async function mount(
  tab: SpaceTab,
  onTabChange = (_: SpaceTab) => {},
  watching: SpaceWatching = noWatches,
  opts: { into?: string; space?: Space } = {},
) {
  const shown = opts.space ?? spc
  const { SpacePageView } = page
  const {
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRouter,
    useRouterState,
  } = router
  served.current = watching
  function Root() {
    // Each load (an invalidate included) re-renders and re-reads `served`.
    useRouterState({ select: (s) => s.matches.at(0)?.updatedAt })
    return (
      <SpacePageView
        spc={shown}
        terms={terms}
        sensitivity={{ sensitivity: 'normal', own: false }}
        watching={served.current}
        tab={tab}
        into={opts.into ?? null}
        onTabChange={onTabChange}
      />
    )
  }
  const rootRoute = createRootRoute({ loader: () => null, component: Root })
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
  return r
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

  const headButtons = () =>
    Array.from(header().querySelectorAll('button'))
      .filter(
        (b) => !(b.getAttribute('aria-label') ?? '').startsWith('More for'),
      )
      .map((b) => text(b))

  it('draws Not sensitive as a toggle button beside Note here, and no Add watch with no engine installed', async () => {
    await mount('notes')
    expect(headButtons()).toEqual(['Not sensitive', 'Note hereN'])
    const toggle = buttonNamed(/^Not sensitive$/)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(header().querySelector('[role="switch"]')).toBeNull()
  })

  it('adds Add watch once a watch engine is installed', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      engines: [exa],
      installed: ['Exa'],
    })
    expect(headButtons()).toEqual(['Not sensitive', 'Note hereN', 'Add watch'])
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
  it("holds Criteria, Watching and What's moving above Map, Glossary and Tasks", async () => {
    await mount('notes')
    const column = document.querySelector('aside[aria-label="Details"]')
    const heads = Array.from(column?.querySelectorAll('h2') ?? []).map((h) =>
      text(h),
    )
    expect(heads).toEqual([
      'Watching',
      "What's moving",
      'Map',
      'Glossary',
      'Tasks',
    ])
    const sections = Array.from(
      column?.querySelectorAll('section[aria-label]') ?? [],
    ).map((s) => s.getAttribute('aria-label'))
    expect(sections.slice(0, 3)).toEqual([
      'Criteria',
      'Watching',
      "What's moving",
    ])
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
  it('filters All, Filed here and Mentions, and says Referenced nowhere', async () => {
    await mount('notes')
    const group = document.querySelector('[aria-label="Show notes"]')
    expect(
      Array.from(group?.querySelectorAll('button') ?? []).map((b) => text(b)),
    ).toEqual(['All 2', 'Filed here 1', 'Mentions 1'])
    // All: the filed notes, then the mentions.
    expect(buttonNamed(/^All/).getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('Property ops thesis')
    expect(document.body.textContent).toContain('Market map')
    await act(async () => buttonNamed(/^Filed here/).click())
    expect(document.body.textContent).toContain('Property ops thesis')
    expect(document.body.textContent).not.toContain('Market map')
    await act(async () => buttonNamed(/^Mentions/).click())
    expect(document.body.textContent).toContain('Market map')
    expect(document.body.textContent).not.toContain('Property ops thesis')
    expect(document.body.textContent).not.toMatch(/Referenced/i)
  })

  it('draws its rows in full ink on a live space', async () => {
    await mount('notes')
    expect(document.querySelector('h3')?.className).not.toContain(
      'text-graphite',
    )
  })
})

describe('the Companies tab', () => {
  const rowNames = () =>
    Array.from(document.querySelectorAll('a[href^="/companies/"]')).map((a) =>
      text(a.querySelector('.font-medium')),
    )

  it('heads its lanes company · funding stage · pipeline · location, sorted by Funding stage', async () => {
    await mount('companies')
    const heads = document.querySelector('[data-lane-heads]')
    expect(
      Array.from(heads?.querySelectorAll('span') ?? [])
        .map((s) => text(s))
        .filter(Boolean),
    ).toEqual(['company', 'funding stage', 'pipeline', 'location'])
    const sort = buttonNamed(/^Sort companies$/)
    expect(text(sort)).toBe('Funding stage')
    expect(text(sort.parentElement)).toBe('SortFunding stage')
  })

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

describe('split: New subspace, then Move here (D73)', () => {
  const LEASING = '00000000-0000-4000-8000-000000000003'
  const bar = () => document.querySelector('[data-selection-bar]')
  const boxes = () =>
    Array.from(document.querySelectorAll('button')).filter((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Select '),
    )

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('lands a new subspace from ··· on this Companies tab, selecting into it', async () => {
    const created = fns.get('createSpace')
    created.mockResolvedValueOnce({ id: LEASING })
    const r = await mount('notes')
    const trigger = buttonNamed(/^More for Property ops/)
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const item = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => text(el) === 'New subspace')
    if (!(item instanceof HTMLElement)) throw new Error('no New subspace')
    await act(async () => item.click())
    await settle()
    const field = document.querySelector('input[aria-label="Subspace name"]')
    if (!(field instanceof HTMLInputElement)) throw new Error('no field')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setter?.call(field, 'Leasing')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await settle()
    expect(created).toHaveBeenCalledTimes(1)
    expect(created).toHaveBeenCalledWith({
      data: { name: 'Leasing', parentId: spc.id },
    })
    expect(r.state.location.pathname).toBe(`/spaces/${spc.id}`)
    expect(r.state.location.search).toEqual({
      tab: 'companies',
      into: LEASING,
    })
  })

  it('opens selecting: every direct filing shows its box, and only those', async () => {
    await mount('companies', undefined, undefined, { into: LEASING })
    // The rows are the space's own filings; none is inherited from a child.
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Select Tenantry',
      'Select Arbor',
      'Select Corbel',
    ])
    for (const b of boxes()) {
      expect(b.className).toContain('opacity-100')
      expect(b.className).not.toMatch(/(^| )opacity-0/)
    }
    expect(bar()).toBeNull()
  })

  it('draws the one 44px bone bar with the count and Move here, gone at zero', async () => {
    await mount('companies', undefined, undefined, { into: LEASING })
    await act(async () => buttonNamed(/^Select Tenantry/).click())
    await act(async () => buttonNamed(/^Select Corbel/).click())
    const shown = bar()
    expect(shown).not.toBeNull()
    expect(document.querySelectorAll('[data-selection-bar]')).toHaveLength(1)
    expect(shown?.className).toContain('h-11')
    expect(shown?.className).toContain('bg-bone')
    expect(text(shown)).toContain('2 selected')
    // The filter row gives way to the bar while anything is chosen.
    expect(document.querySelector('[aria-label="Show companies"]')).toBeNull()
    const verbs = Array.from(shown?.querySelectorAll('button') ?? []).filter(
      (b) => b.getAttribute('data-variant') === 'default',
    )
    expect(verbs.map((b) => text(b))).toEqual(['Move here'])
    expect(verbs[0]?.hasAttribute('disabled')).toBe(false)
    await act(async () => buttonNamed(/^Select Tenantry/).click())
    expect(text(bar())).toContain('1 selected')
    await act(async () => buttonNamed(/^Select Corbel/).click())
    expect(bar()).toBeNull()
    expect(
      document.querySelector('[aria-label="Show companies"]'),
    ).not.toBeNull()
  })

  it('moves the chosen in one call naming this space and the subspace', async () => {
    const move = fns.get('moveIntoSubspace')
    move.mockResolvedValueOnce({ moved: 2 })
    await mount('companies', undefined, undefined, { into: LEASING })
    await act(async () => buttonNamed(/^Select Tenantry/).click())
    await act(async () => buttonNamed(/^Select Corbel/).click())
    await act(async () => buttonNamed(/^Move here$/).click())
    await settle()
    expect(move).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledWith({
      data: {
        fromSpaceId: spc.id,
        toSpaceId: LEASING,
        entityIds: ['c1', 'c3'],
      },
    })
    expect(toasts.shown.at(-1)?.message).toBe('2 companies moved to Leasing')
    expect(bar()).toBeNull()
  })

  it('waits for a subspace to be picked when the link names none', async () => {
    await mount('companies')
    await act(async () => buttonNamed(/^Select Arbor/).click())
    expect(buttonNamed(/^Move here$/).hasAttribute('disabled')).toBe(true)
  })

  it('offers no select box in a space with no subspace to move into', async () => {
    await mount('companies', undefined, undefined, {
      space: { ...spc, children: [] },
    })
    expect(boxes()).toEqual([])
  })
})

describe('the readouts helper', () => {
  it('reads a dash when no company is staged', () => {
    const empty: Space = { ...spc, companies: [], lastFiled: null }
    const cells = tabs.spaceReadouts(empty)
    expect(cells.map((c) => c.value)).toEqual(['0 of 0', '—', '—'])
  })
})

const exa: SpaceWatching['engines'][number] = {
  integrationId: '00000000-0000-4000-8000-0000000000e1',
  name: 'Exa',
  form: {
    ok: true,
    fields: [
      {
        kind: 'string',
        key: 'criteria',
        label: 'Criteria',
        hint: null,
        required: false,
        default: null,
        minLength: null,
        maxLength: null,
        pattern: null,
        format: null,
      },
      {
        kind: 'number',
        key: 'cap',
        label: 'Cap',
        hint: null,
        required: false,
        default: 10,
        integer: true,
        minimum: 1,
        maximum: 100,
        exclusiveMinimum: null,
        exclusiveMaximum: null,
      },
    ],
  },
}

const watch = (
  id: string,
  label: string,
  over: Partial<SpaceWatching['watches'][number]> = {},
): SpaceWatching['watches'][number] => ({
  id,
  integrationId: exa.integrationId,
  engine: 'Exa',
  label,
  cadenceMinutes: null,
  lastRunAt: null,
  run: null,
  stopped: null,
  ...over,
})

const lane = (name: string) => {
  const el = document.querySelector(`section[aria-label="${name}"]`)
  if (!el) throw new Error(`no ${name} lane`)
  return el
}

const row = (watchId: string) => {
  const el = document.querySelector(`[data-watch="${watchId}"]`)
  if (!el) throw new Error(`no row ${watchId}`)
  return el
}

const runEvent = (
  watchId: string,
  jobRunId: string,
  status: 'running' | 'succeeded',
  summary: string | null,
) => ({
  jobRunId,
  queue: 'plugin.exa.watch',
  integrationId: exa.integrationId,
  entityId: spc.id,
  watchId,
  status,
  startedAt: '2026-10-10T10:00:00.000Z',
  summary,
  error: null,
})

describe('the Watching lane', () => {
  it('names the installed engines that can watch, and says nothing else, when there is no watch', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      installed: ['Exa', 'Watcher'],
    })
    const watching = lane('Watching')
    expect(
      Array.from(watching.querySelectorAll('li')).map((li) => text(li)),
    ).toEqual(['EExa', 'WWatcher'])
    expect(watching.querySelectorAll('p, button')).toHaveLength(0)
  })

  it('draws 32px rows with Run now on manual and scheduled watches, and none on a degraded engine, which says why', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      engines: [exa],
      installed: ['Exa'],
      watches: [
        watch('w1', 'Orbital fabs'),
        watch('w2', 'Space tugs', {
          cadenceMinutes: 1440,
          lastRunAt: '2026-10-09T08:00:00.000Z',
        }),
        watch('w3', 'Launch brokers', { stopped: 'Exa key removed' }),
      ],
    })
    expect(row('w1').className).toContain('h-8')
    expect(text(row('w1'))).toContain('manual · —')
    expect(text(row('w2'))).toContain('daily · 10-09')
    expect(row('w1').querySelector('button[aria-label^="Run now"]')).not.toBe(
      null,
    )
    expect(row('w2').querySelector('button[aria-label^="Run now"]')).not.toBe(
      null,
    )
    expect(row('w3').querySelector('button')).toBe(null)
    expect(text(row('w3').querySelector('[data-stopped]'))).toBe(
      'Exa key removed',
    )
    expect(row('w3').querySelector('.opacity-40')).not.toBe(null)
    const head = lane('Watching').querySelector('h2')?.parentElement
    expect(head?.parentElement?.className).toContain('h-11')
    expect(head?.parentElement?.className).toContain('bg-bone')
  })

  it('settles from job_run on open and streams a run: running, then its tally', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      engines: [exa],
      watches: [
        watch('w1', 'Orbital fabs'),
        watch('w2', 'Space tugs', {
          run: {
            jobRunId: 'r0',
            queue: 'plugin.exa.watch',
            status: 'succeeded',
            startedAt: '2026-10-09T08:00:00.000Z',
            summary: '3 found · 2 cards',
            error: null,
          },
        }),
      ],
    })
    // The loader's latest run, before the stream says anything.
    expect(text(row('w2').querySelector('[data-cell]'))).toBe(
      '3 found · 2 cards',
    )
    expect(row('w1').querySelector('[data-cell]')).toBe(null)
    const stream = FakeEventSource.opened.at(0)
    expect(stream?.url).toBe(`/api/job-status/${spc.id}`)
    await act(async () => {
      stream?.emit('init', { rows: [] })
      stream?.emit('status', runEvent('w1', 'r1', 'running', null))
    })
    expect(text(row('w1').querySelector('[data-cell]'))).toBe('running')
    expect(text(row('w2').querySelector('[data-cell]'))).toBe(
      '3 found · 2 cards',
    )
    await act(async () => {
      stream?.emit(
        'status',
        runEvent('w1', 'r1', 'succeeded', '7 found · 6 cards'),
      )
    })
    expect(text(row('w1').querySelector('[data-cell]'))).toBe(
      '7 found · 6 cards',
    )
    expect(text(row('w1'))).toContain('manual · 10-10')
  })

  it('sends Run now and reads queued until the run arrives', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      engines: [exa],
      watches: [watch('w1', 'Orbital fabs')],
    })
    const run = fns.get('runWatchNow')
    run.mockResolvedValueOnce({
      status: 'queued',
      queue: 'plugin.exa.watch',
      jobId: 'j1',
    })
    await act(async () => buttonNamed(/^Run now: Orbital fabs/).click())
    expect(run).toHaveBeenCalledWith({ data: { watchId: 'w1' } })
    expect(text(row('w1').querySelector('[data-cell]'))).toBe('queued')
    await act(async () => {
      FakeEventSource.opened
        .at(0)
        ?.emit('status', runEvent('w1', 'r1', 'running', null))
    })
    expect(text(row('w1').querySelector('[data-cell]'))).toBe('running')
  })
})

describe('Add watch', () => {
  it('opens on the engine with How often on Manual, and saves a manual watch the lane shows at once', async () => {
    await mount('notes', undefined, {
      ...noWatches,
      engines: [exa],
      installed: ['Exa'],
    })
    const add = fns.get('addSpaceWatch')
    add.mockResolvedValueOnce({ id: 'w-new' })
    await act(async () => buttonNamed(/^Add watch$/).click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(text(dialog?.querySelector('h2') ?? null)).toBe('Add watch')
    const labels = Array.from(dialog?.querySelectorAll('label') ?? []).map(
      (l) => text(l),
    )
    expect(labels).toEqual(['Engine', 'Look for', 'How often', 'At most'])
    expect(text(dialog?.querySelector('[aria-label="Engine"]') ?? null)).toBe(
      'Exa',
    )
    expect(
      text(dialog?.querySelector('[aria-label="How often"]') ?? null),
    ).toBe('Manual')
    expect(text(dialog)).toContain('per run')
    // What the server holds once the row is written; drawn only on reload.
    served.current = { ...served.current, watches: [watch('w-new', 'Exa')] }
    expect(document.querySelector('[data-watch="w-new"]')).toBe(null)
    await act(async () => buttonNamed(/^Save watch/).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(add).toHaveBeenCalledWith({
      data: {
        spaceId: spc.id,
        integrationId: exa.integrationId,
        values: { criteria: '', cap: '10' },
        cadenceMinutes: null,
      },
    })
    expect(text(row('w-new'))).toContain('manual')
  })

  it('is absent until an engine is installed', async () => {
    await mount('notes')
    expect(() => buttonNamed(/^Add watch$/)).toThrow()
  })

  it('is off while no installed engine is enabled', async () => {
    await mount('notes', undefined, { ...noWatches, installed: ['Exa'] })
    expect(buttonNamed(/^Add watch$/).disabled).toBe(true)
  })
})

describe("What's moving", () => {
  const signal = (
    id: string,
    recordName: string,
    observedAt: string,
    via: { id: string; name: string } | null,
  ): SpaceWatching['moving'][number] => ({
    id,
    recordId: `rec-${id}`,
    recordName,
    recordKind: 'company',
    via,
    source: 'Exa',
    title: `${recordName} raised`,
    kind: 'funding',
    url: 'https://www.example.com/news',
    refs: [],
    observedAt,
  })

  it('lists signals on members with record, via subspace and source, folding at three', async () => {
    const leasing = { id: spc.children[0].id, name: 'Leasing' }
    await mount('notes', undefined, {
      ...noWatches,
      moving: [
        signal('s1', 'Varda', '2026-10-10T09:00:00.000Z', leasing),
        signal('s2', 'Varda', '2026-10-09T09:00:00.000Z', null),
        signal('s3', 'Tenantry', '2026-10-08T09:00:00.000Z', null),
        signal('s4', 'Arbor', '2026-10-07T09:00:00.000Z', null),
        signal('s5', 'Corbel', '2026-10-06T09:00:00.000Z', null),
      ],
    })
    const moving = lane("What's moving")
    const items = () => Array.from(moving.querySelectorAll('[data-signal]'))
    expect(items()).toHaveLength(3)
    const first = items().at(0) ?? null
    expect(text(first)).toContain('Varda')
    expect(text(first)).toContain('via Leasing')
    expect(text(first)).toContain('Exa')
    expect(text(first?.querySelector('[data-ref]') ?? null)).toBe(
      'example.com ↗',
    )
    expect(text(items().at(1) ?? null)).not.toContain('via')
    await act(async () => buttonNamed(/^\+2 more$/).click())
    expect(items().map((li) => li.getAttribute('data-signal'))).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
    ])
  })
})

/** Open the head's ··· and choose one item, as a keyboard user would. */
async function chooseFromMenu(item: string) {
  const trigger = buttonNamed(/^More for /)
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const hit = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (el) => text(el) === item,
  )
  if (!(hit instanceof HTMLElement)) throw new Error(`no ${item}`)
  await act(async () => hit.click())
  // The menu's focus scope lets go on a later tick; the field opens after.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Type into whatever holds focus, the way a keystroke would land. */
async function typeIntoFocus(value: string) {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`focus is on ${el?.tagName ?? 'nothing'}, not a field`)
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return el
}

async function press(el: Element, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('Rename from ···', () => {
  const field = () => header().querySelector('input[aria-label="Space name"]')

  it('lands focus in a boxed field with ↵ save its one printed key', async () => {
    await mount('notes')
    await chooseFromMenu('Rename')
    const input = field()
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input?.className).toContain('border-hairline')
    expect(input?.className).toContain('h-10')
    expect(text(input?.nextElementSibling ?? null)).toBe('↵ save')
    expect(text(header())).not.toContain('esc')
  })

  it('holds what is typed, and Escape restores the name without a write', async () => {
    await mount('notes')
    await chooseFromMenu('Rename')
    const input = await typeIntoFocus('Property operations')
    expect(input.value).toBe('Property operations')
    await press(input, 'Escape')
    expect(field()).toBeNull()
    expect(text(header().querySelector('h1'))).toBe('Property ops')
    expect(fns.get('renameSpace')).not.toHaveBeenCalled()
  })

  it('saves on Enter, once', async () => {
    await mount('notes')
    await chooseFromMenu('Rename')
    const input = await typeIntoFocus('Property operations')
    await press(input, 'Enter')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const rename = fns.get('renameSpace')
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith({
      data: { id: spc.id, name: 'Property operations' },
    })
    expect(field()).toBeNull()
  })
})

describe('Map', () => {
  it('ends on + Subspace, with or without subspaces', async () => {
    await mount('notes', undefined, undefined, {
      space: { ...spc, children: [] },
    })
    const add = buttonNamed(/^Subspace$/)
    expect(add.querySelector('svg')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/Break it down/)
  })
})

describe('an archived space', () => {
  const archivedSpc: Space = {
    ...spc,
    archive: { on: '2026-10-08T09:00:00.000Z', spaces: 1, filings: 4 },
  }

  it('says watches are paused in a notice on the solid shadow', async () => {
    await mount('notes', undefined, undefined, { space: archivedSpc })
    const notice = document.querySelector('[role="status"]')
    expect(text(notice?.querySelector('p') ?? null).replace(/\s+/g, ' ')).toBe(
      'Archived · out of the tree and the picker · 4 filings kept · watches paused',
    )
    expect(notice?.className).toContain('shadow-solid')
    expect(text(notice)).toContain('Restore')
  })

  it('draws its Notes rows graphite, filed and mentions alike', async () => {
    await mount('notes', undefined, undefined, { space: archivedSpc })
    expect(document.querySelector('h3')?.className).toContain('text-graphite')
    const mention = Array.from(
      document.querySelectorAll('a[href^="/notes/"]'),
    ).find((a) => text(a).startsWith('Market map'))
    expect(mention?.querySelector('.flex-1')?.className ?? '').toContain(
      'text-graphite',
    )
  })

  it('dims under an archived ancestor too', async () => {
    await mount('notes', undefined, undefined, {
      space: { ...spc, archivedUnder: { id: 'p', name: 'Proptech' } },
    })
    expect(document.querySelector('h3')?.className).toContain('text-graphite')
  })
})

/** Any element under a memory router, for the pieces drawn off the page. */
async function mountNode(node: React.ReactNode) {
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const r = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await act(async () => {
    await r.load()
    root.render(<RouterProvider router={r} />)
  })
}

describe("an archived space's filings elsewhere", () => {
  it("dims the space's chip on a note page and marks it archived", async () => {
    await mountNode(
      <filing.FilingRow
        label="Filed in space"
        busy={false}
        chips={[
          { id: 'a', name: 'Launch', href: '/spaces/a', Icon: undefined },
          {
            id: 'b',
            name: 'Harbour',
            href: '/spaces/b',
            Icon: undefined,
            archived: true,
          },
        ]}
        removeLabel={(name) => `Remove from ${name}`}
        onRemove={() => {}}
        adder={null}
      />,
    )
    const live = document.querySelector('[data-chip="live"]')
    const gone = document.querySelector('[data-chip="archived"]')
    expect(live?.className).toContain('font-medium')
    expect(live?.className).not.toContain('text-graphite')
    expect(gone?.className).toContain('text-graphite')
    expect(gone?.className).not.toContain('font-medium')
    expect(text(gone)).toContain('Harbour')
    expect(text(gone)).toContain('archived')
  })

  it("dims the row in a record's Spaces section, with no untag", async () => {
    await mountNode(
      <railRow.SpaceRailRow
        space={{ id: 'b', name: 'Harbour', archived: true }}
        onRemove={() => {}}
      />,
    )
    const link = document.querySelector('a[href="/spaces/b"]')
    expect(link?.className).toContain('text-graphite')
    expect(text(link?.parentElement ?? null)).toContain('archived')
    expect(document.querySelector('button[aria-label^="Remove"]')).toBeNull()
  })
})
