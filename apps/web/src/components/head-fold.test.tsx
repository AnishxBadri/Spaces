import { Window } from 'happy-dom'
import { act } from 'react'
import type { ReactNode } from 'react'
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

import { useHotkey } from '#/lib/use-hotkey'

import { PageHeader } from './page-header'
import { RecordHeader } from './record/record-parts'

/**
 * The sticky head, mounted the way a route mounts it: the head, then the
 * body. `IntersectionObserver` is absent from the test DOM, so it is stubbed
 * and its callback fired by hand — the title leaving and coming back.
 *
 * The DOM is a happy-dom `Window` on this file's globals, as in
 * `use-hotkey.test.tsx`, so the per-file database setup stays on node.
 */

type Entry = {
  isIntersecting: boolean
  boundingClientRect: { top: number }
  rootBounds: { top: number } | null
}

class StubObserver {
  static last: StubObserver | null = null
  readonly observed: Array<Element> = []
  constructor(
    readonly callback: (entries: Array<Entry>) => void,
    readonly options: { rootMargin?: string },
  ) {
    StubObserver.last = this
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  disconnect() {
    this.observed.length = 0
  }
}

const win = new Window()
let createRoot: typeof CreateRoot

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('IntersectionObserver', StubObserver)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

const logged = vi.fn()

/** A head action that owns its hotkey, as `LogInteractionDialog` does. */
function LogButton() {
  useHotkey('l', logged)
  return (
    <button type="button">
      Log interaction<kbd>L</kbd>
    </button>
  )
}

let root: Root

function mount(node: ReactNode) {
  act(() => root.render(node))
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) throw new Error(`no ${selector}`)
  return el
}

/** The title scrolling out (`false`) or back in (`true`). */
function titleVisible(visible: boolean) {
  const observer = StubObserver.last
  if (!observer) throw new Error('no observer')
  act(() =>
    observer.callback([
      {
        isIntersecting: visible,
        boundingClientRect: { top: visible ? 120 : -160 },
        rootBounds: { top: 48 },
      },
    ]),
  )
}

/** The slot measures 312 × 32 — what a real layout would report. */
function measureSlot() {
  const slot = q('[data-head-actions-slot]')
  slot.getBoundingClientRect = () => new win.DOMRect(900, 20, 312, 32)
  return slot
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
  })
}

/** The head's markup with the two things a fold may change stripped out. */
function headStill(): string {
  return q('header')
    .outerHTML.replace(/ data-folded="(true|false)"/g, '')
    .replace(/ style="[^"]*"/g, '')
}

const record = (
  <div className="flex min-h-full flex-col">
    <RecordHeader
      stamp={{ kind: 'Company', fact: '3f2a9c1b' }}
      crumb="Companies"
      name="Flent"
      actions={<LogButton />}
      readouts={[{ label: 'Last contact', value: '3d' }]}
    />
    <main data-body>Interactions</main>
  </div>
)

