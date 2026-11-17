import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import type { SortingState } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { RecordTable, TableToolbar } from './record-table'
import type { TablePage } from './record-table'
import { ListErrorRow, ListLoadingRow, ListZeroRow } from './list-states'
import { classCss, declared } from '#/test/tailwind-css'

/**
 * The record table as a fixed pane: its card is the one scroller, the column
 * head holds its top, the foot its bottom, the name column its left and the
 * trailing lane its right; every cell is bounded to the 36px row; a figures
 * column right-aligns its head. A shelf's bar is real tabs with the tools
 * right, the search box on the card's edge.
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
  rowEnd,
  named,
  sorting,
}: {
  page?: TablePage
  notice?: ReactNode
  rows?: Array<Row>
  rowEnd?: (row: Row) => ReactNode
  /** What on the page names the table: its title, and the open tab too. */
  named?: 'title' | 'title and tab'
  sorting?: SortingState
} = {}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(sorting ? { initialState: { sorting } } : {}),
  })
  return (
    <>
      {named === undefined ? null : <h1 id="list-title">Holdings</h1>}
      <TableToolbar
        {...(named === 'title and tab' ? { labelId: 'list-view' } : {})}
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
        {...(named === 'title'
          ? { labelledBy: ['list-title'] }
          : named === 'title and tab'
            ? { labelledBy: ['list-title', 'list-view'] }
            : {})}
        {...(page ? { page } : {})}
        {...(rowEnd ? { rowEnd } : {})}
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

describe('the pane', () => {
  it('is a card that takes what the page leaves it, one scroller both ways inside', () => {
    mount()
    const box = one('[data-table-box]')
    expect(classes(box)).toEqual(
      expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'min-h-0']),
    )
    const scroller = one('[data-table-scroller]')
    expect(classes(scroller)).toEqual(
      expect.arrayContaining(['overflow-auto', 'flex-1', 'min-h-0']),
    )
    // One table: the head and the rows scroll in the same box.
    expect(box.querySelectorAll('table')).toHaveLength(1)
    expect(scroller.contains(one('[data-table-head]'))).toBe(true)
  })

  it('holds the column head at the card’s top, opaque over the rows', () => {
    mount()
    const heads = [...document.querySelectorAll('thead th')]
    expect(heads.length).toBeGreaterThan(0)
    for (const th of heads)
      expect(classes(th)).toEqual(
        expect.arrayContaining(['sticky', 'top-0', 'bg-paper', 'border-b']),
      )
    // The pinned corner sits over the rest of the head.
    const company = heads.find((h) => h.textContent.includes('Company'))
    if (!company) throw new Error('no Company head')
    expect(classes(company)).toEqual(expect.arrayContaining(['z-30', 'left-0']))
  })

  it('measures how far the head may ride down the rows: the pane less the head', () => {
    // happy-dom lays nothing out, so the two heights are given.
    const client = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(400)
    const offset = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(32)
    try {
      mount()
      expect(
        one('[data-table-scroller]').style.getPropertyValue('--head-travel'),
      ).toBe('368px')
    } finally {
      client.mockRestore()
      offset.mockRestore()
    }
  })

  it('below md, on a list page, carries the head down under the top bar', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../styles.css', import.meta.url)),
      'utf8',
    )
    const block = css.slice(css.indexOf('@keyframes list-head-drop'))
    expect(block).toMatch(/@media \(width < 48rem\)/)
    // A list page only: a record page pins its own bar and tabs there.
    expect(block).toContain(
      "[data-list-page='true']:not([data-pane-from]) [data-table-head] th",
    )
    expect(block).toContain('view-timeline-inset: 3rem 0')
    expect(block).toContain('translate: 0 var(--head-travel, 0px)')
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

  it('is fixed-width, never narrower than the card, each cell keeping its own rules', () => {
    mount()
    const table = one('table[role="table"]')
    expect(table.style.minWidth).toBe('100%')
    expect(classes(table)).toEqual(
      expect.arrayContaining(['table-fixed', 'border-separate']),
    )
    // Separate borders travel with a pinned cell; a row's rule is its cells'.
    expect(classes(one('tbody td'))).toEqual(
      expect.arrayContaining(['border-b', 'border-r']),
    )
  })
})

