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
import type * as RouterModule from '@tanstack/react-router'
import type { AnyRoute } from '@tanstack/react-router'
import { ClockProvider } from '#/components/clock'

/**
 * The heads and bands of the work pages — Tasks, Notes, Meetings, Mandate
 * and Review — each mounted under a memory router whose ids mirror the
 * app's (`_app` → the page), on fixture data:
 * - Tasks: the title alone, a bone band with `Open n | Done n`, caps group
 *   heads, the row `···`, the composer as the last row, and `?record=`
 *   reaching the read.
 * - Notes: the meta line, `This week` and `Earlier` bands, the fold.
 * - Meetings: the tab bar counted by the server, not by the rows sent.
 * - Mandate: the meta and the save state, sans labels, the geography field.
 * - Review: the title and Scan alone, the lane tabs, Dismiss never Reject.
 */

const fns = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listMeetings: vi.fn(),
  listTemplates: vi.fn(async () => []),
  listUsers: vi.fn(async () => []),
}))

vi.mock('#/lib/server-fns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...fns,
}))

vi.mock('#/components/editor/note-editor', () => ({
  NoteEditor: () => null,
  deriveMarkdown: () => '',
  extractMentionIds: () => [],
}))

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
    message: () => undefined,
  }),
}))

vi.setConfig({ hookTimeout: 90_000 })

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let router: typeof RouterModule
const routes = new Map<string, { Route: AnyRoute }>()

beforeAll(async () => {
  for (const key of [
    'window',
    'document',
    'navigator',
    'localStorage',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'NodeFilter',
    'SVGElement',
    'ShadowRoot',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
  ] as const)
    vi.stubGlobal(key, win[key])
  vi.stubGlobal('self', win)
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame.bind(win))
  vi.stubGlobal('cancelAnimationFrame', win.cancelAnimationFrame.bind(win))
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  router = await import('@tanstack/react-router')
  routes.set('tasks', await import('#/routes/_app/tasks'))
  routes.set('notes', await import('#/routes/_app/notes'))
  routes.set('meetings', await import('#/routes/_app/meetings'))
  routes.set('mandate', await import('#/routes/_app/mandate'))
  routes.set('review', await import('#/routes/_app/review'))
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

afterEach(async () => {
  act(() => root.unmount())
  await new Promise((resolve) => setTimeout(resolve, 0))
  document.body.replaceChildren()
})

/** Thu 15 Oct 2026, mid-morning. */
const NOW = '2026-10-15T09:00:00.000Z'
const ME = { id: 'u-me', name: 'Anish Badri' }

/**
 * Mount one page. `loader` replaces the route's own when given; without it
 * the route's search, deps and loader run against the mocked server fns.
 */
async function mount(path: string, url: string, loader?: () => unknown) {
  const {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
  } = router
  const mod = routes.get(path)
  if (mod === undefined) throw new Error(`no page ${path}`)
  const options = mod.Route.options
  const rootRoute = createRootRoute()
  const app = createRoute({
    getParentRoute: () => rootRoute,
    id: '_app',
    beforeLoad: () => ({ session: { user: ME } }),
    component: () => <Outlet />,
  })
  const route = createRoute({
    getParentRoute: () => app,
    path,
    ...(options.component === undefined
      ? {}
      : { component: options.component }),
    ...(options.validateSearch === undefined
      ? {}
      : { validateSearch: options.validateSearch }),
    ...(loader !== undefined
      ? { loader }
      : options.loaderDeps === undefined || options.loader === undefined
        ? {}
        : { loaderDeps: options.loaderDeps, loader: options.loader }),
  })
  const r = createRouter({
    routeTree: rootRoute.addChildren([app.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await act(async () => {
    await r.load()
    root.render(
      <ClockProvider now={NOW}>
        <RouterProvider router={r} />
      </ClockProvider>,
    )
  })
}

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

const title = () => document.querySelector('h1')?.textContent
const text = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((el) =>
    el.textContent.trim(),
  )
/** The head's controls in order, each by its text or else its name. */
const head = () =>
  Array.from(document.querySelectorAll('[data-head-actions] > *')).map(
    (el) => el.getAttribute('aria-label') ?? el.textContent.trim(),
  )
const headMeta = () =>
  document.querySelector('header .mono.text-label')?.textContent ?? null

async function menuItems(label: string): Promise<Array<string>> {
  const trigger = document.querySelector(`button[aria-label="${label}"]`)
  if (!(trigger instanceof HTMLElement)) throw new Error(`no ${label}`)
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await until(
    'the menu',
    () => document.querySelector('[role="menu"]') !== null,
  )
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) =>
    el.textContent.trim(),
  )
}

// ---------------------------------------------------------------------------

const FLENT = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'Flent',
  kind: 'company',
  objectSlug: null,
}

const aTask = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  content: 'A task',
  dueDate: null,
  assigneeId: ME.id,
  assigneeName: ME.name,
  doneAt: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  entities: [],
  ...over,
})

