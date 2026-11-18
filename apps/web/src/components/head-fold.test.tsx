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
import { SettingsSection } from './settings/settings-section'

/**
 * The sticky head, mounted the way a route mounts it: the head, then the
 * body. `IntersectionObserver` is absent from the test DOM, so it is stubbed
 * and its callback fired by hand — the title leaving and coming back.
 *
 * The DOM is a happy-dom `Window` on this file's globals, so the per-file
 * database setup stays on node.
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

/** `ResizeObserver`, fired by hand: the pane's width changing. */
class StubResize {
  static last: StubResize | null = null
  readonly observed: Array<Element> = []
  constructor(readonly callback: () => void) {
    StubResize.last = this
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
  vi.stubGlobal('ResizeObserver', StubResize)
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
  return <button type="button">Log interaction</button>
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

/** The viewport's width without its scrollbar, as a layout reports it. */
function viewportWidth(px: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => px,
  })
}

/**
 * The slot measures 312 × 32 and ends 24px from the viewport's right edge —
 * what a real layout would report.
 */
function measureSlot() {
  viewportWidth(1236)
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
      stamp={{ kind: 'Company' }}
      mark={<span data-mark>F</span>}
      name="Flent"
      actions={<LogButton />}
    />
    <main data-body>Interactions</main>
  </div>
)

