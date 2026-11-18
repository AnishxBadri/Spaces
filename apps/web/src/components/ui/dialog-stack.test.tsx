import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type * as LedgerModule from '../ledger-section'
import type * as ConfirmModule from './confirm-dialog'
import type * as DialogModule from './dialog'

/**
 * Windows stack one deep: a window opened from a window steps down 56px
 * under its parent's top over a lighter scrim of its own, Esc closes the top
 * one only, and a third is refused. Mounted in happy-dom, through Radix.
 */

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let ui: typeof DialogModule
let confirm: typeof ConfirmModule
let ledger: typeof LedgerModule

/** Where the parent window's sheet sits, as its rect reports it. */
const PARENT_TOP = 120

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  for (const name of [
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'FocusEvent',
  ])
    vi.stubGlobal(name, Reflect.get(win, name))
  // Radix's focus scope and portal reach for the DOM's classes.
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      vi.stubGlobal(name, Reflect.get(win, name))
  vi.stubGlobal('getComputedStyle', win.getComputedStyle.bind(win))
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const rect = win.HTMLElement.prototype.getBoundingClientRect
  win.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
    const box = rect.call(this)
    return this.getAttribute('data-window-depth') === '1'
      ? new win.DOMRect(box.x, PARENT_TOP, box.width, box.height)
      : box
  }
  ;({ createRoot } = await import('react-dom/client'))
  ui = await import('./dialog')
  confirm = await import('./confirm-dialog')
  ledger = await import('../ledger-section')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let mounted: { root: Root; host: HTMLElement } | null = null

afterEach(async () => {
  if (mounted === null) return
  const { root, host } = mounted
  act(() => root.unmount())
  host.remove()
  mounted = null
  // Radix's focus scope hands focus back on a timer; let it run here.
  await new Promise((resolve) => setTimeout(resolve, 10))
})

function mount(node: ReactNode, onUncaughtError?: (error: unknown) => void) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(
    host,
    onUncaughtError === undefined ? {} : { onUncaughtError },
  )
  mounted = { root, host }
  act(() => root.render(node))
}

function Sheet({
  title,
  size,
  onOpenChange,
  children,
}: {
  title: string
  size: DialogModule.WindowSize
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}) {
  const { Dialog, DialogContent, DialogTitle } = ui
  return (
    <Dialog open {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      <DialogContent size={size} aria-describedby={undefined}>
        <DialogTitle>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}

const sheets = () =>
  [...document.querySelectorAll('[data-slot="dialog-content"]')].filter(
    (el): el is HTMLElement => el instanceof win.HTMLElement,
  )
const overlays = () =>
  [...document.querySelectorAll('[data-slot="dialog-overlay"]')].map(
    (el) => el.className,
  )

/** A window holding whatever head, body and foot the test hands it. */
function Frame({
  size,
  children,
}: {
  size: DialogModule.WindowSize
  children: ReactNode
}) {
  const { Dialog, DialogContent } = ui
  return (
    <Dialog open>
      <DialogContent size={size} aria-describedby={undefined}>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/*
 * happy-dom lays nothing out, so a left offset is read the way the browser
 * would compute it from the classes that decide it: each box's left margin,
 * and the left padding and border of every box it sits in, with `--inset`
 * taken from the stylesheet rule that sets it where the box stands.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const css = readFileSync(join(SRC, 'styles.css'), 'utf8')

function remPx(pattern: RegExp): number {
  const m = pattern.exec(css)
  if (m === null) throw new Error(`no rule ${String(pattern)}`)
  return Number(m[1]) * 16
}

const WINDOW_INSET = remPx(
  /\[data-slot='dialog-content'\] \{\s*--inset: ([\d.]+)rem/,
)
const FLUSH_INSET = remPx(
  /\[data-slot='dialog-content'\]\[data-flush\] \{\s*--inset: ([\d.]+)rem/,
)
const BLEED_INSET = remPx(/@utility window-bleed \{[^}]*--inset: ([\d.]+)rem/)
const BLEED_MARGIN = remPx(
  /@utility window-bleed \{[^}]*margin-inline: -([\d.]+)rem/,
)

/** The `--inset` a box sees: the nearest rule that sets it. */
function insetAt(el: Element): number {
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    if (n.classList.contains('window-bleed')) return BLEED_INSET
    if (n.getAttribute('data-slot') === 'dialog-content')
      return n.hasAttribute('data-flush') ? FLUSH_INSET : WINDOW_INSET
  }
  throw new Error('not inside a window')
}

/** A spacing class's px: `4` is 16, `(--inset)` the box's `--inset`. */
function stepPx(el: Element, step: string): number {
  return step === '(--inset)' ? insetAt(el) : Number(step) * 4
}

/** The px of the last class matching one of `sides`, most specific first. */
function sidePx(el: Element, sides: ReadonlyArray<string>): number {
  const classes = [...el.classList]
  for (const side of sides) {
    const hit = classes
      .map((c) => new RegExp(`^(-?)${side}-([\\d.]+|\\(--inset\\))$`).exec(c))
      .filter((m) => m !== null)
      .at(-1)
    if (hit !== undefined) return (hit[1] === '-' ? -1 : 1) * stepPx(el, hit[2])
  }
  if (sides.includes('mx') && el.classList.contains('window-bleed'))
    return -BLEED_MARGIN
  return 0
}

const borderLeft = (el: Element) =>
  ['border', 'border-x', 'border-l'].some((c) => el.classList.contains(c)) &&
  !el.classList.contains('border-l-0')
    ? 1
    : 0

/** A box that lays its children side by side. */
const isRow = (el: Element) =>
  (el.classList.contains('flex') || el.classList.contains('inline-flex')) &&
  !el.classList.contains('flex-col')

/**
 * How far the box marked `data-at` starts from the inside of its window's
 * 1px frame. A box in a row is its row's first, so nothing beside it pushes
 * it right.
 */
function offsetOf(at: string): number {
  const el = document.querySelector(`[data-at="${at}"]`)
  if (el === null) throw new Error(`no ${at}`)
  let px = 0
  for (let n: Element = el; ;) {
    const parent = n.parentElement
    if (parent === null) throw new Error(`${at} is not in a window`)
    if (isRow(parent))
      expect(n.previousElementSibling?.tagName ?? null, at).toBeNull()
    px += sidePx(n, ['ml', 'mx', 'm'])
    px += sidePx(parent, ['pl', 'px', 'p'])
    if (parent.getAttribute('data-slot') === 'dialog-content') return px
    px += borderLeft(parent)
    n = parent
  }
}

const offsets = (marks: ReadonlyArray<string>) => marks.map(offsetOf)

function windowSources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return windowSources(path)
    if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) return []
    const text = readFileSync(path, 'utf8')
    return /<DialogContent\b/.test(text)
      ? [{ file: relative(SRC, path), text }]
      : []
  })
}

