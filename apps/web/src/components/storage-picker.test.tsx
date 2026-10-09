import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkFetchRow, useLinkFetches } from './record-files-link'
import { PickerButton, StoragePicker, readGooglePick } from './storage-picker'

/**
 * The picker host under the fake providers: three files picked are one
 * attach of three, and three pending rows; a cancel attaches nothing and
 * leaves nothing behind. And the button in each state the mint can be in.
 * - A happy-dom window's DOM globals are installed by hand before React
 *   loads: the happy-dom environment would also replace `URL`, which the
 *   database setup file needs as node's.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/acme' })
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

const RECORD = '00000000-0000-4000-8000-000000000001'

const FILES = [
  { id: 'deck', name: 'Acme deck.pdf', path: 'My Drive / Acme Data Room' },
  { id: 'captable', name: 'Cap table.xlsx', path: 'My Drive / Acme Data Room' },
  { id: 'spa', name: 'Share purchase agreement.pdf', path: null },
  { id: 'minutes', name: 'Minutes Q3.pdf', path: 'My Drive / Board' },
]

const fns = vi.hoisted(() => ({
  pickerReadiness: vi.fn(),
  mintPickerToken: vi.fn(),
  attachFromPicker: vi.fn(),
  attachFromLink: vi.fn(),
  linkFetchStatus: vi.fn(),
}))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}))

function Harness() {
  const links = useLinkFetches(RECORD)
  return (
    <div>
      <StoragePicker onPicked={(files) => void links.attachPicked(files)} />
      <ul>
        {links.fetches.map((f) => (
          <LinkFetchRow
            key={f.key}
            fetch={f}
            onDismiss={() => links.dismiss(f.key)}
          />
        ))}
      </ul>
    </div>
  )
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.pickerReadiness.mockResolvedValue({ _tag: 'ready' })
  fns.mintPickerToken.mockResolvedValue({ _tag: 'fake', files: FILES })
  fns.linkFetchStatus.mockResolvedValue({})
  fns.attachFromPicker.mockImplementation(
    ({ data }: { data: { files: Array<{ id: string; name: string }> } }) =>
      Promise.resolve({
        _tag: 'queued',
        files: data.files.map((f) => ({ ...f, fetchId: `fetch-${f.id}` })),
      }),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

const mount = async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<Harness />))
  await flush()
}

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
  await flush()
}

const openFakePicker = async () => {
  await mount()
  await click(button('Attach from Drive'))
  expect(fns.mintPickerToken).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}

const fetching = () =>
  document.body.textContent.split('Fetching from Drive…').length - 1

describe('StoragePicker under the fake providers', () => {
  it('attaches three picked files as three fetches, each a pending row', async () => {
    await openFakePicker()
    for (const name of ['Acme deck.pdf', 'Cap table.xlsx', 'Minutes Q3.pdf']) {
      const box = document.querySelector(`[aria-label="Pick ${name}"]`)
      if (box === null) throw new Error(`no box for ${name}`)
      await click(box)
    }
    await click(button('Attach 3'))

    expect(fns.attachFromPicker).toHaveBeenCalledTimes(1)
    expect(fns.attachFromPicker.mock.calls[0]?.[0]).toMatchObject({
      data: {
        provider: 'google',
        attachTo: RECORD,
        files: [
          { id: 'deck', name: 'Acme deck.pdf' },
          { id: 'captable', name: 'Cap table.xlsx' },
          { id: 'minutes', name: 'Minutes Q3.pdf' },
        ],
      },
    })
    expect(fetching()).toBe(3)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('attaches nothing and leaves no row or sheet behind on Cancel', async () => {
    await openFakePicker()
    const box = document.querySelector('[aria-label="Pick Acme deck.pdf"]')
    if (box === null) throw new Error('no box')
    await click(box)
    await click(button('Cancel'))

    expect(fns.attachFromPicker).not.toHaveBeenCalled()
    expect(fetching()).toBe(0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('PickerButton', () => {
  const render = (readiness: Parameters<typeof PickerButton>[0]['readiness']) =>
    renderToStaticMarkup(
      <PickerButton
        readiness={readiness}
        opening={false}
        onOpen={() => undefined}
      />,
    )

  it('offers Connect with no connection, and Google’s re-consent without drive.file', () => {
    const connect = render({
      _tag: 'connect',
      href: '/api/connections/google/start?product=drive',
      label: 'Connect Drive',
    })
    expect(connect).toContain(
      'href="/api/connections/google/start?product=drive"',
    )
    expect(connect).toContain('Connect Drive')
    const consent = render({
      _tag: 'consent',
      href: '/api/connections/google/start?product=drive&amp;scopes=drive.file',
    })
    expect(consent).toContain('scopes=drive.file')
    expect(consent).toContain('Attach from Drive…')
  })

  it('reads Picker not set up, a link for an admin and none for a member', () => {
    const unconfigured = {
      _tag: 'unconfigured' as const,
      reason: 'needs Picker API key and Picker app id',
      integrationId: 'row',
    }
    expect(
      render({ ...unconfigured, settingsHref: '/settings/plugins/row' }),
    ).toContain('href="/settings/plugins/row"')
    const member = render({ ...unconfigured, settingsHref: null })
    expect(member).toContain('Picker not set up')
    expect(member).not.toContain('href=')
  })
})

describe('readGooglePick', () => {
  const keys = {
    Action: { PICKED: 'picked', CANCEL: 'cancel' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Document: { ID: 'id', NAME: 'name' },
  }

  it('reads a pick as its files, a cancel as nothing, and anything else as no answer', () => {
    expect(
      readGooglePick(keys, {
        action: 'picked',
        docs: [
          { id: 'a', name: 'A.pdf', mimeType: 'application/pdf' },
          { id: 'b', name: 'B.pdf' },
          { name: 'no id' },
        ],
      }),
    ).toEqual({
      kind: 'picked',
      files: [
        { id: 'a', name: 'A.pdf' },
        { id: 'b', name: 'B.pdf' },
      ],
    })
    expect(readGooglePick(keys, { action: 'cancel' })).toEqual({
      kind: 'cancel',
    })
    expect(readGooglePick(keys, { action: 'loaded' })).toBeNull()
  })
})
