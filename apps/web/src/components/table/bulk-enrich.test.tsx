import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useListEnrich } from './bulk-enrich-dialog'
import { RecordTable } from './record-table'

/**
 * Enrich… on a record list: the row checkboxes raise the selection bar, its
 * Enrich… opens the estimate window, Cancel queues nothing and Enrich n
 * sends the checked ids once; the head's `···` estimates the whole view.
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
}))
vi.mock('#/lib/server-fns', () => fns)

type Row = { id: string; name: string }
const ROWS: Array<Row> = Array.from({ length: 3 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${String(i + 1)}`,
  name: `Co ${String(i + 1)}`,
}))

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

function Harness() {
  const enrich = useListEnrich({
    kind: 'company',
    label: 'Companies',
    rows: ROWS,
    view: { conditions: [], q: 'co' },
    refresh,
  })
  const table = useReactTable({
    data: ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <div>
      {enrich.menu}
      {enrich.selectionBar}
      <RecordTable
        table={table}
        label="Companies"
        stickyColumnId="name"
        select={enrich.select}
      />
      {enrich.dialog}
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
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

const mount = async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<Harness />))
  await flush()
}

const text = (el: Element | null) => (el?.textContent ?? '').trim()

const button = (match: RegExp) => {
  const found = [...document.querySelectorAll('button')].find((b) =>
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

describe('the selection bar', () => {
  it('appears with the count once a row is checked, and leaves on clear', async () => {
    await mount()
    expect(bar()).toBeNull()
    await click(labelled('Select Co 1'))
    await click(labelled('Select Co 2'))
    expect(text(bar())).toContain('2 selected')
    await click(button(/^clear$/))
    expect(bar()).toBeNull()
  })

  it('the head box checks every loaded row', async () => {
    await mount()
    await click(labelled('Select every loaded row of Companies'))
    expect(text(bar())).toContain('3 selected')
  })
})

describe('the estimate window', () => {
  it('shows the skips by reason and credits per source; Cancel queues nothing', async () => {
    await mount()
    await click(labelled('Select Co 1'))
    await click(button(/^Enrich…$/))
    expect(fns.estimateBulkEnrich).toHaveBeenCalledWith({
      data: { kind: 'company', target: { ids: [ROWS[0]?.id] } },
    })
    const summary = document.querySelector('[data-estimate-summary]')
    expect(text(summary)).toBe(
      '34 to ask · 6 skipped · about 34 Apollo credits of 100 left today',
    )
    const body = text(dialog())
    expect(body).toContain(
      'skipped · 2 sensitive · 2 enriched in the last 90 days · 2 no domain',
    )
    expect(body).toContain('free')
    expect(body).toContain('about 34 credits of 100 left today')
    await click(button(/^Cancel$/))
    expect(dialog()).toBeNull()
    expect(fns.bulkEnrich).not.toHaveBeenCalled()
  })

  it('Enrich n sends the checked ids once, clears the selection and refreshes', async () => {
    await mount()
    await click(labelled('Select Co 1'))
    await click(labelled('Select Co 3'))
    await click(button(/^Enrich…$/))
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
    await click(button(/^Enrich…$/))
    expect(text(document.querySelector('[data-estimate-parks]'))).toBe(
      '6 park until 00:00 UTC · Apollo’s daily cap',
    )
  })

  it('the head ··· estimates the list as its view shows it', async () => {
    await mount()
    const trigger = labelled('More for Companies')
    if (!(trigger instanceof HTMLElement)) throw new Error('no trigger')
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => text(el) === 'Enrich…',
    )
    if (!(item instanceof HTMLElement)) throw new Error('no Enrich…')
    await act(async () => item.click())
    await flush()
    await flush()
    expect(fns.estimateBulkEnrich).toHaveBeenCalledWith({
      data: { kind: 'company', target: { conditions: [], q: 'co' } },
    })
    expect(dialog()).not.toBeNull()
  })
})