const WINDOW_FILES = windowSources(SRC)

describe('a window opened from a window', () => {
  it('steps down 56px under its parent, over a lighter scrim', () => {
    mount(
      <Sheet title="Email" size="l">
        <Sheet title="pitch.pdf" size="viewer" />
      </Sheet>,
    )
    const [parent, child] = sheets()
    expect(parent.dataset.windowDepth).toBe('1')
    expect(child.dataset.windowDepth).toBe('2')
    expect(parent.style.top).toBe('')
    expect(Number.parseFloat(child.style.top) - PARENT_TOP).toBe(
      ui.STACK_STEP_PX,
    )
    expect(ui.STACK_STEP_PX).toBe(56)
    expect(child.className.split(' ')).toContain('translate-y-0')
    expect(parent.className.split(' ')).toContain('translate-y-[-50%]')
    const [under, over] = overlays()
    expect(under.split(' ')).toContain('bg-hairline/50')
    expect(over.split(' ')).toContain('bg-hairline/30')
    expect(over.split(' ')).not.toContain('bg-hairline/50')
  })

  it('closes alone on Esc, leaving its parent open', () => {
    const parent = vi.fn()
    const child = vi.fn()
    mount(
      <Sheet title="Email" size="l" onOpenChange={parent}>
        <Sheet title="pitch.pdf" size="viewer" onOpenChange={child} />
      </Sheet>,
    )
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(child).toHaveBeenCalledWith(false)
    expect(parent).not.toHaveBeenCalled()
  })

  it('cannot open a third: in development it throws', () => {
    expect(import.meta.env.DEV).toBe(true)
    const errors: Array<unknown> = []
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mount(
        <Sheet title="Email" size="l">
          <Sheet title="pitch.pdf" size="viewer">
            <Sheet title="Delete pitch.pdf?" size="s" />
          </Sheet>
        </Sheet>,
        (error) => errors.push(error),
      )
    } catch (error) {
      errors.push(error)
    } finally {
      silence.mockRestore()
    }
    expect(errors.map(String).join('\n')).toMatch(/at most 2 are open/)
  })
})

describe('a window on its own', () => {
  it('centres, with no offset of its own', () => {
    mount(<Sheet title="New space" size="s" />)
    const [sheet] = sheets()
    expect(sheet.style.top).toBe('')
    expect(sheet.className.split(' ')).toContain('translate-y-[-50%]')
    expect(sheet.className.split(' ')).toContain('sm:max-w-[27.5rem]')
    // It lands by its solid offset, never by scaling.
    expect(sheet.className).toContain('data-[state=open]:window-land')
    expect(sheet.className).not.toMatch(/zoom-(in|out)-95/)
  })
})

