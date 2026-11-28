import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClockProvider } from '#/components/clock'
import type { NoteData } from './note-head'
import {
  NoteWindow,
  noteWindowLine,
  noteWindowPeople,
  windowSaveState,
} from './note-window'
import type { NoteWindowData } from './note-window'

/**
 * A note's window over a record: the head (mark, title, people and day),
 * the foot's words, the editor's floating menus mounted inside the sheet,
 * a stale link's one line, the rule that Done, Esc, Open as page and a
 * confirmed leave land the last edit before the window lets go, and what it
 * shares with the note page: a file chip's viewer and a dropped file. Radix
 * runs in happy-dom; the editor is a stub that hands back its props.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/companies/c1' })
  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'getComputedStyle',
  ])
    Reflect.set(globalThis, key, Reflect.get(win, key))
  // Radix's focus scope, portal and dismissable layer reach for the DOM's
  // classes by name.
  for (const name of Object.getOwnPropertyNames(win))
    if (/^[A-Z]/.test(name) && !(name in globalThis))
      Reflect.set(globalThis, name, Reflect.get(win, name))
  for (const name of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent'])
    Reflect.set(globalThis, name, Reflect.get(win, name))
  Reflect.set(globalThis, 'requestAnimationFrame', (cb: () => void) =>
    setTimeout(cb, 0),
  )
  Reflect.set(globalThis, 'cancelAnimationFrame', (id: number) =>
    clearTimeout(id),
  )
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

const fns = vi.hoisted(() => ({
  getNoteWindow: vi.fn(
    (_: { data: { id: string } }): Promise<NoteWindowData | null> =>
      Promise.resolve(null),
  ),
  listTermsForNote: vi.fn(() => Promise.resolve([])),
  saveNote: vi.fn((_: unknown) => Promise.resolve()),
  setNoteKind: vi.fn(() => Promise.resolve()),
  noteWindowClosed: vi.fn(() => Promise.resolve({ queued: false })),
}))

const upload = vi.hoisted(() => ({
  uploadDocument: vi.fn(
    (_: {
      file: File
      fileAgainst: Array<{ kind: 'space'; entityId: string }>
    }): Promise<{ id: string }> => Promise.resolve({ id: 'd9' }),
  ),
}))

/** What the note registered with the router's blocker. */
const blocker = vi.hoisted(
  (): {
    shouldBlockFn:
      | ((args: {
          current: { pathname: string }
          next: { pathname: string }
        }) => boolean | Promise<boolean>)
      | null
  } => ({ shouldBlockFn: null }),
)

/** The editor stub's last props: its change callback and portal root. */
const editor = vi.hoisted(
  (): {
    onChange: ((snap: unknown) => void) | null
    onFileDrop: ((file: File) => Promise<unknown>) | null
    portalRoot: HTMLElement | null
  } => ({ onChange: null, onFileDrop: null, portalRoot: null }),
)

vi.mock('#/lib/server-fns', () => fns)
vi.mock('#/lib/documents/upload', () => upload)
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    loading: vi.fn(() => 't1'),
    success: vi.fn(),
    message: vi.fn(),
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => ({}),
  useBlocker: (opts: { shouldBlockFn: typeof blocker.shouldBlockFn }) => {
    blocker.shouldBlockFn = opts.shouldBlockFn
  },
}))
vi.mock('#/components/editor/note-editor', () => ({
  NoteEditor: (props: {
    onChange: (snap: unknown) => void
    onFileDrop?: (file: File) => Promise<unknown>
    portalRoot?: HTMLElement
  }) => {
    editor.onChange = props.onChange
    editor.onFileDrop = props.onFileDrop ?? null
    editor.portalRoot = props.portalRoot ?? null
    return <div data-editor-stub />
  },
  deriveMarkdown: (md: string) => md,
  extractMentionIds: () => [],
}))

const NOW = new Date(2026, 9, 26, 12, 0).toISOString()
const oct = (day: number) => new Date(2026, 9, day, 14, 2).toISOString()

function note(over: Partial<NoteData> = {}): NoteData {
  return {
    id: 'n1',
    title: 'Founder call',
    bodyJson: null,
    kind: 'note',
    author: 'Sam Lee',
    createdAt: oct(11),
    updatedAt: oct(11),
    backlinks: [],
    mentions: [],
    spaces: [],
    filedAgainst: [],
    isPrivate: false,
    isMine: false,
    replacedBy: null,
    openIn: null,
    via: null,
    ...over,
  }
}

