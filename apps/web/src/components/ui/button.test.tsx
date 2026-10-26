import { Window } from 'happy-dom'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Button } from './button.tsx'

/**
 * A key lives in the button's tooltip, never inside it (A2), and a pending
 * button holds the width it had while armed so its `Saving…` moves nothing.
 */

const win = new Window()
let createRoot: typeof CreateRoot

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

describe('the shortcut', () => {
  it('prints no key in the button, and makes it a tooltip trigger', () => {
    const html = renderToStaticMarkup(
      <Button variant="outline" shortcut="L">
        Log interaction
      </Button>,
    )
    expect(html).not.toContain('<kbd')
    expect(html).not.toMatch(/>L</)
    expect(html).toMatch(
      /^<button[^>]*data-state="closed"[^>]*>Log interaction<\/button>$/,
    )
  })

  it('leaves a button with no shortcut alone', () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).not.toContain(
      'data-state',
    )
  })
})

describe('pending', () => {
  it('disarms the button and holds the width it had while armed', () => {
    const width = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(96)
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    act(() => root.render(<Button pending={false}>Save</Button>))
    const armed = host.querySelector('button')
    expect(armed?.getAttribute('style')).toBeNull()

    width.mockReturnValue(64)
    act(() => root.render(<Button pending>Saving…</Button>))
    const busy = host.querySelector('button')
    expect(busy?.hasAttribute('disabled')).toBe(true)
    expect(busy?.hasAttribute('data-pending')).toBe(true)
    expect(busy?.getAttribute('style')).toBe('min-width: 96px;')
    // No spinner: the label is the caller's, nothing else is drawn.
    expect(busy?.innerHTML).toBe('Saving…')

    act(() => root.render(<Button pending={false}>Save</Button>))
    expect(host.querySelector('button')?.getAttribute('style')).toBeNull()
    act(() => root.unmount())
    width.mockRestore()
  })
})
