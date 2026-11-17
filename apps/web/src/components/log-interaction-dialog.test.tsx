import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKey, formatDay } from '@spaces/core/format'
import { LogInteractionDialog } from './log-interaction-dialog'

/**
 * Log interaction's room is one field of chips: a suggestion picked adds a
 * chip, its × takes it away, the seed included. An optional Summary rides
 * the log. `Write it up next` is the one variant of the one commit: the log
 * carries `writeUp` and lands in the write-up's window over the record, or
 * its page with no record underneath. The toast names the kind and offers
 * `Write it up` when nothing is written yet. Mounted in happy-dom, through
 * Radix.
 */

await vi.hoisted(async () => {
  const { installHappyGlobals } = await import('#/test/happy-globals')
  installHappyGlobals()
})

const fns = vi.hoisted(() => ({
  logInteraction: vi.fn(),
  searchEntities: vi.fn(),
  writeUpInteraction: vi.fn(),
}))
const toasts = vi.hoisted(() => ({
  toast: vi.fn((_text: string, _options?: unknown) => undefined),
}))
const nav = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({ useRouter: () => nav }))
vi.mock('sonner', () => ({ toast: toasts.toast }))

const SEED = { id: 'acme', name: 'Acme', kind: 'company' }

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.searchEntities.mockResolvedValue([
    { id: 'ada', name: 'Ada Lovelace', kind: 'person' },
    { id: 'acme', name: 'Acme', kind: 'company' },
  ])
  fns.logInteraction.mockResolvedValue({ id: 'int-1', noteId: 'note-1' })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === label,
  )
  if (found === undefined) throw new Error(`no button ${label}`)
  return found
}

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await wait(0)
}

/** Types into a React-controlled input the way a keystroke would. */
const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    'value',
  )?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await wait(0)
}

