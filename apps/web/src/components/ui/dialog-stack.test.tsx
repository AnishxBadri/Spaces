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