const data = (
  over: Partial<NoteData> = {},
  attendees: Array<string> = [],
): NoteWindowData => ({ note: note(over), attendees })

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(async () => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  editor.onChange = null
  editor.onFileDrop = null
  editor.portalRoot = null
  blocker.shouldBlockFn = null
  // An unmount with an edit pending still saves it; let that land first.
  await new Promise((resolve) => setTimeout(resolve, 10))
  fns.getNoteWindow.mockReset()
  fns.saveNote.mockReset()
  fns.saveNote.mockImplementation(() => Promise.resolve())
  upload.uploadDocument.mockClear()
  Reflect.deleteProperty(window, 'confirm')
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function open(found: NoteWindowData | null) {
  fns.getNoteWindow.mockImplementation(() => Promise.resolve(found))
  const onClose = vi.fn()
  const onOpenPage = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() =>
    r.render(
      <ClockProvider now={NOW}>
        <NoteWindow id="n1" onClose={onClose} onOpenPage={onOpenPage} />
      </ClockProvider>,
    ),
  )
  await flush()
  await flush()
  return { onClose, onOpenPage }
}

const sheet = () => document.querySelector('[data-note-window]')
const part = (name: string) =>
  document.querySelector(`[data-note-window-${name}]`)

const button = (label: RegExp): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent.trim()),
  )
  if (found === undefined) throw new Error(`no button ${label.source}`)
  return found
}