beforeEach(() => {
  logged.mockReset()
  StubObserver.last = null
  StubResize.last = null
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

  it('shows the 48px bar when the title scrolls out and hides it when it returns', () => {
    mount(record)
    const bar = q('[data-head-bar]')
    expect(bar.dataset.folded).toBe('false')
    measureSlot()

    titleVisible(false)
    expect(bar.dataset.folded).toBe('true')
    expect(bar.className.split(' ')).toEqual(
      expect.arrayContaining(['h-12', 'px-6']),
    )
    expect(bar.textContent).toContain('Flent')
    // The record's mark at 16px in a hairline box, inert; never the stamp.
    expect(bar.querySelector('[data-stamp]')).toBeNull()
    const box = bar.querySelector('[data-head-bar-mark]')
    expect(box?.hasAttribute('inert')).toBe(true)
    expect(box?.className.split(' ')).toEqual(
      expect.arrayContaining(['size-4', 'border', 'border-hairline']),
    )
    expect(box?.querySelector('[data-mark]')?.textContent).toBe('F')
    // The title in serif at the title step.
    expect(bar.querySelector('.font-serif')?.className.split(' ')).toContain(
      'text-title',
    )

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
    // Lifted into the bar's right lane: fixed, 48px, on the sticky layer.
    expect(actions.className).toContain('data-[folded=true]:fixed')
    expect(actions.className).toContain('data-[folded=true]:h-12')
    expect(actions.className).toContain('data-[folded=true]:z-sticky')
    // Its right edge where the slot's was: 24px in on a record.
    expect(actions.style.right).toBe('24px')
    expect(q('[data-head-bar]').style.paddingRight).toBe(
      'calc(0.75rem + 336px)',
    )
    // Folded, every action steps down to 26px.
    expect(actions.className).toContain(
      'data-[folded=true]:[&_[data-slot=button]]:h-6.5',
    )

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
    // The bar is 48px from the top; the row sticks at exactly its foot.
    expect(q('[data-head-bar]').className.split(' ')).toContain('h-12')
    expect(tabs.className.split(' ')).toEqual(
      expect.arrayContaining(['sticky', 'md:top-12', 'top-24', 'z-sticky']),
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

  it('never folds a list page’s head: no bar, no watched title, the actions in place', () => {
    mount(
      <div className="flex min-h-full flex-col">
        <PageHeader title="Companies" folds={false} action={<LogButton />} />
        <main data-body>Rows</main>
      </div>,
    )
    expect(document.querySelector('[data-head-bar]')).toBeNull()
    // The observer has nothing to watch, so nothing can fold the head.
    expect(StubObserver.last).toBeNull()
    expect(q('[data-head-actions]').dataset.folded).toBe('false')
    press('l')
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

/**
 * A settings page's head, laid out as a browser lays it: a pane beside a
 * 240px sidebar, the head's right padding `SETTINGS_HEAD_CAP`'s
 * `max(24px, 100% − 800px)`, the 800px column 12px in from the pane with its
 * content ending 12px inside its right edge (the card's 1px rule, its 11px
 * inset). The test DOM lays nothing out, so each box reports that geometry.
 */
describe('a settings head, folded', () => {
  const SIDEBAR = 240
  const VIEWPORT = 1440

  function layOut(paneWidth: number) {
    viewportWidth(VIEWPORT)
    const paneRight = SIDEBAR + paneWidth
    const slotRight = paneRight - Math.max(24, paneWidth - 800)
    const slot = q('[data-head-actions-slot]')
    slot.getBoundingClientRect = () =>
      new win.DOMRect(slotRight - 120, 28, 120, 32)
    const column = q('[data-settings-body]')
    const columnWidth = Math.min(800, paneWidth - 24)
    column.getBoundingClientRect = () =>
      new win.DOMRect(SIDEBAR + 12, 116, columnWidth, 600)
  }

  /** Where the column's content ends: inside the card's rule and inset. */
  const columnEnd = () =>
    q('[data-settings-body]').getBoundingClientRect().right - 1 - 11

  /** The last action's right edge: the fixed row ends where its last child does. */
  function lastActionEnd() {
    const actions = q('[data-head-actions]')
    // The section's fieldset is the row's last child, the action its last.
    expect(actions.lastElementChild?.lastElementChild?.textContent).toBe(
      'Add rate',
    )
    return VIEWPORT - Number.parseFloat(actions.style.right)
  }

  const page = (
    <SettingsSection
      title="Currency & FX"
      action={
        <>
          <button type="button">Import</button>
          <button type="button">Add rate</button>
        </>
      }
    >
      <p>Rates</p>
    </SettingsSection>
  )

  it('ends the last action where the 800px column ends, as it does unfolded', () => {
    mount(page)
    layOut(1200)
    titleVisible(false)
    expect(q('[data-head-actions]').dataset.folded).toBe('true')
    expect(lastActionEnd()).toBe(columnEnd())
    expect(lastActionEnd()).toBe(SIDEBAR + 800)
  })

  it('keeps the 24px edge on a pane narrower than the column and its edge', () => {
    mount(page)
    layOut(700)
    titleVisible(false)
    expect(lastActionEnd()).toBe(SIDEBAR + 700 - 24)
    expect(lastActionEnd()).toBe(columnEnd())
  })

  it('follows the column when the pane’s width changes while folded', () => {
    mount(page)
    layOut(1200)
    titleVisible(false)
    expect(StubResize.last?.observed).toEqual([q('header')])

    layOut(1000)
    act(() => StubResize.last?.callback())
    expect(lastActionEnd()).toBe(columnEnd())
    expect(lastActionEnd()).toBe(SIDEBAR + 800)
  })
})

/**
 * The window's width against `xl`, as `matchMedia` answers it; the returned
 * function resizes across the line and tells the listeners.
 */
function viewAt(wide: boolean) {
  const listeners = new Set<() => void>()
  const state = { matches: wide }
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return state.matches
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }),
  })
  return (next: boolean) =>
    act(() => {
      state.matches = next
      for (const l of listeners) l()
    })
}

const pane = (
  <div className="flex flex-col">
    <RecordHeader
      pane
      stamp={{ kind: 'Company' }}
      name="Flent"
      actions={<LogButton />}
    />
    <main data-body>Overview</main>
  </div>
)

describe('a record in its fixed pane', () => {
  afterEach(() => {
    Reflect.deleteProperty(win, 'matchMedia')
  })

  it('never folds at xl: no bar, no watched title, the actions in place', () => {
    viewAt(true)
    mount(pane)
    expect(document.querySelector('[data-head-bar]')).toBeNull()
    expect(StubObserver.last).toBeNull()
    expect(q('[data-head-actions]').dataset.folded).toBe('false')
    press('l')
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('folds below xl, where the page scrolls as one, and unfolds on widening', () => {
    const resize = viewAt(false)
    mount(pane)
    measureSlot()
    titleVisible(false)
    expect(q('[data-head-bar]').dataset.folded).toBe('true')
    expect(q('[data-head-actions]').dataset.folded).toBe('true')

    resize(true)
    expect(document.querySelector('[data-head-bar]')).toBeNull()
    expect(q('[data-head-actions]').dataset.folded).toBe('false')
    expect(q('[data-head-actions-slot]').getAttribute('style')).toBeNull()
  })
})