beforeEach(() => {
  logged.mockReset()
  StubObserver.last = null
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('the folded head', () => {
  it('watches the title, under the mobile bar’s line', () => {
    mount(record)
    expect(StubObserver.last?.observed).toEqual([q('h1')])
    expect(StubObserver.last?.options.rootMargin).toBe('-48px 0px 0px 0px')
  })

  it('shows the 40px bar when the title scrolls out and hides it when it returns', () => {
    mount(record)
    const bar = q('[data-head-bar]')
    expect(bar.dataset.folded).toBe('false')
    measureSlot()

    titleVisible(false)
    expect(bar.dataset.folded).toBe('true')
    expect(bar.className.split(' ')).toContain('h-10')
    expect(bar.textContent).toContain('Flent')
    expect(bar.querySelector('[data-stamp="live"]')).not.toBeNull()

    titleVisible(true)
    expect(bar.dataset.folded).toBe('false')
  })

  it('moves nothing below it: the body keeps its offset and the head its box', () => {
    mount(record)
    const body = q('[data-body]')
    const offset = body.offsetTop
    const head = headStill()
    const slot = measureSlot()

    titleVisible(false)
    // The bar hangs from a zero-height sticky anchor and is out of flow.
    const anchor = q('[data-head-anchor]').className.split(' ')
    expect(anchor).toEqual(expect.arrayContaining(['sticky', 'h-0']))
    expect(q('[data-head-bar]').className.split(' ')).toContain('absolute')
    // The lifted actions leave their slot holding the size they had.
    expect(slot.style.width).toBe('312px')
    expect(slot.style.height).toBe('32px')
    expect(headStill()).toBe(head)
    expect(q('[data-body]')).toBe(body)
    expect(body.offsetTop).toBe(offset)
    expect(body.previousElementSibling).toBe(q('header'))

    titleVisible(true)
    expect(slot.getAttribute('style')).toBeNull()
    expect(headStill()).toBe(head)
    expect(body.offsetTop).toBe(offset)
  })

  it('carries the head’s own actions: one element, one hotkey binding', () => {
    mount(record)
    measureSlot()
    const actions = q('[data-head-actions]')
    titleVisible(false)

    expect(q('[data-head-actions]')).toBe(actions)
    expect(actions.dataset.folded).toBe('true')
    expect(q('header').contains(actions)).toBe(true)
    expect(q('[data-head-bar]').querySelector('button')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(1)
    // Lifted into the bar's right lane: fixed, 40px, on the sticky layer.
    expect(actions.className).toContain('data-[folded=true]:fixed')
    expect(actions.className).toContain('data-[folded=true]:h-10')
    expect(actions.className).toContain('data-[folded=true]:z-sticky')

    press('l')
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('pins a page head’s tabs under the folded bar, never into it', () => {
    mount(
      <div className="flex min-h-full flex-col">
        <PageHeader
          title="Review"
          action={<LogButton />}
          tabs={<button type="button">All 4</button>}
        />
        <main data-body>Cards</main>
      </div>,
    )
    measureSlot()
    titleVisible(false)
    const tabs = q('[data-head-tabs]')
    // A row of its own after the head, not inside the lifted actions.
    expect(q('header').contains(tabs)).toBe(false)
    expect(q('[data-head-actions]').contains(tabs)).toBe(false)
    expect(tabs.previousElementSibling).toBe(q('header'))
    // The bar is 40px from the top; the row sticks at exactly its foot.
    expect(q('[data-head-bar]').className.split(' ')).toContain('h-10')
    expect(tabs.className.split(' ')).toEqual(
      expect.arrayContaining(['sticky', 'md:top-10', 'top-22', 'z-sticky']),
    )
  })

  it('animates transform and opacity only, and not at all under reduced motion', () => {
    mount(record)
    const bar = q('[data-head-bar]').className.split(' ')
    expect(bar).toContain('transition-[transform,opacity]')
    expect(bar).toContain('motion-reduce:transition-none')
    expect(bar).toEqual(
      expect.arrayContaining([
        'duration-[120ms]',
        'data-[folded=true]:duration-[180ms]',
      ]),
    )
    const folding = bar
      .filter((c) => c.startsWith('data-[folded=true]:'))
      .map((c) => c.slice('data-[folded=true]:'.length))
    for (const c of folding) {
      expect(c).toMatch(/^(translate-|opacity-|duration-|pointer-events-)/)
    }
    expect(bar).not.toContain('transition-all')
    const actions = q('[data-head-actions]').className.split(' ')
    expect(actions).toContain('motion-reduce:animate-none')
  })

  it('is the bar of every page head too, with no stamp of its own', () => {
    mount(
      <div className="flex min-h-full flex-col">
        <PageHeader title="Companies" action={<LogButton />} />
        <main data-body>Rows</main>
      </div>,
    )
    measureSlot()
    titleVisible(false)
    const bar = q('[data-head-bar]')
    expect(bar.dataset.folded).toBe('true')
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(bar.textContent).toBe('Companies')
    expect(bar.querySelector('[data-stamp]')).toBeNull()
    press('l')
    expect(logged).toHaveBeenCalledTimes(1)
  })
})