const TASKS = {
  open: [
    aTask({
      content: 'Chase the data room',
      dueDate: '2026-10-13',
      entities: [FLENT],
    }),
    aTask({ content: 'Send the memo', dueDate: '2026-10-15' }),
    aTask({ content: 'Re-mark', dueDate: '2026-10-17' }),
    aTask({ content: 'Revisit', dueDate: '2026-11-20' }),
  ],
  done: Array.from({ length: 12 }, (_, i) =>
    aTask({ content: `Closed ${i}`, doneAt: '2026-10-10T09:00:00.000Z' }),
  ),
  record: null,
}

describe('Tasks', () => {
  it('is the title alone, a bone band with Open | Done, caps groups, and the composer as the last row', async () => {
    fns.listTasks.mockResolvedValue(TASKS)
    await mount('tasks', '/tasks')
    await until('the head', () => title() === 'Tasks')
    expect(headMeta()).toBeNull()
    expect(head()).toEqual([])
    const band = document.querySelector('[data-tasks-band]')
    expect(band?.className).toContain('bg-bone')
    expect(
      Array.from(band?.querySelectorAll('[role="radio"]') ?? []).map(
        (el) => el.textContent,
      ),
    ).toEqual(['Open4', 'Done12'])
    expect(text('section h2')).toEqual([
      'OVERDUE',
      'TODAY · THU 15 OCT',
      'THIS WEEK · THROUGH SUN 18 OCT',
      'LATER',
    ])
    expect(
      document.querySelector('section h2 .text-destructive')?.textContent,
    ).toBe('OVERDUE')
    // The record in graphite; the due figure through formatDue.
    const first = document.querySelector('[data-task-row]')
    expect(first?.textContent).toContain('Flent')
    expect(first?.textContent).toContain('−2d')
    // The viewer's own name is never printed on a row.
    expect(first?.textContent).not.toContain(ME.name)
    // No hover trash: delete lives in the row's ···.
    expect(document.querySelector('[aria-label^="Delete task"]')).toBeNull()
    const last = Array.from(document.querySelectorAll('section ol')).at(
      -1,
    )?.lastElementChild
    expect(last?.textContent).toBe('+Add a task…T')
  })

  it('a row’s ··· opens its record, edits, copies, and deletes last', async () => {
    fns.listTasks.mockResolvedValue(TASKS)
    await mount('tasks', '/tasks')
    await until('the rows', () => title() === 'Tasks')
    expect(await menuItems('More for Chase the data room')).toEqual([
      'Open Flent',
      'Due date…',
      'Assign…',
      'Copy link',
      'Delete task',
    ])
  })

  it('`?record=` narrows the read and names the record on the band', async () => {
    fns.listTasks.mockResolvedValue({
      ...TASKS,
      open: TASKS.open.slice(0, 1),
      done: [],
      record: { id: FLENT.id, name: 'Flent', kind: 'company' },
    })
    await mount('tasks', `/tasks?record=${FLENT.id}`)
    await until('the band', () => title() === 'Tasks')
    expect(fns.listTasks).toHaveBeenCalledWith({
      data: { includeDone: true, focus: undefined, record: FLENT.id },
    })
    expect(document.querySelector('[data-task-scope]')?.textContent).toContain(
      'On Flent',
    )
  })
})

