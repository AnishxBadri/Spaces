import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogInteractionDialog } from './log-interaction-dialog'

/**
 * Log interaction's room is one field of chips: a suggestion picked adds a
 * chip, its × takes it away, the seed included. `Write it up next` is the
 * one variant of the one commit: the log carries `writeUp` and lands in the
 * write-up. Mounted in happy-dom, through Radix.
 */

await vi.hoisted(async () => {
  const { installHappyGlobals } = await import('#/test/happy-globals')
  installHappyGlobals()
})

const fns = vi.hoisted(() => ({
  logInteraction: vi.fn(),
  searchEntities: vi.fn(),
}))
const nav = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({ useRouter: () => nav }))
vi.mock('sonner', () => ({ toast: () => undefined }))

const SEED = { id: 'acme', name: 'Acme', kind: 'company' }

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.searchEntities.mockResolvedValue([
    { id: 'ada', name: 'Ada Lovelace', kind: 'person' },
    { id: 'acme', name: 'Acme', kind: 'company' },
  ])
  fns.logInteraction.mockResolvedValue({ noteId: 'note-1' })
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

async function openDialog() {
  host = document.createElement('div')
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<LogInteractionDialog seed={SEED} />))
  await click(button('Log meeting'))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}

describe('LogInteractionDialog', () => {
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
    expect(nav.navigate).toHaveBeenCalledWith({
      to: '/notes/$noteId',
      params: { noteId: 'note-1' },
    })
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
