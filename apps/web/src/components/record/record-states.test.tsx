import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClockProvider } from '#/components/clock'
import { RecordGone, RecordHeadPending, RecordLoadFailed } from './record-parts'

/**
 * A record route's not-found and couldn't-load screens: the head says the
 * state in place of the name, one card says why, and its button is the way
 * out. The couldn't-load screen logs the error and never prints it.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/notes/x' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLButtonElement',
    'Text',
    'DocumentFragment',
    'Event',
    'MouseEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const router = vi.hoisted(() => ({
  invalidate: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  router.invalidate.mockClear()
  vi.restoreAllMocks()
})

function mount(node: ReactNode) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const r = createRoot(el)
  host = el
  root = r
  act(() =>
    r.render(
      <ClockProvider now="2026-11-17T12:00:00.000Z">{node}</ClockProvider>,
    ),
  )
  return el
}

const words = (el: Element) => el.textContent.replace(/\s+/g, ' ')

describe('RecordGone', () => {
  it('stamps the kind in outline and leads back to its list', () => {
    const el = mount(
      <RecordGone kind="Note" listTo="/notes" listLabel="Open Notes" />,
    )
    const stamp = el.querySelector('[data-stamp="gone"]')
    expect(stamp?.textContent).toBe('Note')
    expect(stamp?.className).toContain('stamp-outline')
    expect(el.querySelector('h1')?.textContent).toBe('Not found')
    expect(words(el)).toContain('It was deleted, or the link is wrong.')
    const link = el.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/notes')
    expect(link?.textContent).toBe('Open Notes')
  })

  it('falls back to no stamp and Today', () => {
    const el = mount(<RecordGone />)
    expect(el.querySelector('[data-stamp]')).toBeNull()
    expect(el.querySelector('h1')?.textContent).toBe('Not found')
    const link = el.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/today')
    expect(link?.textContent).toBe('Open Today')
  })
})

describe('RecordLoadFailed', () => {
  it('says the fixed sentence, logs the error and never prints it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const el = mount(<RecordLoadFailed kind="Note" error={error} />)
    expect(el.querySelector('[data-stamp="live"]')?.textContent).toBe('Note')
    expect(el.querySelector('h1')?.textContent).toBe("Couldn't load")
    expect(words(el)).toContain('The database did not answer.')
    expect(words(el)).not.toContain('ECONNREFUSED')
    expect(log).toHaveBeenCalledWith(error)
  })

  it('Retry re-runs the route through the router', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = mount(<RecordLoadFailed error={new Error('boom')} />)
    expect(el.querySelector('[data-stamp]')).toBeNull()
    const retry = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry',
    )
    act(() => retry?.click())
    expect(router.invalidate).toHaveBeenCalledTimes(1)
  })
})

describe('the state heads', () => {
  it('close on the one ink line, stamped or not, and while loading', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const node of [
      <RecordGone key="gone" kind="Note" />,
      <RecordGone key="bare" />,
      <RecordLoadFailed key="failed" kind="Note" error={new Error('boom')} />,
      <RecordHeadPending key="pending" kind="Company" />,
    ]) {
      const head = mount(node).querySelector('header')
      const classes = head?.className.split(' ') ?? []
      expect(classes).toEqual(
        expect.arrayContaining(['border-b', 'border-hairline']),
      )
      expect(classes).not.toContain('border-rule')
      act(() => root?.unmount())
      host?.remove()
      root = null
      host = null
    }
  })
})