// ---------------------------------------------------------------------------

const aNote = (i: number, updatedAt: string, kind = 'note') => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  title: `Note ${i}`,
  snippet: 'Body',
  kind,
  updatedAt,
})

describe('Notes', () => {
  it('reads n notes · last edit, bands This week and Earlier, and folds Earlier past 20', async () => {
    const notes = [
      aNote(1, '2026-10-14T10:00:00.000Z', 'memo'),
      aNote(2, '2026-10-13T10:00:00.000Z', 'scratch'),
      aNote(3, '2026-10-12T10:00:00.000Z'),
      ...Array.from({ length: 23 }, (_, i) =>
        aNote(10 + i, '2026-09-01T10:00:00.000Z'),
      ),
    ]
    await mount('notes', '/notes', () => notes)
    await until('the head', () => title() === 'Notes')
    expect(headMeta()).toBe('26 notes · last edit 14 Oct')
    expect(head()).toEqual(['From template', 'New note'])
    expect(text('section h2')).toEqual(['This week', 'Earlier'])
    expect(text('[data-section-count]')).toEqual(['3', '23'])
    expect(document.body.textContent).not.toMatch(/W\d\d/)
    expect(text('[data-kind-lane]').slice(0, 3)).toEqual([
      'MEMO',
      'SCRATCH',
      '',
    ])
    const fold = document.querySelector('[data-fold-row]')
    expect(fold?.textContent).toBe('3 more')
    expect(
      Array.from(document.querySelectorAll('section'))
        .at(1)
        ?.querySelectorAll('a'),
    ).toHaveLength(20)
    await act(async () => {
      if (fold instanceof HTMLElement) fold.click()
    })
    expect(
      Array.from(document.querySelectorAll('section'))
        .at(1)
        ?.querySelectorAll('a'),
    ).toHaveLength(23)
  })
})

// ---------------------------------------------------------------------------