describe('to a screen reader', () => {
  /** The words an `aria-labelledby` reads, id by id. */
  const nameOf = (el: Element) =>
    (el.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? `#${id}?`)

  it('is named by the page title and the open tab, the tab’s count left out', () => {
    mount({ named: 'title and tab' })
    const grid = one('[role="table"]')
    expect(nameOf(grid)).toEqual(['Holdings', 'All'])
    expect(grid.hasAttribute('aria-label')).toBe(false)
  })

  it('falls back to the title alone with no tabs over it', () => {
    mount({ named: 'title' })
    const grid = one('[role="table"]')
    expect(nameOf(grid)).toEqual(['Holdings'])
    expect(grid.hasAttribute('aria-label')).toBe(false)
  })

  it('keeps its own label when nothing on the page names it', () => {
    mount()
    const grid = one('[role="table"]')
    expect(grid.getAttribute('aria-label')).toBe('Portfolio')
    expect(grid.hasAttribute('aria-labelledby')).toBe(false)
  })

  it('heads each row with its name cell', () => {
    mount()
    const row = one('tbody [role="row"]')
    const headers = [...row.querySelectorAll('[role="rowheader"]')]
    expect(headers.map((h) => h.textContent)).toEqual(['Aarogya'])
    expect(headers[0]?.tagName).toBe('TD')
    expect(
      [...row.querySelectorAll('[role="cell"]')].map((c) => c.textContent),
    ).toEqual(['$120K', ''])
  })

  it('reads the sort on the head, its arrow drawn, not typed', () => {
    mount({ sorting: [{ id: 'name', desc: false }] })
    const head = [...document.querySelectorAll('thead th')].find((h) =>
      h.textContent.includes('Company'),
    )
    if (!head) throw new Error('no Company head')
    expect(head.getAttribute('aria-sort')).toBe('ascending')
    const arrow = head.querySelector('svg[data-icon="arrow--up"]')
    expect(arrow?.getAttribute('aria-hidden')).toBe('true')
    expect(arrow?.getAttribute('fill')).toBe('currentColor')
    expect(arrow?.getAttribute('class')).toBe('size-4 shrink-0')
    expect(head.textContent).not.toMatch(/[↑↓]/)
  })

  it('draws the arrow down for a descending sort', () => {
    mount({ sorting: [{ id: 'invested', desc: true }] })
    const head = [...document.querySelectorAll('thead th')].find((h) =>
      h.textContent.includes('Invested'),
    )
    if (!head) throw new Error('no Invested head')
    expect(head.getAttribute('aria-sort')).toBe('descending')
    expect(head.querySelector('svg[data-icon="arrow--down"]')).not.toBeNull()
  })
})

