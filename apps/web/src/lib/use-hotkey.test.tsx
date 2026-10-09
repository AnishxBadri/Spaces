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

import { NAV_ITEMS } from '#/components/app-sidebar'

import { CHORD_WINDOW_MS, useHotkey, useHotkeys } from './use-hotkey'

/**
 * The shell's G-chords against a page's single-key bindings, mounted the
 * way the app mounts them: the nav instance in the shell, the page's
 * `useHotkey` in a child. A key that completes an armed chord belongs to
 * the chord; the same key alone belongs to the page.
 *
 * The DOM is a happy-dom `Window` on this file's globals, not vitest's
 * happy-dom environment: that one transforms the per-file database setup
 * for the client, where `@spaces/db` cannot find its journal.
 */

const win = new Window()
let createRoot: typeof CreateRoot

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // react-dom decides whether it has a DOM when it loads, so after the stubs.
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

const navigate = vi.fn<(to: string) => void>()
const pageKey = vi.fn<(key: string) => void>()

function Shell({ children }: { children: ReactNode }) {
  useHotkeys(
    NAV_ITEMS.map((item): [string, () => void] => [
      item.key.toLowerCase(),
      () => navigate(item.to),
    ]),
  )
  return children
}

function Page({ bind }: { bind: string }) {
  useHotkey(bind, () => pageKey(bind))
  return null
}

let root: Root
let now = 0

function mount(node: ReactNode) {
  act(() => root.render(node))
}

function press(key: string, target: Element = document.body) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
  })
}

function chordTo(path: string) {
  const item = NAV_ITEMS.find((i) => i.to === path)
  if (!item) throw new Error(`no nav row for ${path}`)
  return item.key.toLowerCase().split(' ')
}

beforeEach(() => {
  navigate.mockReset()
  pageKey.mockReset()
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('a chord against a page binding on its second key', () => {
  it.each([
    ['l', '/files'],
    ['m', '/mandate'],
  ])('g then %s navigates to %s and does not reach the page', (key, path) => {
    expect(chordTo(path)).toEqual(['g', key])
    mount(
      <Shell>
        <Page bind={key} />
      </Shell>,
    )
    press('g')
    press(key)
    expect(navigate.mock.calls).toEqual([[path]])
    expect(pageKey).not.toHaveBeenCalled()
  })

  it.each(['l', 'm'])('%s alone still reaches the page', (key) => {
    mount(
      <Shell>
        <Page bind={key} />
      </Shell>,
    )
    press(key)
    expect(pageKey.mock.calls).toEqual([[key]])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('consumes only the one key: the next l reaches the page again', () => {
    mount(
      <Shell>
        <Page bind="l" />
      </Shell>,
    )
    press('g')
    press('l')
    press('l')
    expect(navigate.mock.calls).toEqual([['/files']])
    expect(pageKey.mock.calls).toEqual([['l']])
  })
})

describe('the guards are unchanged', () => {
  it('waits 800ms for the second key and no longer', () => {
    mount(
      <Shell>
        <Page bind="l" />
      </Shell>,
    )
    press('g')
    now += CHORD_WINDOW_MS - 1
    press('l')
    expect(navigate.mock.calls).toEqual([['/files']])

    press('g')
    now += CHORD_WINDOW_MS
    press('l')
    expect(navigate.mock.calls).toEqual([['/files']])
    expect(pageKey.mock.calls).toEqual([['l']])
  })

  it('is off while typing: g in a field arms nothing, l in a field fires nothing', () => {
    mount(
      <Shell>
        <Page bind="l" />
      </Shell>,
    )
    const input = document.createElement('input')
    document.body.append(input)
    press('g', input)
    press('l', input)
    expect(navigate).not.toHaveBeenCalled()
    expect(pageKey).not.toHaveBeenCalled()

    press('g', input)
    press('l')
    expect(navigate).not.toHaveBeenCalled()
    expect(pageKey.mock.calls).toEqual([['l']])
  })

  it('is off inside a dialog', () => {
    mount(
      <Shell>
        <Page bind="l" />
      </Shell>,
    )
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    press('g', button)
    press('l', button)
    expect(navigate).not.toHaveBeenCalled()
    expect(pageKey).not.toHaveBeenCalled()
  })

  it('drops an unmounted binding and keeps the chords that remain', () => {
    mount(
      <Shell>
        <Page bind="l" />
      </Shell>,
    )
    mount(<Shell>{null}</Shell>)
    press('l')
    expect(pageKey).not.toHaveBeenCalled()
    press('g')
    press('l')
    expect(navigate.mock.calls).toEqual([['/files']])

    mount(null)
    press('g')
    press('l')
    expect(navigate.mock.calls).toEqual([['/files']])
  })
})
