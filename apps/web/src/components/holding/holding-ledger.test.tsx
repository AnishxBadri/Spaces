import { act, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClockProvider } from '#/components/clock'

import { EventSection, HoldingFigures } from './holding-ledger'
import type { EventRow } from './holding-ledger'

/**
 * The holding's ledgers and figures row: Void lives in a row's `···` and
 * nowhere else, a voided original is struck with its compensating row
 * indented beneath it, and every figure prints whole. Mounted in a happy-dom
 * `Window` on this file's globals.
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
  voidLedgerEvent: vi.fn(async () => ({ id: 'rev' })),
  invalidate: vi.fn(async () => {}),
}))

vi.mock('#/lib/server-fns', () => ({ voidLedgerEvent: fns.voidLedgerEvent }))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: fns.invalidate }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(() => {}, {}) }))

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  fns.voidLedgerEvent.mockClear()
})

async function flush() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <ClockProvider now="2026-10-26T12:00:00.000Z">{node}</ClockProvider>,
    ),
  )
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').trim()

const row = (over: Partial<EventRow> & Pick<EventRow, 'id'>): EventRow => ({
  date: '2026-03-10',
  label: 'SAFE · Northgate Fund II',
  amount: '$1,000,000',
  detail: 'cap $12M',
  reversedAt: null,
  reversesId: null,
  voidedBy: null,
  voidedOn: null,
  ...over,
})

describe('a check ledger', () => {
  const rows = [
    row({ id: 'a' }),
    row({ id: 'b', reversedAt: '2026-10-14T09:00:00.000Z', label: 'Priced' }),
    row({
      id: 'b-rev',
      amount: '-$1,000,000',
      reversesId: 'b',
      voidedBy: 'Anish',
      voidedOn: '2026-10-14',
    }),
  ]

  it('prints the day, the entry, its detail and the amount, and no void word', () => {
    mount(<EventSection title="Checks" table="investment" rows={rows} />)
    const first = document.querySelector('#event-a')
    expect(text(first)).toBe(
      '10 MarSAFE · Northgate Fund IIcap $12M$1,000,000···',
    )
    expect(document.body.textContent).not.toMatch(/\bvoid\b/)
    // The count is of live entries: the voided pair is not one.
    expect(text(document.querySelector('[data-section-count]'))).toBe('1')
  })

  it('strikes a voided original and indents its compensating row under it', () => {
    mount(<EventSection title="Checks" table="investment" rows={rows} />)
    const struck = document.querySelector('#event-b')
    expect(struck?.querySelector('.line-through')).not.toBeNull()
    // A voided original has nothing left to void.
    expect(struck?.querySelector('[aria-label^="More for"]')).toBeNull()
    const reversal = document.querySelector('[data-reversal]')
    expect(reversal?.previousElementSibling).toBe(struck)
    expect(text(reversal)).toBe(
      'Voided by Anish · 14 Octcompensating entry-$1,000,000',
    )
  })

  it('voids from the row ···, through the unchanged confirm', async () => {
    mount(<EventSection title="Checks" table="investment" rows={rows} />)
    const trigger = document.querySelector(
      '#event-a [aria-label="More for SAFE · Northgate Fund II"]',
    )
    expect(trigger).not.toBeNull()
    act(() => {
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await flush()
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    expect(items.map((el) => text(el))).toEqual(['Copy link', 'Void…'])
    const voidItem = items.at(1)
    if (!(voidItem instanceof HTMLElement)) throw new Error('no Void…')
    act(() => voidItem.click())
    await flush()
    const dialog = document.querySelector(
      '[role="alertdialog"], [role="dialog"]',
    )
    expect(text(dialog)).toContain('Void this check?')
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (b) => text(b) === 'Void',
    )
    await act(async () => confirm?.click())
    await flush()
    expect(fns.voidLedgerEvent).toHaveBeenCalledWith({
      data: { table: 'investment', id: 'a' },
    })
  })

  it('offers no ··· on Rounds, which cannot be voided', () => {
    mount(<EventSection title="Rounds" rows={[row({ id: 'r' })]} />)
    expect(document.querySelector('[aria-label^="More for"]')).toBeNull()
  })

  it('is its empty row, or nothing, with no entries', () => {
    mount(
      <>
        <EventSection title="Marks" table="mark" rows={[]} />
        <EventSection
          title="Rounds"
          rows={[]}
          empty={<button type="button">Rounds+</button>}
        />
      </>,
    )
    expect(document.querySelectorAll('section')).toHaveLength(0)
    expect(text(document.body)).toBe('Rounds+')
  })
})

describe('the figures row', () => {
  it('prints each figure whole, and the as-of day as an outline control', () => {
    mount(
      <HoldingFigures
        figures={[
          { label: 'Invested', value: '$1,000,000' },
          { label: 'Value · marked 30 Aug', value: '$1,900,000' },
        ]}
        asOf="2026-09-30"
        onAsOf={() => {}}
      />,
    )
    const values = Array.from(
      document.querySelectorAll('[data-figure] > span:first-child'),
    )
    expect(values.map((v) => text(v))).toEqual(['$1,000,000', '$1,900,000'])
    for (const v of values) {
      expect(v.className).toContain('whitespace-nowrap')
      expect(v.className).not.toContain('truncate')
    }
    const control = document.querySelector('[data-as-of]')
    expect(text(control)).toBe('As of 30 Sep')
    expect(control?.getAttribute('data-variant')).toBe('outline')
  })

  it('hands a chosen day up, and today as no day', () => {
    const chosen: Array<string | null> = []
    function Page() {
      const [asOf, setAsOf] = useState<string | null>(null)
      return (
        <HoldingFigures
          figures={[]}
          asOf={asOf}
          onAsOf={(d) => {
            chosen.push(d)
            setAsOf(d)
          }}
        />
      )
    }
    mount(<Page />)
    const field = document.querySelector('input[type="date"]')
    if (!(field instanceof HTMLInputElement)) throw new Error('no field')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    for (const day of ['2026-06-30', '2026-10-26']) {
      act(() => {
        setter?.call(field, day)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(chosen).toEqual(['2026-06-30', null])
  })
})