describe('the trailing lane', () => {
  it('pins a row’s `···` to the card’s right edge, opaque like the name cell', () => {
    mount({ rowEnd: () => <button type="button">···</button> })
    const ends = [...document.querySelectorAll('[data-row-end]')]
    expect(ends).toHaveLength(2)
    for (const end of ends)
      expect(classes(end)).toEqual(
        expect.arrayContaining([
          'sticky',
          'right-0',
          'z-10',
          'bg-paper',
          'group-hover:bg-row-hover',
        ]),
      )
    // Its head is pinned at the same edge, over the rows.
    expect(classes(one('[data-head-end]'))).toEqual(
      expect.arrayContaining(['sticky', 'right-0', 'top-0', 'z-30']),
    )
  })

  it('stays pinned with no row menu, so the head’s Columns lane has a body under it', () => {
    mount()
    expect(classes(one('[data-row-end]'))).toEqual(
      expect.arrayContaining(['sticky', 'right-0']),
    )
    expect(one('[data-row-end]').textContent).toBe('')
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

  it('insets its first lane 11px, head and body, onto the 24px line', () => {
    mount()
    // 12px gutter + 1px frame + 11px = the page's 24px edge.
    expect(classes(one('thead th'))).toContain('first:pl-2.75')
    expect(classes(one('tbody td'))).toContain('first:pl-1.75')
  })
})

describe("a shelf's bar", () => {
  it('is folder tabs on the ground, a divider, Sort as an icon and the search box right', () => {
    mount()
    const bar = one('[data-tab-bar]')
    expect(classes(bar)).toEqual(
      expect.arrayContaining(['h-11', 'before:bg-hairline']),
    )
    expect(classes(bar).filter((c) => c.startsWith('bg-'))).toEqual([])
    expect(bar.querySelector('[data-tab-divider]')).not.toBeNull()
    const tab = one('[role="tab"]')
    expect(tab.textContent).toBe('All2')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    const controls = [...bar.querySelectorAll('button, input')]
      .filter((el) => el.getAttribute('role') !== 'tab')
      .map((el) =>
        el instanceof HTMLInputElement
          ? el.getAttribute('aria-label')
          : (el.getAttribute('aria-label') ?? el.textContent.trim()),
      )
    // The search box ends on the card's right edge: no inset after it.
    expect(classes(one('[data-tab-trail]'))).not.toContain('pr-3')
    // Columns is not on the bar: it ends the column head row.
    expect(controls).toEqual(['Sort', 'Filter holdings'])
    expect(one('thead [data-columns-menu]').getAttribute('aria-label')).toBe(
      'Columns',
    )
    // At rest Sort is a bare icon, its name only in its label.
    expect(one('[data-tool="sort"]').textContent.trim()).toBe('')
    // The tools sit outside the tablist: only tabs are its children.
    expect(one('[role="tablist"]').querySelectorAll('button')).toHaveLength(1)
  })
})

describe('the foot', () => {
  it('holds the card’s bottom, outside the scroller', () => {
    mount()
    const foot = one('[data-table-foot]')
    expect(one('[data-table-scroller]').contains(foot)).toBe(false)
    expect(one('[data-table-box]').lastElementChild).toBe(foot)
    expect(classes(foot)).toContain('shrink-0')
  })

  it('is there on a table that does not page: what shows of what it holds, no Load', () => {
    mount()
    const foot = one('[data-table-foot]')
    expect(foot.textContent).toBe('2 of 2')
    expect(foot.querySelector('button')).toBeNull()
  })

  it('stays once every page is loaded, with no Load and no `end`', () => {
    mount({ page: paging({ hasMore: false }) })
    const foot = one('[data-table-foot]')
    expect(foot.textContent).toBe('2 of 120')
    expect(foot.querySelector('button')).toBeNull()
    expect(document.body.textContent).not.toContain('end')
  })

  it('while paging: loaded of total · Load 50 more, on the left', () => {
    let asked = 0
    mount({ page: paging({ onLoadMore: () => asked++ }) })
    const foot = one('[data-table-foot]')
    expect(foot.textContent).toBe('2 of 120·Load 50 more')
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

  it('stays in place under a loading, error or no-match row, with no count', () => {
    mount({ notice: <ListLoadingRow plural="Companies" />, rows: [] })
    expect(one('[data-table-foot]').textContent).toBe('')
  })

  it('counts the columns past the card’s right edge, and steps to the first', () => {
    mount()
    const scroller = one('[data-table-scroller]')
    const invested = [...document.querySelectorAll('[data-column]')].at(0)
    if (!(invested instanceof HTMLElement)) throw new Error('no column')
    // A 300px card: the name column (240) shows, Invested (240–370) runs
    // under the 56px trailing lane.
    Object.defineProperty(scroller, 'clientWidth', { value: 300 })
    Object.defineProperty(invested, 'offsetLeft', { value: 240 })
    Object.defineProperty(invested, 'offsetWidth', { value: 130 })
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    const more = one('[data-more-columns]')
    expect(more.textContent).toBe('1 more column →')
    expect(document.querySelector('[data-table-fade]')).not.toBeNull()
    act(() => more.click())
    // Invested's left edge lands just after the pinned name column.
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 0 }))
  })

  it('names no hidden columns while every column fits', () => {
    mount()
    expect(document.querySelector('[data-more-columns]')).toBeNull()
    expect(document.querySelector('[data-table-fade]')).toBeNull()
  })

  it('keeps the count and Load on the left beside the hidden columns on the right', () => {
    mount({ page: paging() })
    overflowInvested()
    const foot = one('[data-table-foot]')
    expect(foot.textContent).toBe('2 of 120·Load 50 more1 more column →')
    expect(foot.lastElementChild).toBe(one('[data-more-columns]'))
  })
})

/**
 * A 300px card: the name column (240) shows, Invested (240–370) runs under
 * the 56px trailing lane. Returns the scroller with its `scrollBy` watched.
 */
function overflowInvested() {
  const scroller = one('[data-table-scroller]')
  const invested = [...document.querySelectorAll('[data-column]')].at(0)
  if (!(invested instanceof HTMLElement)) throw new Error('no column')
  Object.defineProperty(scroller, 'clientWidth', { value: 300 })
  Object.defineProperty(invested, 'offsetLeft', { value: 240 })
  Object.defineProperty(invested, 'offsetWidth', { value: 130 })
  const scrollBy = vi.fn()
  scroller.scrollBy = scrollBy
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
  return { scroller, scrollBy }
}

function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init }),
    )
  })
}

