import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailPrivacy } from '#/lib/server-fns'
import { WidenDialog } from './who-can-read'

/**
 * `Who can read this`: the wider line from the mailbox or a record, the
 * owner, the grantees with ×, `Add a person…`, the record's switch, and a
 * foot of the privacy hint, Cancel and Save.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/x' })
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

const fns = vi.hoisted(() => ({
  listMembers: vi.fn(),
  setEmailAudience: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react')
  return {
    // A link as the href it resolves to, `$param`s filled.
    Link: ({
      to,
      params = {},
      children,
    }: {
      to: string
      params?: Record<string, string>
      children?: ReactNode
    }) =>
      createElement(
        'a',
        {
          href: Object.entries(params).reduce(
            (path, [k, v]) => path.replace(`$${k}`, v),
            to,
          ),
        },
        children,
      ),
  }
})

const ID = '00000000-0000-4000-8000-000000000001'
const FLENT = '00000000-0000-4000-8000-0000000000aa'

const MINE: EmailPrivacy = {
  owner: { id: 'u-anish', name: 'Anish Badri' },
  mine: true,
  workspace: false,
  wider: null,
  grantees: [{ id: 'u-priya', name: 'Priya Raman', you: false }],
  record: { id: FLENT, name: 'Flent', on: false },
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset()
  fns.listMembers.mockResolvedValue([
    { id: 'u-anish', name: 'Anish Badri', banned: false },
    { id: 'u-priya', name: 'Priya Raman', banned: false },
    { id: 'u-sam', name: 'Sam Lee', banned: false },
  ])
  fns.setEmailAudience.mockResolvedValue({ ok: true })
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

async function open(privacy: EmailPrivacy, onSaved = vi.fn()) {
  const onOpenChange = vi.fn()
  act(() =>
    root.render(
      <WidenDialog
        emailId={ID}
        privacy={privacy}
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
    ),
  )
  await settle()
  const dialog = document.querySelector('[role="dialog"]')
  if (dialog === null) throw new Error('no window')
  return { dialog, onOpenChange }
}

/** The body's rows in order, each as its text. */
const rows = (dialog: Element) =>
  [...dialog.querySelectorAll('ol > li')].map((li) => li.textContent.trim())

describe('Who can read this', () => {
  it('lists the owner, each grantee with ×, Add a person… and the switch, then the hint, Cancel and Save', async () => {
    const { dialog } = await open(MINE)
    expect(rows(dialog)).toEqual([
      'Anish BadriOwner',
      'Priya Raman',
      'Add a person…',
      'Every email I have with Flent',
    ])
    expect(dialog.querySelector('[aria-label="Remove Priya Raman"]')).not.toBe(
      null,
    )
    expect(
      dialog.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('false')
    expect(
      dialog.querySelector('[data-slot="dialog-footer"]')?.textContent,
    ).toBe('Subject, people and date stay visible to allCancelSave')
  })

  it('says the mailbox already shares the body, and links to Mail sync', async () => {
    const { dialog } = await open({
      ...MINE,
      workspace: true,
      wider: { kind: 'mailbox', connectionId: 'c-gmail' },
    })
    expect(rows(dialog).at(0)).toBe(
      'Your mailbox is shared with the workspaceMail sync ›',
    )
    const link = [...dialog.querySelectorAll('a')].find(
      (a) => a.textContent === 'Mail sync ›',
    )
    expect(link?.getAttribute('href')).toBe('/settings/email-calendar/c-gmail')
  })

  it('says a record’s override already shares it, and links to that record', async () => {
    const { dialog } = await open({
      ...MINE,
      workspace: true,
      wider: {
        kind: 'record',
        record: {
          id: 'd-exponent',
          kind: 'deal',
          name: 'Exponent',
          objectSlug: null,
        },
      },
    })
    expect(rows(dialog).at(0)).toBe('Shared through Exponent')
    const link = [...dialog.querySelectorAll('a')].find(
      (a) => a.textContent === 'Exponent',
    )
    expect(link?.getAttribute('href')).toBe('/deals/d-exponent')
  })

  it('has no switch opened from no record, and no wider line when nothing opens it', async () => {
    const { dialog } = await open({ ...MINE, record: null })
    expect(rows(dialog)).toEqual([
      'Anish BadriOwner',
      'Priya Raman',
      'Add a person…',
    ])
    expect(dialog.querySelector('[role="switch"]')).toBeNull()
  })

  it('saves the grants and the switch at once, narrowing as well as widening', async () => {
    const onSaved = vi.fn()
    const { dialog, onOpenChange } = await open(MINE, onSaved)
    const remove = dialog.querySelector('[aria-label="Remove Priya Raman"]')
    if (!(remove instanceof HTMLElement)) throw new Error('no ×')
    act(() => remove.click())
    const toggle = dialog.querySelector('[role="switch"]')
    if (!(toggle instanceof HTMLElement)) throw new Error('no switch')
    act(() => toggle.click())
    const save = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Save',
    )
    act(() => save?.click())
    await settle()
    expect(fns.setEmailAudience).toHaveBeenCalledWith({
      data: {
        interactionId: ID,
        userIds: [],
        record: { id: FLENT, workspace: true },
      },
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the window and says why when the save fails', async () => {
    fns.setEmailAudience.mockRejectedValue(
      new Error('Only its owner can widen this email'),
    )
    const onSaved = vi.fn()
    const { dialog } = await open(MINE, onSaved)
    const save = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Save',
    )
    act(() => save?.click())
    await settle()
    expect(dialog.textContent).toContain('Only its owner can widen this email')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('drops Add a person… once every member is granted', async () => {
    fns.listMembers.mockResolvedValue([
      { id: 'u-priya', name: 'Priya Raman', banned: false },
      { id: 'u-gone', name: 'Gone', banned: true },
    ])
    const { dialog } = await open({ ...MINE, record: null })
    expect(rows(dialog)).toEqual(['Anish BadriOwner', 'Priya Raman'])
  })
})
