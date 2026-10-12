import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailDetail } from '#/lib/server-fns'
import { EmailModal } from './email-dialog'

/**
 * The email window (D67, E2) opened from `?modal=email&id=` (D74): the
 * sandboxed frame, the remote-image count printed once, a private body as
 * one line, and one close in the foot that drops the two params.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/today' })
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
    'HTMLIFrameElement',
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

const ID = '00000000-0000-4000-8000-000000000001'

const fns = vi.hoisted(() => ({
  getEmail: vi.fn(),
  getDocumentPreview: vi.fn(),
  getDocumentDownloadUrl: vi.fn(),
  getDocumentText: vi.fn(),
}))
const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: { modal: 'email', id: '00000000-0000-4000-8000-000000000001' },
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}))

const HTML: EmailDetail = {
  id: ID,
  subject: 'Acme Robotics — Q3 update',
  occurredAt: '2026-10-01T09:14:00.000Z',
  from: { email: 'jane@acme-robotics.example', name: 'Jane Founder' },
  to: [{ email: 'anish@fund.example', name: null }],
  cc: [],
  via: 'Anish',
  body: {
    kind: 'html',
    srcdoc: '<!doctype html><html><body><p>Q3 closed.</p></body></html>',
    remoteImages: 2,
  },
  attachments: [{ documentId: 'd1', name: 'acme-q3.pdf', sizeBytes: 2048 }],
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  router.navigate.mockReset()
  fns.getEmail.mockResolvedValue(HTML)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

async function open() {
  act(() => root.render(<EmailModal />))
  await settle()
}

const dialog = () => document.querySelector('[role="dialog"]')
const buttons = (label: string) =>
  [...document.querySelectorAll('button')].filter(
    (b) => b.textContent.trim() === label,
  )

describe('the email window', () => {
  it('opens from ?modal=email&id= with the subject, the date and the participants', async () => {
    await open()
    expect(fns.getEmail).toHaveBeenCalledWith({ data: { id: ID } })
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('Acme Robotics — Q3 update')
    expect(text).toContain('Jane Founder')
    expect(text).toContain('anish@fund.example')
    expect(text).toContain('acme-q3.pdf')
  })

  it('renders the body in a frame sandboxed with no scripts and no forms', async () => {
    await open()
    const frame = dialog()?.querySelector('iframe')
    const sandbox = frame?.getAttribute('sandbox') ?? ''
    expect(frame).not.toBeNull()
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-forms')
    expect(sandbox).toContain('allow-popups')
    expect(frame?.getAttribute('srcdoc')).toContain('Q3 closed.')
  })

  it('counts the remote images in one line', async () => {
    await open()
    const lines = dialog()?.querySelectorAll('[data-remote-images]') ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]?.textContent).toBe('2 remote images not loaded')
  })

  it('says a private body in one line and lists no attachment', async () => {
    fns.getEmail.mockResolvedValue({
      ...HTML,
      body: { kind: 'private' },
      attachments: [],
    })
    await open()
    expect(dialog()?.querySelector('iframe')).toBeNull()
    expect(dialog()?.querySelector('[data-body-private]')).not.toBeNull()
    expect(dialog()?.textContent).not.toContain('acme-q3.pdf')
  })

  it('has one close, in the foot, which drops the modal params', async () => {
    await open()
    expect(buttons('Cancel')).toHaveLength(1)
    const cancel = buttons('Cancel')[0]
    expect(cancel.closest('[data-slot="dialog-footer"]')).not.toBeNull()
    expect(dialog()?.textContent ?? '').not.toMatch(/\besc\b/i)
    act(() => cancel.click())
    expect(router.navigate).toHaveBeenCalledTimes(1)
    const call: unknown = router.navigate.mock.calls[0]?.[0]
    if (typeof call !== 'object' || call === null || !('search' in call))
      throw new Error('no search')
    const search = call.search
    if (typeof search !== 'function') throw new Error('not a function')
    expect(search({ tab: 'interactions', modal: 'email', id: ID })).toEqual({
      tab: 'interactions',
      modal: undefined,
      id: undefined,
    })
  })
})
