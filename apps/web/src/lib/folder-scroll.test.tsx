import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { tabScrollMemory, useFolderScroll } from './folder-scroll'

/**
 * A fixed pane's folder keeps each tab's place: leave a scrolled History for
 * Overview and come back, and History is where it was. The hook runs in a
 * happy-dom `Window` on this file's globals.
 */

describe('the tab scroll memory', () => {
  it('opens a tab it has not seen at the top', () => {
    expect(tabScrollMemory().recall('flent', 'history')).toBe(0)
  })

  it('keeps each tab’s own place', () => {
    const memory = tabScrollMemory()
    memory.keep('flent', 'history', 640)
    memory.keep('flent', 'overview', 80)
    expect(memory.recall('flent', 'history')).toBe(640)
    expect(memory.recall('flent', 'overview')).toBe(80)
    expect(memory.recall('flent', 'files')).toBe(0)
  })

  it('forgets one record’s places on opening another', () => {
    const memory = tabScrollMemory()
    memory.keep('flent', 'history', 640)
    expect(memory.recall('vayu', 'history')).toBe(0)
    // Back on the first record, it opens at the top too.
    expect(memory.recall('flent', 'history')).toBe(0)
  })
})

const win = new Window()
let createRoot: typeof CreateRoot

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

function Folder({ scope, tab }: { scope: string; tab: string }) {
  const pane = useFolderScroll(scope, tab)
  return (
    <div ref={pane.ref} onScroll={pane.onScroll} data-folder-scroll>
      <p>{tab}</p>
    </div>
  )
}

describe('the folder scroller', () => {
  it('returns to a tab where it was left, and opens another record at the top', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    const show = (scope: string, tab: string) =>
      act(() => root.render(<Folder scope={scope} tab={tab} />))
    const folder = () => {
      const el = win.document.querySelector('[data-folder-scroll]')
      if (!(el instanceof win.HTMLElement)) throw new Error('no folder')
      return el
    }
    const scrollTo = (top: number) =>
      act(() => {
        folder().scrollTop = top
        folder().dispatchEvent(new win.Event('scroll', { bubbles: false }))
      })

    show('flent', 'history')
    expect(folder().scrollTop).toBe(0)
    scrollTo(640)

    show('flent', 'overview')
    expect(folder().scrollTop).toBe(0)
    scrollTo(40)

    show('flent', 'history')
    expect(folder().scrollTop).toBe(640)
    show('flent', 'overview')
    expect(folder().scrollTop).toBe(40)

    // The same route, another record: its tabs start at the top.
    show('vayu', 'history')
    expect(folder().scrollTop).toBe(0)

    act(() => root.unmount())
    host.remove()
  })
})