describe('the sideways pane', () => {
  it('is one Tab stop, named for the columns past the edge, while they overflow', () => {
    mount()
    const { scroller } = overflowInvested()
    expect(scroller.getAttribute('role')).toBe('group')
    expect(scroller.tabIndex).toBe(0)
    expect(scroller.getAttribute('aria-label')).toBe('Portfolio, 1 more column')
    // The table inside it is still the table.
    expect(scroller.querySelector('table')?.getAttribute('role')).toBe('table')
  })

  it('is no Tab stop and no group while every column fits', () => {
    mount()
    const scroller = one('[data-table-scroller]')
    expect(scroller.hasAttribute('tabindex')).toBe(false)
    expect(scroller.hasAttribute('role')).toBe(false)
    expect(scroller.hasAttribute('aria-label')).toBe(false)
  })

  it('stays a Tab stop once scrolled right, so the keyboard can scroll back', () => {
    mount()
    const scroller = one('[data-table-scroller]')
    // Scrolled to the end: nothing past the edge, but the start is hidden.
    Object.defineProperty(scroller, 'scrollLeft', { value: 120 })
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(scroller.tabIndex).toBe(0)
    expect(scroller.getAttribute('aria-label')).toBe('Portfolio')
    expect(document.querySelector('[data-more-columns]')).toBeNull()
  })

  it('scrolls about one column per ← →', () => {
    mount()
    const { scroller, scrollBy } = overflowInvested()
    press(scroller, 'ArrowRight')
    // Invested, the one column that scrolls, is 130 wide.
    expect(scrollBy).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 130 }),
    )
    press(scroller, 'ArrowLeft')
    expect(scrollBy).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: -130 }),
    )
    expect(scrollBy).toHaveBeenCalledTimes(2)
  })

  it('leaves other keys, chords and a focused control’s arrows alone', () => {
    mount({ rowEnd: () => <button type="button">···</button> })
    const { scroller, scrollBy } = overflowInvested()
    press(scroller, 'ArrowDown')
    press(scroller, 'ArrowRight', { shiftKey: true })
    press(scroller, 'ArrowRight', { metaKey: true })
    press(one('[data-row-end] button'), 'ArrowRight')
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('draws its focus marks on the frame, which does not scroll, over the pinned lanes', async () => {
    mount()
    const scroller = one('[data-table-scroller]')
    expect(scroller.hasAttribute('data-focus-pane')).toBe(true)
    expect(classes(scroller.parentElement ?? scroller)).toContain(
      'focus-ring-pane',
    )
    const [css = ''] = await classCss(['focus-ring-pane'])
    expect(css).toContain(':has(> [data-focus-pane]:focus-visible)::after')
    // Above the head's pinned corners (z-30); an outline in forced colours.
    expect(await declared('focus-ring-pane', 'z-index')).toEqual(['40'])
    expect(await declared('focus-ring-pane', 'outline')).toEqual([
      'none',
      '2px solid',
    ])
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
  it('carries its own rule on its right edge, head and body, opaque over what scrolls', () => {
    mount()
    const head = [...document.querySelectorAll('thead th')].find((h) =>
      h.textContent.includes('Company'),
    )
    const cell = document.querySelector('tbody td')
    for (const el of [head, cell]) {
      if (!el) throw new Error('no pinned cell')
      expect(classes(el)).toEqual(
        expect.arrayContaining([
          'sticky',
          'left-0',
          'border-r',
          'border-rule',
          'bg-paper',
        ]),
      )
    }
  })
})
