import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useListActions } from './list-actions'
import { ListMenu } from './list-menu'
import { RecordTable } from './record-table'

/**
 * A record list's actions: the row checkboxes raise the selection bar
 * (`n selected · [Add to space] [Enrich…] · Clear`); Enrich… opens the
 * estimate window, Cancel queues nothing and Enrich n sends the checked ids
 * once; Add to space files them in one call and the toast's Undo untags the
 * ones it filed; each row's `···` holds Open in a new tab · Add to space… ·
 * Enrich… · Copy link · Archive, whose toast's Undo restores the record; a
 * kind enrichment does not read has no Enrich….
 * - happy-dom's DOM globals are installed by hand before React loads, as in
 *   the other window tests: the environment would also replace `URL`.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Node',
    'NodeFilter',
    'Element',
    'SVGElement',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Text',
    'DocumentFragment',
    'ShadowRoot',
    'Event',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => ({
  estimateBulkEnrich: vi.fn(),
  bulkEnrich: vi.fn(),
  listSpaces: vi.fn(),
  tagManyIntoSpace: vi.fn(),
  untagFromSpace: vi.fn(),
  archiveRecord: vi.fn(),
  restoreRecord: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)

const toasts = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), message: vi.fn() }),
}))
vi.mock('sonner', () => toasts)

type Row = { id: string; name: string }
const ROWS: Array<Row> = Array.from({ length: 3 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${String(i + 1)}`,
  name: `Co ${String(i + 1)}`,
}))
const PROPTECH = '00000000-0000-4000-8000-0000000000a1'
const OPS = '00000000-0000-4000-8000-0000000000a2'

const none = { sensitive: 0, reuse: 0, key: 0, queued: 0 }
const estimate = (over: Record<string, unknown> = {}) => ({
  total: 40,
  ask: 34,
  parks: 0,
  skipped: { sensitive: 2, reuse: 2, key: 2, queued: 0 },
  reuseDays: 90,
  matched: 40,
  sources: [
    {
      id: 'website',
      name: 'Website',
      local: true,
      ask: 36,
      skipped: { ...none, reuse: 2, key: 2 },
      credits: 0,
      left: null,
      parks: 0,
    },
    {
      id: 'apollo',
      name: 'Apollo',
      local: false,
      ask: 34,
      skipped: { sensitive: 2, reuse: 2, key: 2, queued: 0 },
      credits: 34,
      left: 100,
      parks: 0,
    },
  ],
  ...over,
})

const col = createColumnHelper<Row>()
const columns = [col.accessor('name', { id: 'name', header: 'Company' })]
const refresh = vi.fn()

function Harness({ enrich }: { enrich: boolean }) {
  const actions = useListActions({
    label: 'Companies',
    noun: { one: 'company', many: 'companies' },
    rows: ROWS,
    hrefOf: (r) => `/companies/${r.id}`,
    enrich: enrich
      ? { kind: 'company', view: { conditions: [], q: 'co' } }
      : null,
    refresh,
  })
  const table = useReactTable({
    data: ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <div>
      {actions.enrichVerb ? (
        <ListMenu label="Companies" verbs={[actions.enrichVerb]} />
      ) : null}
      {actions.selectionBar}
      <RecordTable
        table={table}
        label="Companies"
        stickyColumnId="name"
        select={actions.select}
        rowEnd={actions.rowMenu}
      />
      {actions.dialogs}
    </div>
  )
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.estimateBulkEnrich.mockResolvedValue(estimate())
  fns.bulkEnrich.mockResolvedValue({
    queued: 34,
    parked: 0,
    already: 0,
    resumesAt: null,
  })
  fns.listSpaces.mockResolvedValue([
    { id: PROPTECH, name: 'Proptech', parentId: null, companies: 4 },
    { id: OPS, name: 'Property ops', parentId: PROPTECH, companies: 2 },
  ])
  fns.untagFromSpace.mockResolvedValue({ ok: true })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.replaceChildren()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

const mount = async (enrich = true) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<Harness enrich={enrich} />))
  await flush()
}

const text = (el: Element | null) => (el?.textContent ?? '').trim()

const button = (match: RegExp, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll('button')].find((b) =>
    match.test(text(b)),
  )
  if (found === undefined) throw new Error(`no button ${String(match)}`)
  return found
}

const labelled = (label: string) => {
  const el = document.querySelector(`[aria-label="${label}"]`)
  if (el === null) throw new Error(`no ${label}`)
  return el
}

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const bar = () => document.querySelector('[data-selection-bar]')
const dialog = () => document.querySelector('[role="dialog"]')
const barButtons = () =>
  [...(bar()?.querySelectorAll('button') ?? [])].map((b) => text(b))

async function rowMenu(name: string): Promise<Array<string>> {
  const trigger = labelled(`More for ${name}`)
  if (!(trigger instanceof HTMLElement)) throw new Error('no trigger')
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await flush()
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
    text(el),
  )
}

describe('the selection bar', () => {
  it('n selected, then Add to space and Enrich…, and Clear on the right', async () => {
    await mount()
    expect(bar()).toBeNull()
    await click(labelled('Select Co 1'))
    await click(labelled('Select Co 2'))
    expect(text(bar())).toMatch(/^2 selected/)
    expect(barButtons()).toEqual(['Add to space', 'Enrich…', 'Clear'])
    await click(button(/^Clear$/))
    expect(bar()).toBeNull()
  })

  it('the head box checks every loaded row', async () => {
    await mount()
    await click(labelled('Select every loaded row of Companies'))
    expect(text(bar())).toMatch(/^3 selected/)
  })

  it('a kind enrichment does not read has no Enrich…', async () => {
    await mount(false)
    await click(labelled('Select Co 1'))
    expect(barButtons()).toEqual(['Add to space', 'Clear'])
    expect(await rowMenu('Co 1')).toEqual([
      'Open in a new tab',
      'Add to space…',
      'Copy link',
      'Archive',
    ])
  })
})

describe('the row ···', () => {
  it('Open in a new tab · Add to space… · Enrich… · Copy link · Archive, and no Delete', async () => {
    await mount()
    expect(await rowMenu('Co 2')).toEqual([
      'Open in a new tab',
      'Add to space…',
      'Enrich…',
      'Copy link',
      'Archive',
    ])
    const open = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Open in a new tab',
    )
    expect(open?.getAttribute('href')).toBe(`/companies/${ROWS[1]?.id}`)
    expect(open?.getAttribute('target')).toBe('_blank')
  })
})

describe('Archive in the row ···', () => {
  it('asks nothing: archives the record, refreshes, and Undo restores it', async () => {
    fns.archiveRecord.mockResolvedValue({ on: '2026-10-28T10:00:00.000Z' })
    fns.restoreRecord.mockResolvedValue({ restored: true })
    await mount()
    await rowMenu('Co 2')
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Archive',
    )
    if (item === undefined) throw new Error('no Archive')
    await click(item)
    expect(dialog()).toBeNull()
    expect(fns.archiveRecord).toHaveBeenCalledWith({
      data: { id: ROWS[1]?.id },
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    const call = toasts.toast.mock.calls.at(0)
    expect(call?.[0]).toBe('Archived Co 2')
    const undo = Reflect.get(Reflect.get(call?.[1] ?? {}, 'action'), 'onClick')
    if (typeof undo !== 'function') throw new Error('no Undo')
    await act(async () => {
      undo()
    })
    await flush()
    expect(fns.restoreRecord).toHaveBeenCalledWith({
      data: { id: ROWS[1]?.id },
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

describe('the estimate window', () => {
  it('rows to ask and skipped, the split on hover, the credits in the foot; Cancel queues nothing', async () => {
    await mount()
    await click(labelled('Select Co 1'))
    await click(button(/^Enrich…$/, bar() ?? document))
    expect(fns.estimateBulkEnrich).toHaveBeenCalledWith({
      data: { kind: 'company', target: { ids: [ROWS[0]?.id] } },
    })
    expect(text(document.querySelector('[data-estimate-scope]'))).toBe(
      'Selected',
    )
    const rows = [...document.querySelectorAll('[data-estimate-row]')].map(
      (r) => text(r),
    )
    expect(rows).toEqual([
      'To ask34',
      'Skipped, sensitive2',
      'Already enriched in the last 90 days2',
      'No domain2',
    ])
    expect(
      document
        .querySelector('[data-estimate-row="ask"]')
        ?.getAttribute('title'),
    ).toBe('Website 36 · free\nApollo 34 · about 34 credits of 100 left today')
    expect(text(dialog())).toContain('About 34 credits · 100 left today')
    await click(button(/^Cancel$/))
    expect(dialog()).toBeNull()
    expect(fns.bulkEnrich).not.toHaveBeenCalled()
  })

  it('Enrich n sends the checked ids once, clears the selection and refreshes', async () => {
    await mount()
    await click(labelled('Select Co 1'))
    await click(labelled('Select Co 3'))
    await click(button(/^Enrich…$/, bar() ?? document))
    await click(button(/^Enrich 34/))
    expect(fns.bulkEnrich).toHaveBeenCalledTimes(1)
    expect(fns.bulkEnrich).toHaveBeenCalledWith({
      data: {
        kind: 'company',
        target: { ids: [ROWS[0]?.id, ROWS[2]?.id] },
      },
    })
    expect(dialog()).toBeNull()
    expect(bar()).toBeNull()
    expect(refresh).toHaveBeenCalled()
  })

  it('over the cap, says how many park until the reset', async () => {
    fns.estimateBulkEnrich.mockResolvedValue(
      estimate({
        parks: 6,
        sources: [
          {
            id: 'apollo',
            name: 'Apollo',
            local: false,
            ask: 34,
            skipped: none,
            credits: 34,
            left: 28,
            parks: 6,
          },
        ],
      }),
    )
    await mount()
    await click(labelled('Select Co 1'))
    await click(button(/^Enrich…$/, bar() ?? document))
    expect(text(document.querySelector('[data-estimate-parks]'))).toBe(
      '6 park until 00:00 UTC · Apollo’s daily cap',
    )
  })

  it('the head’s Enrich… estimates the list as its view shows it', async () => {
    await mount()
    // The head's `···` holds one verb, so it is that verb as a button.
    expect(document.querySelector('[aria-label="More for Companies"]')).toBe(
      null,
    )
    await click(button(/^Enrich…$/))
    await flush()
    expect(fns.estimateBulkEnrich).toHaveBeenCalledWith({
      data: { kind: 'company', target: { conditions: [], q: 'co' } },
    })
    expect(text(document.querySelector('[data-estimate-scope]'))).toBe(
      'This view',
    )
  })
})

describe('Add to space', () => {
  it('files the checked rows in one call; the toast’s Undo untags the ones it filed', async () => {
    // Co 1 was already there: only Co 2 is new.
    fns.tagManyIntoSpace.mockResolvedValue({ tagged: [ROWS[1]?.id] })
    await mount()
    await click(labelled('Select Co 1'))
    await click(labelled('Select Co 2'))
    await click(button(/^Add to space$/, bar() ?? document))
    await flush()
    expect(text(dialog()?.querySelector('h2') ?? null)).toBe(
      'Add 2 companies to a space',
    )
    expect(button(/^Add 2$/).disabled).toBe(true)
    await click(document.querySelector('[role="combobox"]') ?? document.body)
    const option = [...document.querySelectorAll('[cmdk-item]')].find(
      (el) => text(el) === 'Proptech › Property ops',
    )
    if (option === undefined) throw new Error('no Property ops option')
    await click(option)
    await click(button(/^Add 2$/))
    expect(fns.tagManyIntoSpace).toHaveBeenCalledTimes(1)
    expect(fns.tagManyIntoSpace).toHaveBeenCalledWith({
      data: { spaceId: OPS, entityIds: [ROWS[0]?.id, ROWS[1]?.id] },
    })
    expect(dialog()).toBeNull()
    expect(bar()).toBeNull()
    const [message, options] = toasts.toast.mock.calls.at(-1) ?? []
    expect(message).toBe('1 company added to Property ops')
    const action: unknown = Reflect.get(Object(options), 'action')
    expect(Reflect.get(Object(action), 'label')).toBe('Undo')
    const undo: unknown = Reflect.get(Object(action), 'onClick')
    if (typeof undo !== 'function') throw new Error('no Undo')
    await act(async () => {
      undo()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fns.untagFromSpace).toHaveBeenCalledTimes(1)
    expect(fns.untagFromSpace).toHaveBeenCalledWith({
      data: { entityId: ROWS[1]?.id, spaceId: OPS },
    })
  })
})