const input = (id: string) => {
  const el = document.getElementById(id)
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${id}`)
  return el
}

const chips = () =>
  [...document.querySelectorAll('[data-attendee]')].map((c) =>
    c.getAttribute('data-attendee'),
  )

async function openDialog(
  props: Partial<Parameters<typeof LogInteractionDialog>[0]> = {
    seed: SEED,
  },
) {
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<LogInteractionDialog {...props} />))
  await click(button('Log meeting'))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}

const kindPicked = () =>
  [...document.querySelectorAll('[role="radio"]')]
    .find((r) => r.getAttribute('aria-checked') === 'true')
    ?.textContent.trim()

/** The search the log handed `router.navigate`, applied to `prev`. */
function searchOf(call: unknown, prev: Record<string, unknown>): unknown {
  if (typeof call !== 'object' || call === null || !('search' in call))
    throw new Error('no search')
  const search = call.search
  if (typeof search !== 'function') throw new Error('not a function')
  return search(prev)
}

describe('LogInteractionDialog', () => {
  it('prints When as the app prints a moment, and hands over to the native control on a click', async () => {
    await openDialog()
    const when = document.getElementById('int-when')
    if (!(when instanceof HTMLButtonElement)) throw new Error('no When')
    const printed = when.textContent
    expect(printed).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/)
    // The lane grows to the native control rather than clipping it.
    const lane = when.closest('.grid')
    expect(lane?.className).toContain(
      'grid-cols-[minmax(0,1fr)_minmax(13rem,max-content)]',
    )

    await click(when)
    const native = input('int-when')
    expect(native.type).toBe('datetime-local')
    const [day, time] = native.value.split('T')
    expect(printed).toBe(`${formatDay(day, dayKey(new Date()))}, ${time}`)

    await type(native, '2026-10-13T10:42')
    act(() => {
      native.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await wait(0)
    expect(document.getElementById('int-when')?.textContent).toMatch(
      /^13 Oct( 2026)?, 10:42$/,
    )

    await type(input('int-subject'), 'Series B intro')
    await click(footButton('Log meeting'))
    expect(fns.logInteraction.mock.calls[0]?.[0]).toMatchObject({
      data: { occurredAt: '2026-10-13T10:42' },
    })
  })

  it('adds a chip from a suggestion and takes chips away with ×', async () => {
    await openDialog()
    expect(chips()).toEqual(['acme'])

    await type(input('int-attendees'), 'ad')
    await wait(250)
    // Who is already in the room is not suggested again.
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual(['Ada Lovelaceperson'])
    const pick = options.at(0)?.querySelector('button')
    if (!pick) throw new Error('no suggestion')
    await click(pick)
    expect(chips()).toEqual(['acme', 'ada'])

    // Every chip carries its ×, the record it was opened from included.
    await click(getRemove('Acme'))
    expect(chips()).toEqual(['ada'])
    await click(getRemove('Ada Lovelace'))
    expect(chips()).toEqual([])
  })

  it('logs once with Write it up next ticked and lands in the write-up', async () => {
    await openDialog()
    await type(input('int-subject'), 'Series B intro')
    const tick = document.querySelector('[role="checkbox"]')
    if (!tick) throw new Error('no checkbox')
    await click(tick)
    expect(tick.getAttribute('aria-checked')).toBe('true')
    // One commit in the foot: Cancel and the log, no second door.
    const foot = document.querySelector('[data-slot="dialog-footer"]')
    expect(
      [...(foot?.querySelectorAll('button') ?? [])]
        .filter((b) => b.getAttribute('role') !== 'checkbox')
        .map((b) => b.textContent.trim()),
    ).toEqual(['Cancel', 'Log meeting'])

    await click(footButton('Log meeting'))
    await wait(0)
    expect(fns.logInteraction).toHaveBeenCalledTimes(1)
    expect(fns.logInteraction.mock.calls[0]?.[0]).toMatchObject({
      data: {
        kind: 'meeting',
        subject: 'Series B intro',
        attendeeIds: ['acme'],
        writeUp: true,
      },
    })
    // Over a record, the write-up opens in its window there.
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    const call: unknown = nav.navigate.mock.calls.at(0)?.at(0)
    expect(call).toMatchObject({ to: '.', resetScroll: false })
    expect(searchOf(call, { tab: 'interactions' })).toEqual({
      tab: 'interactions',
      modal: 'note',
      id: 'note-1',
    })
    // The write-up is open: the toast offers no second one.
    expect(toasts.toast).toHaveBeenCalledTimes(1)
    expect(toasts.toast.mock.calls.at(0)?.at(0)).toBe('Meeting logged')
    expect(toasts.toast.mock.calls.at(0)?.at(1)).not.toHaveProperty('action')
  })

  it('lands on the note page where no record is underneath', async () => {
    host = document.createElement('div')
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => r.render(<LogInteractionDialog hotkey="l" trigger={null} />))
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', bubbles: true }),
      )
    })
    await wait(0)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await type(input('int-subject'), 'Series B intro')
    await type(input('int-attendees'), 'ad')
    await wait(250)
    const pick = document.querySelector('[role="option"] button')
    if (!pick) throw new Error('no suggestion')
    await click(pick)
    const tick = document.querySelector('[role="checkbox"]')
    if (!tick) throw new Error('no checkbox')
    await click(tick)
    await click(footButton('Log meeting'))
    await wait(0)
    expect(nav.navigate).toHaveBeenCalledWith({
      to: '/notes/$noteId',
      params: { noteId: 'note-1' },
    })
  })

  it('carries the Summary, and toasts Call logged with Write it up', async () => {
    fns.logInteraction.mockResolvedValue({ id: 'int-2', noteId: null })
    fns.writeUpInteraction.mockResolvedValue({ noteId: 'note-2' })
    await openDialog()
    await click(
      [...document.querySelectorAll('[role="radio"]')].find(
        (r) => r.textContent.trim() === 'Call',
      ) ?? document.body,
    )
    await type(input('int-subject'), 'Pricing call')
    const summary = document.getElementById('int-summary')
    if (!(summary instanceof HTMLTextAreaElement)) throw new Error('no Summary')
    expect(summary.getAttribute('rows')).toBe('2')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    act(() => {
      setter?.call(summary, '  Wants a lead by March.  ')
      summary.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(footButton('Log call'))
    await wait(0)
    expect(fns.logInteraction.mock.calls[0]?.[0]).toMatchObject({
      data: { kind: 'call', summary: 'Wants a lead by March.', writeUp: false },
    })
    expect(nav.navigate).not.toHaveBeenCalled()
    const [text, options] = toasts.toast.mock.calls.at(0) ?? []
    expect(text).toBe('Call logged')
    const action: unknown =
      typeof options === 'object' && options !== null && 'action' in options
        ? options.action
        : null
    if (
      typeof action !== 'object' ||
      action === null ||
      !('label' in action) ||
      !('onClick' in action) ||
      typeof action.onClick !== 'function'
    )
      throw new Error('no Write it up')
    expect(action.label).toBe('Write it up')
    action.onClick()
    await wait(0)
    expect(fns.writeUpInteraction).toHaveBeenCalledWith({
      data: { interactionId: 'int-2' },
    })
    expect(searchOf(nav.navigate.mock.calls.at(0)?.at(0), {})).toEqual({
      modal: 'note',
      id: 'note-2',
    })
  })

  it('sends no summary when the field is left blank', async () => {
    await openDialog()
    await type(input('int-subject'), 'Series B intro')
    await click(footButton('Log meeting'))
    expect(fns.logInteraction.mock.calls[0]?.[0]).not.toHaveProperty(
      'data.summary',
    )
  })

  it('opens on the kind the Interactions tab is filtered to', async () => {
    await openDialog({ seed: SEED, defaultKind: 'call' })
    expect(kindPicked()).toBe('Call')
    act(() => root?.unmount())
    host?.remove()
    root = null
    await openDialog({ seed: SEED, defaultKind: null })
    expect(kindPicked()).toBe('Meeting')
  })
})

function getRemove(name: string): Element {
  const el = document.querySelector(`[aria-label="Remove ${name}"]`)
  if (el === null) throw new Error(`no remove for ${name}`)
  return el
}

function footButton(label: string): Element {
  const foot = document.querySelector('[data-slot="dialog-footer"]')
  const found = [...(foot?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent.trim() === label,
  )
  if (found === undefined) throw new Error(`no foot button ${label}`)
  return found
}
