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
import type * as NeedsYouModule from './needs-you'
import type { NeedsYouRow, ProposalActions } from './needs-you'
import type * as RouterModule from '@tanstack/react-router'
import type { InboxRow, SuggestionItem } from '#/lib/server-fns'
import { flattenInbox } from '#/lib/today/proposals'

/**
 * Proposals decided in place, mounted on a happy-dom `Window`: a group's ▸
 * opens its children under it, each with a rule in its mark slot and no
 * kind; the verbs reach the caller; on a focused row `A` is the primary and
 * `D` dismisses.
 */

vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let view: typeof NeedsYouModule
let router: typeof RouterModule

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('localStorage', win.localStorage)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  view = await import('./needs-you')
  router = await import('@tanstack/react-router')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root

beforeEach(() => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const SPACE = '00000000-0000-4000-8000-0000000000a1'

const company = (id: string, name: string): SuggestionItem => ({
  id,
  kind: 'add_record',
  payload: {
    spaceId: SPACE,
    domain: `${id}.com`,
    name,
    evidence: [],
    aliases: [],
    subspaceHint: null,
  },
  rationale: null,
  citations: [],
  fields: null,
  origin: { via: 'integration' },
  source: 'Exa',
  createdAt: '2026-10-20T10:00:00.000Z',
  runId: null,
})

const queue: InboxRow[] = [
  {
    kind: 'discovery',
    id: SPACE,
    space: { id: SPACE, name: 'Property ops', path: 'Proptech / Property ops' },
    via: ['Exa'],
    suggestions: [company('d1', 'Rentwise'), company('d2', 'Leaseline')],
    latestAt: '2026-10-20T10:00:00.000Z',
  },
  {
    kind: 'suggestion',
    id: 'r1',
    record: {
      id: 'r1',
      name: 'Exponent',
      kind: 'company',
      objectSlug: null,
      objectSingular: null,
    },
    page: null,
    suggestions: [
      {
        ...company('s1', 'Exponent'),
        kind: 'task',
        payload: { title: 'Send the deck', due: null, entity_id: SPACE },
        source: null,
        origin: { via: 'app' },
      },
    ],
    latestAt: '2026-10-20T10:00:00.000Z',
  },
]

const rows: NeedsYouRow[] = flattenInbox(queue, {
  today: '2026-10-28',
  filedIn: {},
}).map((p) => ({
  kind: 'review',
  key: `review:${p.key}`,
  weight: 0,
  sensitive: null,
  proposal: p,
  figure: '8d',
}))

async function mount(actions: ProposalActions) {
  const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
    router
  const rootRoute = createRootRoute({
    component: () => (
      <view.NeedsYou
        rows={rows}
        filter="all"
        onFilter={() => {}}
        readout={null}
        loading={false}
        onComplete={() => {}}
        onOpen={() => {}}
        taskMenu={() => []}
        onCreated={() => {}}
        washes={() => false}
        actions={actions}
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
}

const listed = () => [...document.querySelectorAll('li[data-row]')]

function buttonIn(row: Element, name: string): HTMLElement {
  const hit = [...row.querySelectorAll('button')].find(
    (b) => b.textContent === name,
  )
  if (hit === undefined) throw new Error(`no ${name} button`)
  return hit
}

const press = (el: Element, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })

describe('proposals decided in place', () => {
  it('opens a group onto its children, each ruled and without a kind', async () => {
    const decide = vi.fn()
    await mount({
      decide,
      acceptAll: () => {},
      canAddOption: true,
      since: () => '8d',
    })
    expect(listed()).toHaveLength(2)
    const group = listed()[0]
    const toggle = group.querySelector('button[aria-expanded]')
    if (toggle === null) throw new Error('no toggle')
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const children = document.querySelectorAll('li[data-needs-child]')
    expect([...children].map((c) => c.textContent)).toEqual([
      expect.stringContaining('Rentwise'),
      expect.stringContaining('Leaseline'),
    ])
    // Children sit straight under their group, before the next row.
    expect(listed()[1].hasAttribute('data-needs-child')).toBe(true)
    expect(listed()[3].textContent).toContain('Send the deck')
    for (const c of children) {
      expect(c.querySelector('[data-child-rule]')).not.toBeNull()
      expect(c.firstElementChild?.textContent).toBe('')
    }

    // A child's verbs decide that child.
    await act(async () => {
      buttonIn(children[1], 'Add and file').click()
    })
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'suggestion:d2' }),
      'accept',
    )
  })

  it('decides a focused row with A and D, and its buttons alike', async () => {
    const decide = vi.fn()
    await mount({
      decide,
      acceptAll: () => {},
      canAddOption: true,
      since: () => '8d',
    })
    const task = listed()[1]
    await press(task, 'a')
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'suggestion:s1', primary: 'Add task' }),
      'accept',
    )
    await press(task, 'D')
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'suggestion:s1' }),
      'dismiss',
    )
    await act(async () => {
      buttonIn(task, 'Dismiss').click()
    })
    expect(decide).toHaveBeenCalledTimes(3)
    // A group row has no primary of its own to accept.
    await press(listed()[0], 'a')
    expect(decide).toHaveBeenCalledTimes(3)
  })
})
