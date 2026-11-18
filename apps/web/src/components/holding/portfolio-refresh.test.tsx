import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClockProvider } from '#/components/clock'
import { PINNED_VIEWS_QUERY } from '#/lib/chassis-prefs'
import { portfolioKeys, portfolioQueries } from '#/lib/page-queries'

import { EventSection } from './holding-ledger'
import { useEventForm } from './record-check-dialog'

/**
 * A Portfolio write refreshes the Portfolio keys and nothing else: with the
 * list, a holding and the sidebar's pinned views all on screen, a check
 * (through the event form) and a void each refetch the list and the
 * holding, and the sidebar's read is neither refetched nor marked stale.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/portfolio/h1' })
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
  listHoldings: vi.fn(async () => ({ holdings: [] })),
  getHolding: vi.fn(async () => ({ id: 'h1' })),
  voidLedgerEvent: vi.fn(async () => ({ id: 'rev' })),
  listPinnedViews: vi.fn(async () => []),
}))

vi.mock('#/lib/server-fns', () => ({
  listHoldings: fns.listHoldings,
  getHolding: fns.getHolding,
  voidLedgerEvent: fns.voidLedgerEvent,
}))
vi.mock('sonner', () => ({ toast: Object.assign(() => {}, {}) }))

const HOLDING = '00000000-0000-4000-8000-0000000000a1'
const SIDEBAR_KEY = [PINNED_VIEWS_QUERY, ['v1']]

let root: Root | null = null
let client: QueryClient

beforeEach(() => {
  client = new QueryClient()
  for (const fn of Object.values(fns)) fn.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  client.clear()
  document.body.replaceChildren()
})

async function flush() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

/** The reads a holding page has on screen: its own, the list's, the sidebar's. */
function OnScreen() {
  useQuery(portfolioQueries.list())
  useQuery(portfolioQueries.holding(HOLDING))
  useQuery({ queryKey: SIDEBAR_KEY, queryFn: fns.listPinnedViews })
  return null
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <ClockProvider now="2026-10-26T12:00:00.000Z">
          <OnScreen />
          {node}
        </ClockProvider>
      </QueryClientProvider>,
    ),
  )
  await flush()
  // Each read once, before any write.
  expect(fns.listHoldings).toHaveBeenCalledTimes(1)
  expect(fns.getHolding).toHaveBeenCalledTimes(1)
  expect(fns.listPinnedViews).toHaveBeenCalledTimes(1)
}

function expectOnlyPortfolioRefetched() {
  expect(fns.listHoldings).toHaveBeenCalledTimes(2)
  expect(fns.getHolding).toHaveBeenCalledTimes(2)
  expect(fns.getHolding).toHaveBeenLastCalledWith({ data: { id: HOLDING } })
  expect(fns.listPinnedViews).toHaveBeenCalledTimes(1)
  expect(client.getQueryState(SIDEBAR_KEY)?.isInvalidated).toBe(false)
}

describe('a Portfolio write', () => {
  it('builds its keys under the one Portfolio prefix', () => {
    expect(portfolioKeys.list()).toEqual(['portfolio', 'list'])
    expect(portfolioKeys.holding(HOLDING)).toEqual([
      'portfolio',
      'holding',
      HOLDING,
      null,
    ])
    expect(portfolioKeys.holding(HOLDING, '2026-06-30').at(3)).toBe(
      '2026-06-30',
    )
    for (const key of [portfolioKeys.list(), portfolioKeys.holding(HOLDING)])
      expect(key.at(0)).toBe(portfolioKeys.all().at(0))
  })

  it('a check through the event form refetches the list and the holding, not the sidebar', async () => {
    const write = vi.fn(async () => ({ ok: true }))
    const saved = vi.fn()
    function Form() {
      const f = useEventForm(undefined, saved)
      return (
        <button type="button" onClick={() => void f.run(write, 'Saved')}>
          Save
        </button>
      )
    }
    await mount(<Form />)
    const save = document.querySelector('button')
    await act(async () => save?.click())
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
    expectOnlyPortfolioRefetched()
  })

  it('a failed write refreshes nothing', async () => {
    function Form() {
      const f = useEventForm()
      return (
        <button
          type="button"
          onClick={() =>
            void f.run(() => Promise.reject(new Error('no')), 'Saved')
          }
        >
          Save
        </button>
      )
    }
    await mount(<Form />)
    await act(async () => document.querySelector('button')?.click())
    await flush()
    expect(fns.listHoldings).toHaveBeenCalledTimes(1)
    expect(fns.getHolding).toHaveBeenCalledTimes(1)
  })

  it('a void refetches the list and the holding, not the sidebar', async () => {
    await mount(
      <EventSection
        title="Checks"
        table="investment"
        rows={[
          {
            id: 'a',
            date: '2026-03-10',
            label: 'Priced',
            amount: '$1,000,000',
            detail: '',
            reversedAt: null,
            reversesId: null,
            voidedBy: null,
            voidedOn: null,
          },
        ]}
      />,
    )
    act(() => {
      document
        .querySelector('#event-a [aria-label="More for Priced"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
    })
    await flush()
    const voidItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent.trim() === 'Void…')
    if (!(voidItem instanceof HTMLElement)) throw new Error('no Void…')
    act(() => voidItem.click())
    await flush()
    const confirm = Array.from(
      document.querySelectorAll(
        '[role="alertdialog"] button, [role="dialog"] button',
      ),
    ).find((b) => b.textContent.trim() === 'Void')
    if (!(confirm instanceof HTMLElement)) throw new Error('no Void')
    await act(async () => confirm.click())
    await flush()
    expect(fns.voidLedgerEvent).toHaveBeenCalledWith({
      data: { table: 'investment', id: 'a' },
    })
    expectOnlyPortfolioRefetched()
  })
})
