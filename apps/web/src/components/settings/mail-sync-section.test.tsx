import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailSyncSettings, addedEntries, listOf } from './mail-sync-section'
import { SettingsForm } from './settings-form'

/**
 * The Mail sync card’s two exclude lists as chips: each entry a
 * removable chip, a dashed `+ Add` that opens a field, both drafts in the
 * page's Save bar, and a save that adds still asking before mail already
 * synced is removed. Mounted in happy-dom under the page form, through Radix.
 */

await vi.hoisted(async () => {
  const { installHappyGlobals } = await import('#/test/happy-globals')
  installHappyGlobals()
})

const fns = vi.hoisted(() => ({ saveMailboxSync: vi.fn() }))
const nav = vi.hoisted(() => ({ invalidate: vi.fn(() => Promise.resolve()) }))

vi.mock('#/lib/server-fns', () => fns)
vi.mock('@tanstack/react-router', () => ({ useRouter: () => nav }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const VIEW = {
  shareBodies: false,
  excludeSenders: ['noreply@', 'mcsv.net'],
  excludeLabels: ['Promotions', 'Social'],
}

type SaveCall = {
  data: {
    excludeSenders: Array<string>
    excludeLabels: Array<string>
    shareBodies: boolean
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fns.saveMailboxSync.mockImplementation(({ data }: SaveCall) =>
    Promise.resolve({
      view: {
        shareBodies: data.shareBodies,
        excludeSenders: data.excludeSenders,
        excludeLabels: data.excludeLabels,
      },
      revisited: 0,
      removed: 0,
    }),
  )
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <SettingsForm>
        <MailSyncSettings connectionId="conn-1" view={VIEW} />
      </SettingsForm>,
    ),
  )
  await wait(0)
}

const byLabel = (label: string) => {
  const el = document.querySelector(`[aria-label="${label}"]`)
  if (el === null) throw new Error(`nothing labelled ${label}`)
  return el
}

const chipsOf = (list: string) =>
  [...byLabel(list).querySelectorAll('[data-chip]')].map((c) =>
    c.getAttribute('data-chip'),
  )

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await wait(0)
}

const key = async (el: Element, k: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
  await wait(0)
}

/** Types into a React-controlled input the way a keystroke would. */
const type = async (el: Element, value: string) => {
  if (!(el instanceof HTMLInputElement)) throw new Error('not an input')
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

const saveBarButton = (label: string) => {
  const bar = document.querySelector('[data-save-bar]')
  const found = [...(bar?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent.trim() === label,
  )
  if (found === undefined) throw new Error(`no ${label} in the Save bar`)
  return found
}

const dialog = () => document.querySelector('[role="dialog"]')

describe('the mail sync lists as chips', () => {
  it('draws each entry as a chip: senders in mono, labels in sans', async () => {
    await mount()
    expect(chipsOf('Senders never synced')).toEqual(['noreply@', 'mcsv.net'])
    expect(chipsOf('Labels never synced')).toEqual(['Promotions', 'Social'])
    const sender = byLabel('Senders never synced').querySelector('[data-chip]')
    const label = byLabel('Labels never synced').querySelector('[data-chip]')
    expect(sender?.className).toContain('mono')
    expect(label?.className).not.toContain('mono')
    expect(document.querySelector('[data-save-bar]')?.textContent).toContain(
      '0 changes',
    )
  })

  it('removes a chip as a draft, and saves it without asking', async () => {
    await mount()
    await click(byLabel('Remove mcsv.net'))
    expect(chipsOf('Senders never synced')).toEqual(['noreply@'])
    expect(document.querySelector('[data-save-bar]')?.textContent).toContain(
      '1 change',
    )
    await click(saveBarButton('Save'))
    await wait(0)
    expect(dialog()).toBeNull()
    expect(fns.saveMailboxSync).toHaveBeenCalledWith({
      data: {
        connectionId: 'conn-1',
        shareBodies: false,
        excludeSenders: ['noreply@'],
        excludeLabels: ['Promotions', 'Social'],
      },
    })
  })

  it('adds from the dashed chip’s field, and asks before saving what it adds', async () => {
    await mount()
    await click(byLabel('Add a sender'))
    const field = byLabel('Add a sender never synced')
    expect(document.activeElement).toBe(field)
    await type(field, 'acme.example, NOREPLY@')
    await key(field, 'Enter')
    // The field stays open for the next one; a held entry is not doubled.
    expect(chipsOf('Senders never synced')).toEqual([
      'noreply@',
      'mcsv.net',
      'acme.example',
    ])
    expect(field instanceof HTMLInputElement && field.value).toBe('')

    await click(byLabel('Add a label'))
    await type(byLabel('Add a label never synced'), 'Newsletters')
    await key(byLabel('Add a label never synced'), 'Enter')
    expect(chipsOf('Labels never synced')).toEqual([
      'Promotions',
      'Social',
      'Newsletters',
    ])

    await click(saveBarButton('Save'))
    await wait(0)
    expect(dialog()?.textContent).toContain(
      'Stop syncing acme.example, Newsletters?',
    )
    expect(fns.saveMailboxSync).not.toHaveBeenCalled()
    const confirm = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent.trim() === 'Save',
    )
    if (confirm === undefined) throw new Error('no Save in the confirm')
    await click(confirm)
    await wait(0)
    expect(fns.saveMailboxSync).toHaveBeenCalledWith({
      data: {
        connectionId: 'conn-1',
        shareBodies: false,
        excludeSenders: ['noreply@', 'mcsv.net', 'acme.example'],
        excludeLabels: ['Promotions', 'Social', 'Newsletters'],
      },
    })
  })

  it('drops what is typed on Esc and gives focus back to + Add', async () => {
    await mount()
    await click(byLabel('Add a label'))
    const field = byLabel('Add a label never synced')
    await type(field, 'Forums')
    await key(field, 'Escape')
    expect(chipsOf('Labels never synced')).toEqual(['Promotions', 'Social'])
    expect(document.activeElement).toBe(byLabel('Add a label'))
  })
})

describe('the mail sync lists as typed', () => {
  it('splits on commas and lines, dropping blanks', () => {
    expect(listOf(' noreply@, acme.example\n\nPromotions ,')).toEqual([
      'noreply@',
      'acme.example',
      'Promotions',
    ])
  })

  it('names what a save adds, case aside — the entries that remove mail', () => {
    expect(
      addedEntries(['noreply@', 'Promotions'], ['promotions', 'acme.example']),
    ).toEqual(['acme.example'])
    expect(addedEntries(['a.example'], [])).toEqual([])
  })
})
