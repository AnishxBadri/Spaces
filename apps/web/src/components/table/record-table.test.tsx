import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { RecordTable, TableToolbar } from './record-table'
import type { TablePage } from './record-table'
import { ListErrorRow, ListLoadingRow, ListZeroRow } from './list-states'
import { declared } from '#/test/tailwind-css'

/**
 * The record table's head and rows: the head is its own table pinned under
 * the folded page head, outside the sideways scroller, and follows the body's
 * `scrollLeft`; every cell is bounded to the 36px row; a figures column
 * right-aligns its head. A shelf's bar is real tabs with the tools right.
 * - happy-dom's DOM globals are installed by hand before React loads, as in
 *   the other window tests.
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

type Row = { id: string; name: string; invested: string }
const ROWS: Array<Row> = [
  { id: 'a', name: 'Aarogya', invested: '$120K' },
  { id: 'b', name: 'Bharat', invested: '$90K' },
]

const col = createColumnHelper<Row>()
const columns = [
  col.accessor('name', { id: 'name', header: 'Company', size: 240 }),
  col.accessor('invested', {
    id: 'invested',
    header: 'Invested',
    size: 130,
    meta: { numeric: true },
  }),
]

function Grid({
  page,
  notice,
  rows = ROWS,
}: {
  page?: TablePage
  notice?: ReactNode
  rows?: Array<Row>
} = {}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <>
      <TableToolbar
        table={table}
        label="Holdings"
        tabs={[{ id: 'all', label: 'All', count: ROWS.length }]}
        value="all"
        onValueChange={() => {}}
        filter=""
        onFilterChange={() => {}}
        filterPlaceholder="Filter by company…"
        filterLabel="Filter holdings"
      />
      <RecordTable
        table={table}
        label="Portfolio"
        stickyColumnId="name"
        {...(page ? { page } : {})}
        notice={notice}
      />
    </>
  )
}

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function mount(props: Parameters<typeof Grid>[0] = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<Grid {...props} />))
}

const paging = (over: Partial<TablePage> = {}): TablePage => ({
  total: 120,
  hasMore: true,
  loading: false,
  step: 50,
  onLoadMore: () => {},
  ...over,
})

function one(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) throw new Error(`no ${selector}`)
  return el
}

const classes = (el: Element) => el.className.split(/\s+/)

describe('the sticky head', () => {
  it('is its own row group, pinned under the folded bar, outside the sideways scroller', () => {
    mount()
    const head = one('[data-table-head]')
    const body = one('[data-table-body]')
    expect(classes(head)).toEqual(
      expect.arrayContaining(['sticky', 'top-22', 'md:top-10', 'z-sticky']),
    )
    // Opaque, so rows scrolling under it never show through.
    expect(classes(head)).toContain('bg-paper')
    expect(head.querySelector('thead')).not.toBeNull()
    expect(body.querySelector('thead')).toBeNull()
    // The body scrolls sideways; the head is never inside it.
    expect(classes(body)).toContain('overflow-x-auto')
    expect(body.contains(head)).toBe(false)
  })

  it('is one table to assistive tech: column heads and cells under one name', () => {
    mount()
    const grid = one('[role="table"]')
    expect(grid.getAttribute('aria-label')).toBe('Portfolio')
    const heads = [...grid.querySelectorAll('[role="columnheader"]')].map((h) =>
      h.textContent.trim(),
    )
    expect(heads.slice(0, 2)).toEqual(['Company', 'Invested'])
    expect(grid.querySelectorAll('tbody [role="row"]')).toHaveLength(2)
  })

  it('follows the body when it scrolls sideways', () => {
    mount()
    const head = one('[data-table-head]')
    const body = one('[data-table-body]')
    act(() => {
      body.scrollLeft = 120
      body.dispatchEvent(new Event('scroll'))
    })
    expect(head.scrollLeft).toBe(body.scrollLeft)
  })

  it('shares one fixed width with the body, never narrower than the pane', () => {
    mount()
    const [headTable, bodyTable] = [
      ...document.querySelectorAll('[role="table"] table'),
    ]
    if (!(headTable instanceof HTMLElement && bodyTable instanceof HTMLElement))
      throw new Error('two tables expected')
    expect(headTable.style.width).toBe(bodyTable.style.width)
    expect(bodyTable.style.minWidth).toBe('100%')
    expect(classes(bodyTable)).toContain('table-fixed')
  })
})

describe('a row', () => {
  it('is 36px and its cells cannot grow it past the row less its rule', async () => {
    mount()
    const tr = one('tbody tr')
    expect(classes(tr)).toContain('h-row')
    const cell = one('tbody [data-cell]')
    expect(await declared(cell.className, 'max-height')).toEqual([
      'calc(var(--spacing-row) - 1px)',
    ])
    expect(await declared(cell.className, 'overflow')).toEqual(['hidden'])
  })

  it('right-aligns a figures column head', () => {
    mount()
    const heads = [...document.querySelectorAll('thead th')]
    const invested = heads.find((h) => h.textContent.includes('Invested'))
    const company = heads.find((h) => h.textContent.includes('Company'))
    if (!invested || !company) throw new Error('heads missing')
    expect(classes(invested)).toContain('text-right')
    expect(classes(company)).toContain('text-left')
  })
})

describe("a shelf's bar", () => {
  it('is real tabs on the bone head bar, with Sort, Columns and the text box right', () => {
    mount()
    const bar = one('[data-tab-bar]')
    expect(classes(bar)).toEqual(expect.arrayContaining(['bg-bone', 'h-11']))
    const tab = one('[role="tab"]')
    expect(tab.textContent).toBe('All2')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    const controls = [...bar.querySelectorAll('button, input')]
      .filter((el) => el.getAttribute('role') !== 'tab')
      .map((el) =>
        el instanceof HTMLInputElement
          ? el.getAttribute('aria-label')
          : el.textContent.trim(),
      )
    expect(controls).toEqual(['Sort', 'Columns', 'Filter holdings'])
    // The tools sit outside the tablist: only tabs are its children.
    expect(one('[role="tablist"]').querySelectorAll('button')).toHaveLength(1)
  })
})

describe('the foot', () => {
  it('is absent on a table that does not page', () => {
    mount()
    expect(document.querySelector('[data-table-foot]')).toBeNull()
  })

  it('is absent once every page is loaded — no `end`', () => {
    mount({ page: paging({ hasMore: false }) })
    expect(document.querySelector('[data-table-foot]')).toBeNull()
    expect(document.body.textContent).not.toContain('end')
  })

  it('shows while paging: loaded of total, and Load 50 more', () => {
    let asked = 0
    mount({ page: paging({ onLoadMore: () => asked++ }) })
    const foot = one('[data-table-foot]')
    expect(foot.textContent).toContain('2 of 120')
    const more = [...foot.querySelectorAll('button')].find(
      (b) => b.textContent === 'Load 50 more',
    )
    if (!more) throw new Error('no Load 50 more')
    act(() => more.click())
    expect(asked).toBe(1)
  })

  it('reads Loading… while the next page is in flight', () => {
    mount({ page: paging({ loading: true }) })
    expect(one('[data-table-foot]').textContent).toContain('Loading…')
  })
})

describe('the body states', () => {
  it('loading: a Twinkle row naming the list, in place of the rows', () => {
    mount({ notice: <ListLoadingRow plural="Companies" />, rows: [] })
    const row = one('[data-list-state="loading"]')
    expect(row.textContent).toBe('Loading companies')
    expect(row.querySelector('[data-twinkle]')).not.toBeNull()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0)
  })

  it('error: a destructive square, what failed, and Retry', () => {
    let retried = 0
    mount({
      notice: <ListErrorRow plural="Companies" onRetry={() => retried++} />,
    })
    const row = one('[data-list-state="error"]')
    expect(row.querySelector('.bg-destructive')).not.toBeNull()
    expect(row.textContent).toContain(
      'Could not load companies · the database did not answer',
    )
    // The rows give way to the error, and so does the foot.
    expect(document.querySelectorAll('tbody tr')).toHaveLength(0)
    const retry = row.querySelector('button')
    if (!retry) throw new Error('no Retry')
    expect(retry.textContent).toBe('Retry')
    act(() => retry.click())
    expect(retried).toBe(1)
  })

  it('zero results: the sentence, and Clear filter in pine', () => {
    let cleared = 0
    mount({ notice: <ListZeroRow onClear={() => cleared++} />, rows: [] })
    const row = one('[data-list-state="zero"]')
    expect(row.textContent).toBe('Nothing matches that filter.Clear filter')
    const clear = row.querySelector('button')
    if (!clear) throw new Error('no Clear filter')
    expect(classes(clear)).toContain('text-primary')
    act(() => clear.click())
    expect(cleared).toBe(1)
  })

  it('an empty table with no notice says the sentence alone', () => {
    mount({ rows: [] })
    expect(one('[data-list-state="zero"]').textContent).toBe(
      'Nothing matches that filter.',
    )
  })
})

describe('the pinned column', () => {
  it('carries a rule on its right edge, head and body', () => {
    mount()
    const head = [...document.querySelectorAll('thead th')].find((h) =>
      h.textContent.includes('Company'),
    )
    const cell = document.querySelector('tbody td')
    for (const el of [head, cell]) {
      if (!el) throw new Error('no pinned cell')
      expect(classes(el)).toEqual(
        expect.arrayContaining(['sticky', 'after:bg-rule', 'after:right-0']),
      )
    }
  })
})