const click = async (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** An edit the editor reports, still inside the autosave's debounce. */
const type = () =>
  act(() => {
    editor.onChange?.({ document: [], blocksToMarkdownLossy: () => '' })
  })

describe('the head', () => {
  it('names a meeting note’s attendees, else the author, and never the viewer', () => {
    expect(noteWindowPeople(data({}, ['Priya Raman', 'Dev Shah']))).toEqual([
      'Priya Raman',
      'Dev Shah',
    ])
    expect(noteWindowPeople(data())).toEqual(['Sam Lee'])
    expect(noteWindowPeople(data({ isMine: true }))).toEqual([])
    const today = NOW.slice(0, 10)
    expect(noteWindowLine(data({}, ['Priya Raman', 'Dev Shah']), today)).toBe(
      'Priya Raman, Dev Shah · 11 Oct',
    )
    expect(noteWindowLine(data({ isMine: true }), today)).toBe('11 Oct')
  })

  it('leads on the kind icon, then the title as a field, then the people and the day', async () => {
    await open(data({}, ['Priya Raman', 'Dev Shah']))
    const head = part('head')
    expect(
      head?.querySelector('[data-note-window-mark] [data-note-kind="note"]'),
    ).not.toBeNull()
    expect(
      head?.querySelector('[data-note-kind]')?.getAttribute('class'),
    ).toContain('size-5')
    const title = head?.querySelector('input')
    expect(title?.value).toBe('Founder call')
    expect(title?.getAttribute('placeholder')).toBe('Untitled')
    expect(part('people')?.textContent).toBe('Priya Raman, Dev Shah · 11 Oct')
    // The kind is the mark, never a word in the head.
    expect(head?.textContent).not.toMatch(/\b(Note|Memo)\b/)
  })

  it('leads a recorder’s note on the recorder’s logo, in the same slot', async () => {
    await open(data({ via: { tool: 'Granola', author: 'Sam Lee' } }))
    const mark = part('mark')
    expect(
      mark
        ?.querySelector('[data-provider-mark]')
        ?.getAttribute('data-provider-mark'),
    ).toBe('granola')
    expect(mark?.querySelector('[data-note-kind]')).toBeNull()
  })

  it('puts the caret in the title of a note with none', async () => {
    await open(data({ title: '' }))
    expect(document.activeElement).toBe(part('head')?.querySelector('input'))
  })
})

describe('the foot', () => {
  it('reads Saved from the start, then Open as page ↗ and Done; no Cancel', async () => {
    await open(data())
    const foot = part('foot')
    expect(foot?.textContent).toBe('SavedOpen as page ↗Done')
    expect(foot?.textContent).not.toContain('Only you')
    expect(foot?.textContent).not.toContain('Cancel')
    expect(windowSaveState('idle')).toBe('saved')
    expect(windowSaveState('failed')).toBe('failed')
  })

  it('says Only you beside it only while the note is private', async () => {
    await open(data({ isPrivate: true, isMine: true }))
    expect(part('foot')?.querySelector('[data-only-you]')?.textContent).toBe(
      'Only you',
    )
  })
})

describe('the body', () => {
  it('mounts the editor’s floating menus inside the sheet, outside the scroller, under .prose-note', async () => {
    await open(data())
    const portal = editor.portalRoot
    if (portal === null) throw new Error('no portal root')
    expect(portal.getAttribute('data-note-window-portal')).not.toBeNull()
    expect(sheet()?.contains(portal)).toBe(true)
    expect(part('body')?.contains(portal)).toBe(false)
    expect(portal.className).toBe('prose-note')
    expect(
      part('body')?.querySelector('.prose-note [data-editor-stub]'),
    ).not.toBeNull()
  })
})

describe('closing', () => {
  it('lands the last edit before Done closes', async () => {
    const { onClose } = await open(data())
    type()
    await click(button(/^Done$/))
    expect(fns.saveNote).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(fns.saveNote.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0],
    )
  })

  it('lands the last edit before Esc closes', async () => {
    const { onClose } = await open(data())
    type()
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await flush()
    expect(fns.saveNote).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stays open on Not saved · Retry when that save fails', async () => {
    fns.saveNote.mockImplementation(() => Promise.reject(new Error('down')))
    const { onClose } = await open(data())
    type()
    await click(button(/^Done$/))
    expect(onClose).not.toHaveBeenCalled()
    expect(sheet()).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Not saved · Retry',
    )
  })

  it('opens the page only once the edit has landed', async () => {
    const { onOpenPage } = await open(data())
    type()
    await click(button(/^Open as page ↗$/))
    expect(fns.saveNote).toHaveBeenCalledOnce()
    expect(onOpenPage).toHaveBeenCalledOnce()
  })

  it('still lands the last edit when Back takes the window away', async () => {
    const { onClose } = await open(data())
    type()
    act(() =>
      root?.render(
        <ClockProvider now={NOW}>
          <NoteWindow id={null} onClose={onClose} onOpenPage={() => {}} />
        </ClockProvider>,
      ),
    )
    await flush()
    expect(sheet()).toBeNull()
    expect(fns.saveNote).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes at once with nothing to save', async () => {
    const { onClose } = await open(data())
    await click(button(/^Done$/))
    expect(fns.saveNote).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

/** The browser's leave confirm, answered. */
function answer(yes: boolean) {
  const confirm = vi.fn(() => yes)
  Reflect.set(window, 'confirm', confirm)
  return confirm
}

describe('leaving the record', () => {
  const away = {
    current: { pathname: '/companies/c1' },
    next: { pathname: '/today' },
  }

  it('lands an edit still inside the debounce once leaving is confirmed', async () => {
    const confirm = answer(true)
    await open(data())
    type()
    const shouldBlock = blocker.shouldBlockFn
    if (shouldBlock === null) throw new Error('no blocker')
    let blocked: boolean | null = null
    await act(async () => {
      blocked = await shouldBlock(away)
    })
    expect(confirm).toHaveBeenCalledOnce()
    // The save ran before the navigation was let through, not after.
    expect(fns.saveNote).toHaveBeenCalledOnce()
    expect(blocked).toBe(false)
  })

  it('stays, saving nothing yet, when leaving is refused', async () => {
    answer(false)
    await open(data())
    type()
    const shouldBlock = blocker.shouldBlockFn
    if (shouldBlock === null) throw new Error('no blocker')
    expect(await shouldBlock(away)).toBe(true)
    expect(fns.saveNote).not.toHaveBeenCalled()
  })

  it('never asks for a change on the same page, or with nothing to save', async () => {
    const confirm = answer(true)
    await open(data())
    const shouldBlock = blocker.shouldBlockFn
    if (shouldBlock === null) throw new Error('no blocker')
    expect(await shouldBlock(away)).toBe(false)
    type()
    expect(
      await shouldBlock({ current: away.current, next: away.current }),
    ).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('files', () => {
  it('files a dropped file where the note is filed and hands the editor its chip', async () => {
    await open(
      data({
        spaces: [
          { id: 's1', name: 'Fund II', archived: false },
          { id: 's2', name: 'Climate', archived: false },
        ],
      }),
    )
    const drop = editor.onFileDrop
    if (drop === null) throw new Error('the window took no drops')
    const file = new File(['%PDF'], 'Flent deck.pdf')
    let dropped: unknown = null
    await act(async () => {
      dropped = await drop(file)
    })
    expect(upload.uploadDocument).toHaveBeenCalledOnce()
    expect(upload.uploadDocument.mock.calls.at(0)?.[0]).toMatchObject({
      file,
      fileAgainst: [
        { kind: 'space', entityId: 's1' },
        { kind: 'space', entityId: 's2' },
      ],
    })
    expect(dropped).toEqual({ entityId: 'd9', label: 'Flent deck.pdf' })
  })
})

describe('a stale link', () => {
  it('says so in one line, with Done', async () => {
    const { onClose } = await open(null)
    expect(
      document.querySelector('[data-note-window-state="gone"]')?.textContent,
    ).toBe('It was deleted, or the link is wrong.')
    expect(part('foot')?.textContent).toBe('Done')
    await click(button(/^Done$/))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
