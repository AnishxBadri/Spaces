import { describe, expect, it, vi } from 'vitest'
import { DOCK_DEFAULT, clampWidth, readStored } from './dock-store'

describe('the dock store', () => {
  it('holds the width between 360 and 560px', () => {
    expect(clampWidth(200)).toBe(360)
    expect(clampWidth(480)).toBe(480)
    expect(clampWidth(900)).toBe(560)
  })

  it('reads back the open state, width and thread a reload kept', () => {
    expect(
      readStored(JSON.stringify({ open: true, width: 512, threadId: 't1' })),
    ).toEqual({ open: true, width: 512, threadId: 't1' })
    expect(readStored(JSON.stringify({ width: 9999 })).width).toBe(560)
    expect(readStored('not json')).toEqual({
      open: false,
      width: DOCK_DEFAULT,
      threadId: null,
    })
    expect(readStored(null).open).toBe(false)
  })
})

describe('the doors', () => {
  it('⌘J opens it empty and closes it, keeping the thread and width across a reload', async () => {
    const { Window } = await import('happy-dom')
    const win = new Window({ url: 'http://localhost/' })
    vi.stubGlobal('window', win)
    vi.resetModules()
    const store = await import('./dock-store')
    store.setDockThread('t1')
    store.setDockWidth(1000)
    store.toggleAsk()
    const stored = () =>
      store.readStored(win.localStorage.getItem('spaces.ask.dock'))
    expect(stored()).toEqual({ open: true, width: 560, threadId: 't1' })
    store.toggleAsk()
    expect(stored()).toEqual({ open: false, width: 560, threadId: 't1' })
    // A reload reads the same state back.
    vi.resetModules()
    const again = await import('./dock-store')
    again.openAsk({ draft: 'which deals went quiet' })
    expect(stored()).toEqual({ open: true, width: 560, threadId: 't1' })
    vi.unstubAllGlobals()
    await win.happyDOM.close()
  })
})