describe('Meetings', () => {
  it('carries the server’s counts on the tab bar', async () => {
    fns.listMeetings.mockResolvedValue({
      calendar: true,
      audience: { isAdmin: true, admins: [] },
      upcoming: [],
      past: [],
      earlier: 0,
      // What the server counted, over more meetings than it sent.
      counts: { all: 16, upcoming: 4, past: 12, unwritten: 3, mine: 9 },
    })
    await mount('meetings', '/meetings', () => null)
    await until('the counts', () =>
      text('[role="tab"]').some((t) => t === 'All16'),
    )
    expect(text('[role="tab"]')).toEqual([
      'All16',
      'Upcoming4',
      'Past12',
      'No write-up3',
      'Mine9',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('Mandate', () => {
  it('reads Updated · stages · geos with sans labels, the stage count, and an inline geography field', async () => {
    await mount('mandate', '/mandate', () => ({
      mandate: {
        noteEntityId: 'n1',
        stages: ['seed', 'a', 'b'],
        geos: ['India', 'US'],
        checkMin: 100000,
        checkMax: 500000,
        currency: 'USD',
      },
      note: {
        id: 'n1',
        title: 'Mandate',
        updatedAt: '2026-10-12T10:00:00.000Z',
        bodyJson: null,
      },
      stageOptions: ['pre', 'seed', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
        (id) => ({ id, label: id.toUpperCase() }),
      ),
    }))
    await until('the head', () => title() === 'Mandate')
    expect(document.querySelector('[data-mandate-meta]')?.textContent).toBe(
      'Updated 12 Oct · 3 stages · 2 geos',
    )
    expect(document.body.textContent).toContain('3 of 9')
    expect(document.body.textContent).not.toContain('whole units')
    const labels = Array.from(document.querySelectorAll('.w-24')).map((el) => [
      el.textContent,
      el.className.includes('text-label'),
    ])
    expect(labels).toEqual([
      ['Stages', true],
      ['Geographies', true],
      ['Check size', true],
    ])
    expect(text('[data-geo-chip]')).toEqual(['India×', 'US×'])
    const field = document.querySelector('input[aria-label="Add a geography"]')
    expect(field?.getAttribute('placeholder')).toBe('Singapore…')
    const min = document.querySelector('input[aria-label="Minimum check"]')
    expect(min instanceof HTMLInputElement ? min.value : null).toBe('100,000')
  })
})

// ---------------------------------------------------------------------------

describe('Review', () => {
  it('is the title and Scan for duplicates, with lane tabs and no description', async () => {
    await mount('review', '/review', () => ({
      rows: [],
      scope: null,
      filter: null,
      stoppedPlugins: [],
    }))
    await until('the head', () => title() === 'Review')
    expect(headMeta()).toBeNull()
    expect(head()).toEqual(['Scan for duplicates'])
    expect(document.body.textContent).not.toContain('Reject')
  })

  it('counts its lanes on the tab bar and decides with Dismiss, on flat cards', async () => {
    const side = (id: string, name: string) => ({
      id,
      name,
      kind: 'company',
      createdAt: '2026-10-01T00:00:00.000Z',
      objectSlug: 'company',
      objectSingular: 'Company',
      sourceClass: 'manual',
      sourceCapability: null,
      label: 'manual',
      domains: ['flent.io'],
      identityDomain: null,
      otherNames: [],
      mentionCount: 0,
      valueCount: 0,
      spaces: [],
    })
    const pair = {
      kind: 'duplicate_candidate',
      id: 'pair-1',
      score: 1,
      reason: { shared: 'domain', value: 'flent.io' },
      latestAt: '2026-10-09T10:00:00.000Z',
      a: side('a1', 'Flent'),
      b: side('b1', 'Flent Labs'),
    }
    const card = {
      kind: 'suggestion',
      id: FLENT.id,
      record: { ...FLENT, objectSingular: 'Company' },
      page: null,
      latestAt: '2026-10-14T10:00:00.000Z',
      suggestions: [
        {
          id: 's1',
          kind: 'attribute_patch',
          payload: {},
          rationale: null,
          citations: [],
          fields: [
            {
              slug: 'funding_stage',
              name: 'Funding stage',
              type: 'text',
              options: null,
              isSystem: true,
              value: 'Series A',
              current: 'Seed',
              confidence: 0.82,
            },
          ],
          origin: { via: 'integration' },
          source: 'Apollo',
          createdAt: '2026-10-14T10:00:00.000Z',
          runId: null,
        },
      ],
    }
    await mount('review', '/review', () => ({
      rows: [card, pair],
      scope: null,
      filter: null,
      stoppedPlugins: [],
    }))
    await until('the tabs', () => text('[role="tab"]').length === 3)
    expect(text('[role="tab"]')).toEqual([
      'All2',
      'Suggestions1',
      'Duplicates1',
    ])
    const suggestion = document.querySelector('[data-suggestion-card]')
    expect(suggestion?.querySelector('h2')?.textContent).toBe('Flent')
    expect(
      suggestion?.querySelector('[data-suggestion-meta]')?.textContent,
    ).toBe('Funding stage · via Apollo · 14 Oct')
    expect(
      Array.from(
        suggestion?.querySelectorAll(
          '[data-field-grid] > div:first-child > span',
        ) ?? [],
      ).map((el) => el.textContent),
    ).toEqual(['Proposed', 'Current', 'Confidence', 'Source'])
    expect(suggestion?.textContent).toContain('82%')
    expect(
      Array.from(
        suggestion?.querySelectorAll('[data-suggestion-foot] button') ?? [],
      ).map((el) => el.textContent),
    ).toEqual(['Dismiss', 'Accept'])
    const pairCard = document.querySelector('[data-pair-card]')
    expect(pairCard?.querySelector('h2')?.textContent).toBe(
      'Flent ⇄ Flent Labs',
    )
    expect(pairCard?.textContent).toContain('Same domain · 9 Oct')
    for (const el of document.querySelectorAll(
      'li[data-pair-card], li[data-suggestion-card]',
    ))
      expect(el.className).not.toContain('shadow-solid')
    expect(document.body.textContent).not.toContain('Reject')
  })
})