describe('the window inset', () => {
  it('is one 16px all round: the sheet, its head and its foot', () => {
    const { DialogFooter, DialogHeader } = ui
    mount(
      <Sheet title="New space" size="m">
        <DialogHeader>Head</DialogHeader>
        <DialogFooter>Foot</DialogFooter>
      </Sheet>,
    )
    const sheet = sheets().at(0)
    if (sheet === undefined) throw new Error('no window')
    const own = sheet.className.split(' ')
    expect(own.filter((c) => /^p[xy]?-\d/.test(c))).toEqual(['p-4'])
    const head = sheet.querySelector('[data-slot="dialog-header"]')
    const foot = sheet.querySelector('[data-slot="dialog-footer"]')
    expect(head?.className.split(' ')).toEqual(
      expect.arrayContaining(['-mx-4', '-mt-4', 'px-4']),
    )
    expect(foot?.className.split(' ')).toEqual(
      expect.arrayContaining(['-mx-4', '-mb-4', 'px-4']),
    )
  })

  it('stands a ledger body’s row text on the title’s line', () => {
    const { DialogFooter, DialogHeader, DialogTitle } = ui
    const { LabelHead, LedgerRow } = ledger
    mount(
      <Frame size="l">
        <DialogHeader>
          <DialogTitle data-at="title">Partner sync</DialogTitle>
        </DialogHeader>
        <div className="-mx-4 flex flex-col gap-6 overflow-y-auto px-4">
          <section>
            <LabelHead label={<span data-at="label">Linked records</span>} />
            <ol>
              <LedgerRow>
                <span data-at="row">Flent</span>
              </LedgerRow>
            </ol>
          </section>
        </div>
        <DialogFooter note={<span data-at="note">Not kept unless saved</span>}>
          <button type="button">Done</button>
        </DialogFooter>
      </Frame>,
    )
    expect(offsets(['title', 'label', 'row', 'note'])).toEqual([16, 16, 16, 16])
  })

  it('runs a bleed list to the edges with its row text on the line', () => {
    const { DialogHeader, DialogTitle } = ui
    mount(
      <Frame size="s">
        <DialogHeader>
          <DialogTitle data-at="title">Move stage</DialogTitle>
        </DialogHeader>
        <ol data-at="bleed" className="window-bleed -mt-4 flex flex-col">
          <li>
            <button type="button" className="flex h-8 w-full px-(--inset)">
              <span data-at="row">Diligence</span>
            </button>
          </li>
        </ol>
      </Frame>,
    )
    expect(offsets(['title', 'row'])).toEqual([16, 16])
    // The list's own box starts at the sheet's inside edge.
    expect(offsets(['bleed'])).toEqual([0])
  })

  it('insets a flush window’s rows 16px themselves, onto its head’s line', () => {
    const { DialogHeader, DialogTitle } = ui
    const { LedgerRow } = ledger
    mount(
      <Frame size="viewer">
        <DialogHeader className="mx-0 mt-0 mb-0">
          <DialogTitle data-at="title">pitch.pdf</DialogTitle>
        </DialogHeader>
        <ol data-at="list">
          <LedgerRow>
            <span data-at="row">v2 · pitch.pdf</span>
          </LedgerRow>
        </ol>
      </Frame>,
    )
    const sheet = sheets().at(0)
    expect(sheet?.dataset.flush).toBe('')
    expect(offsets(['title', 'row', 'list'])).toEqual([16, 16, 0])
  })
})

describe('the window line across the app', () => {
  it('no window spells its own padding: an edge-to-edge one is `flush`', () => {
    const spelled = WINDOW_FILES.flatMap(({ file, text }) =>
      [...text.matchAll(/<DialogContent\b[^>]*?\bp-0\b/g)].map(() => file),
    )
    expect(spelled).toEqual([])
  })

  it('no window row breaks out by the old 12px inset', () => {
    const old = WINDOW_FILES.filter(({ text }) => /\s-mx-3\s/.test(text))
    expect(old.map((f) => f.file)).toEqual([])
  })
})

describe('the confirm', () => {
  it('opens on Cancel, prints its note, and carries no square', () => {
    const { ConfirmDialog } = confirm
    mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        options={{
          title: 'Delete pitch.pdf?',
          action: 'Delete',
          note: "Can't be undone",
        }}
      />,
    )
    const [sheet] = sheets()
    expect(document.activeElement?.textContent.trim()).toBe('Cancel')
    expect(sheet.textContent).toContain("Can't be undone")
    const head = sheet.querySelector('[data-slot="dialog-header"]')
    expect(head?.querySelector('[aria-hidden]')).toBeNull()
    expect(sheet.className.split(' ')).toContain('sm:max-w-[27.5rem]')
  })
})
