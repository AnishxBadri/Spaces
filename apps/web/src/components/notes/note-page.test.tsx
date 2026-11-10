import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClockProvider } from '#/components/clock'
import { NOTE_INSET } from '#/components/editor/note-column'
import { MENU_RULE, MoreMenu, menuLayout } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { NOTE_EDGE, NoteHead, SaveWord } from './note-head'
import type { NoteData, SaveState } from './note-head'
import { NoteMoreMenu, noteMenuEntries } from './note-menu'
import { NoteRail, kindLane, noteHistory } from './note-rail'
import { NoteSheet } from './note-sheet'

/**
 * The note page as its parts draw it: the record head in each of the meta
 * line's four states, the `···` in its order, the body that is the editor
 * alone, and the rail on fixture notes — plain, private, via a tool,
 * replaced, unfiled. The moved controls run in a happy-dom `Window` on this
 * file's globals, against mocked server fns.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/notes/n1' })
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
    'HTMLTextAreaElement',
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
  setNoteKind: vi.fn(() => Promise.resolve()),
  setNoteVisibility: vi.fn(() => Promise.resolve()),
  saveNoteAsTemplate: vi.fn(() => Promise.resolve()),
  previewNoteDeletion: vi.fn(() =>
    Promise.resolve({
      title: 'Flent thesis',
      blockedReason: null,
      unlinks: [],
    }),
  ),
  deleteNote: vi.fn(() => Promise.resolve()),
  fileNoteAgainst: vi.fn(() => Promise.resolve()),
  unfileNoteFrom: vi.fn(() => Promise.resolve()),
  tagIntoSpace: vi.fn(() => Promise.resolve()),
  untagFromSpace: vi.fn(() => Promise.resolve()),
  searchEntities: vi.fn(() =>
    Promise.resolve([
      { id: 'c9', name: 'Acme', kind: 'company', objectSlug: 'companies' },
    ]),
  ),
  listTemplates: vi.fn(() => Promise.resolve([])),
}))

const nav = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
}))

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
  }),
)

vi.mock('#/lib/server-fns', () => fns)
vi.mock('sonner', () => ({ toast }))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: nav.invalidate }),
  useNavigate: () => nav.navigate,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
  }) =>
    createElement(
      'a',
      {
        href: to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? ''),
        ...rest,
      },
      children,
    ),
}))

/** The instant the page was loaded at. */
const NOW = new Date(2026, 9, 26, 12, 0).toISOString()
/** A local instant in October 2026, so the printed time is the one written. */
const oct = (day: number, h = 14, m = 2) =>
  new Date(2026, 9, day, h, m).toISOString()

function fixture(over: Partial<NoteData> = {}): NoteData {
  return {
    id: 'n1',
    title: 'Flent thesis',
    bodyJson: null,
    kind: 'note',
    author: 'Anish Badri',
    createdAt: oct(13),
    updatedAt: oct(13),
    backlinks: [],
    mentions: [],
    spaces: [],
    filedAgainst: [],
    isPrivate: false,
    isMine: true,
    replacedBy: null,
    openIn: null,
    via: null,
    ...over,
  }
}

const VIA: Partial<NoteData> = {
  author: 'Priya Raman',
  via: { tool: 'Granola', author: 'Priya Raman' },
  openIn: { provider: 'Granola', url: 'https://granola.example/n/1' },
}

const REPLACED: Partial<NoteData> = {
  replacedBy: { id: 'n2', title: 'Flent thesis v2', at: oct(20, 9, 30) },
}

const noop = () => {}

function menu(kind: NoteData['kind'] = 'note') {
  return (
    <MoreMenu
      variant="head"
      label="this note"
      forceMenu
      items={noteMenuEntries({
        kind,
        busy: false,
        onKind: noop,
        onNewVersion: noop,
        onTemplate: noop,
        onCopyLink: noop,
        onDelete: noop,
      })}
    />
  )
}

function head(note: NoteData, saveState: SaveState = 'idle'): string {
  return renderToStaticMarkup(
    <ClockProvider now={NOW}>
      <NoteHead
        note={note}
        title={note.title}
        onTitleChange={noop}
        saveState={saveState}
        menu={menu(note.kind)}
      />
    </ClockProvider>,
  )
}

/** Parse static markup into a detached host, to query it. */
function dom(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A row's cells, each its own text: `Acme | company`. */
function cells(el: Element): string {
  return [...el.children].map((c) => text(c)).join(' | ')
}

describe('the head', () => {
  function check(note: NoteData) {
    const html = head(note)
    const root = dom(html)
    const header = root.querySelector('header')
    expect(header).not.toBeNull()
    // No back link, no Edit, Share or Delete button, no Segmented.
    expect(root.querySelector('a[href="/notes"]')).toBeNull()
    for (const b of root.querySelectorAll('button'))
      expect(text(b)).not.toMatch(/^(Edit|Share|Delete)/)
    expect(html).not.toContain('radiogroup')
    // Right of the title: the save word and the ···, nothing else.
    const actions = header?.querySelector('[data-head-actions-slot]')
    expect(actions?.querySelector('[role="status"]')).not.toBeNull()
    expect(
      actions?.querySelectorAll('button').length,
      'the ··· is the only button',
    ).toBe(1)
    expect(
      actions?.querySelector('[aria-label="More for this note"]'),
    ).not.toBeNull()
    // The title is the editable name field.
    expect(
      header?.querySelector('h1 textarea[aria-label="Note title"]'),
    ).not.toBeNull()
    return root
  }

  it('written here: the NOTE stamp alone and `Anish · 13 Oct 14:02`', () => {
    const root = check(fixture())
    const stamps = root.querySelectorAll('[data-stamp]')
    expect([...stamps].map(text)).toEqual(['Note'])
    const meta = root.querySelector('[data-note-meta]')
    expect(meta?.getAttribute('data-note-meta')).toBe('written')
    expect(text(meta)).toBe('Anish Badri · 13 Oct 14:02')
  })

  it('stamps the kind: MEMO, SCRATCH', () => {
    for (const [kind, word] of [
      ['memo', 'Memo'],
      ['scratch', 'Scratch'],
    ] as const) {
      const root = check(fixture({ kind }))
      expect(text(root.querySelector('[data-stamp="live"]'))).toBe(word)
    }
  })

  it('private: a second, outlined PRIVATE stamp and `■ Only you · 13 Oct 14:02`', () => {
    const root = check(fixture({ isPrivate: true }))
    const second = root.querySelector('[data-stamp="private"]')
    expect(text(second)).toBe('Private')
    expect(second?.className.split(' ')).toEqual(
      expect.arrayContaining(['stamp', 'stamp-outline']),
    )
    // Both stamps share the stamp row above the name.
    expect(second?.parentElement?.hasAttribute('data-stamp-row')).toBe(true)
    const meta = root.querySelector('[data-note-meta]')
    expect(meta?.getAttribute('data-note-meta')).toBe('private')
    expect(text(meta)).toBe('■ Only you · 13 Oct 14:02')
  })

  it('via a tool: `via Granola · Priya Raman · 13 Oct · Open in Granola ↗`', () => {
    const root = check(fixture(VIA))
    const meta = root.querySelector('[data-note-meta]')
    expect(meta?.getAttribute('data-note-meta')).toBe('via')
    expect(text(meta)).toBe(
      'via Granola · Priya Raman · 13 Oct · Open in Granola ↗',
    )
    expect(meta?.querySelector('a')?.getAttribute('href')).toBe(
      'https://granola.example/n/1',
    )
  })

  it('replaced: the title dims and the line ends on a link to the newer note', () => {
    const root = check(fixture(REPLACED))
    const meta = root.querySelector('[data-note-meta]')
    expect(meta?.getAttribute('data-note-meta')).toBe('replaced')
    expect(text(meta)).toBe('Anish Badri · 13 Oct 14:02 → Flent thesis v2 ›')
    expect(meta?.querySelector('a')?.getAttribute('href')).toBe('/notes/n2')
    expect(root.querySelector('h1')?.className).toContain('text-graphite')
    // No "Replaced by →" paragraph of its own.
    expect(text(root)).not.toContain('Replaced by')
  })

  it('says the save state in mono, and nothing before the first edit', () => {
    const word = (s: SaveState) =>
      text(dom(renderToStaticMarkup(<SaveWord state={s} />)))
    expect(word('idle')).toBe('')
    expect(word('dirty')).toBe('Unsaved changes')
    expect(word('saving')).toBe('Saving…')
    expect(word('saved')).toBe('Saved')
    expect(renderToStaticMarkup(<SaveWord state="saved" />)).toMatch(
      /class="mono[^"]*" role="status"/,
    )
  })
})

describe('the body', () => {
  function sheet(): HTMLElement {
    const note = fixture({
      filedAgainst: [
        {
          id: 'c1',
          name: 'Flent',
          kind: 'company',
          objectSlug: 'companies',
          objectLabel: 'Company',
        },
      ],
    })
    return dom(
      renderToStaticMarkup(
        <ClockProvider now={NOW}>
          <NoteSheet
            head={
              <NoteHead
                note={note}
                title={note.title}
                onTitleChange={noop}
                saveState="idle"
                menu={menu()}
              />
            }
            editor={<div data-editor />}
            rail={<aside data-rail />}
          />
        </ClockProvider>,
      ),
    )
  }

  it('renders nothing between the title field and the editor', () => {
    const root = sheet()
    const body = root.querySelector('[data-note-body]')
    // The body column is the editor's wrapper, and the wrapper the editor.
    expect(body?.children).toHaveLength(1)
    expect(body?.firstElementChild?.className).toBe('prose-note')
    expect(body?.firstElementChild?.children).toHaveLength(1)
    expect(body?.querySelector('[data-editor]')).not.toBeNull()
    // The head holds the title, its meta line and the actions: no filing.
    const header = root.querySelector('header')
    expect(text(header)).not.toMatch(/Filed|Flent\b(?! thesis)/)
    expect(header?.querySelector('[data-chip]')).toBeNull()
  })

  it('starts the head and the body on one left edge, the note inset', () => {
    const root = sheet()
    expect(NOTE_EDGE).toBe(NOTE_INSET)
    const headClasses = root.querySelector('header')?.className.split(' ')
    const bodyClasses = root
      .querySelector('[data-note-body]')
      ?.className.split(' ')
    expect(headClasses).toContain(NOTE_INSET)
    expect(bodyClasses).toContain(NOTE_INSET)
    // Nothing after it moves the head's left edge back.
    const after = headClasses?.slice(headClasses.indexOf(NOTE_INSET) + 1)
    expect(after?.some((c) => /^(pl|px|ps)-/.test(c))).toBe(false)
  })
})

describe('prose-note', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../styles.css', import.meta.url)),
    'utf8',
  )
  /**
   * The body of the top-level rule whose selector is exactly `selector`,
   * not the last line of a selector list that ends in it.
   */
  function rule(selector: string): string {
    const opener = `${selector} {`
    let at = css.indexOf(`\n${opener}`)
    while (at > -1 && css[at - 1] === ',')
      at = css.indexOf(`\n${opener}`, at + 1)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('\n}', at))
  }

  it('steps its headings 20 / 17 / 15, sans medium, under the 28px serif title', () => {
    expect(rule('.prose-note .bn-editor h1')).toMatch(/font-size: 1\.25rem;/)
    expect(rule('.prose-note .bn-editor h2')).toMatch(/font-size: 1\.0625rem;/)
    expect(rule('.prose-note .bn-editor h3')).toMatch(/font-size: 0\.9375rem;/)
    const shared = rule(
      '.prose-note .bn-editor h1,\n.prose-note .bn-editor h2,\n.prose-note .bn-editor h3',
    )
    expect(shared).toMatch(/font-family: var\(--font-sans\);/)
    expect(shared).toMatch(/font-weight: 500;/)
    expect(rule('.prose-note .bn-editor')).toMatch(/font-size: 1\.0625rem;/)
    const title = css.slice(css.indexOf('@utility title-serif {'))
    expect(title.slice(0, title.indexOf('}'))).toMatch(/font-size: 1\.75rem;/)
  })
})

describe('the ··· entries', () => {
  const label = (e: MoreMenuEntry) =>
    e === MENU_RULE ? '—' : 'group' in e ? `[${e.group}]` : e.label

  it('runs KIND, a rule, the three verbs, a rule, Delete…', () => {
    const entries = noteMenuEntries({
      kind: 'memo',
      busy: false,
      onKind: noop,
      onNewVersion: noop,
      onTemplate: noop,
      onCopyLink: noop,
      onDelete: noop,
    })
    expect(menuLayout(entries).map(label)).toEqual([
      '[Kind]',
      'Note',
      'Memo',
      'Scratch',
      '—',
      'Save as new version',
      'Save as template…',
      'Copy link',
      '—',
      'Delete…',
    ])
    const checked = entries.flatMap((e) =>
      e !== MENU_RULE && 'checked' in e && e.checked ? [e.label] : [],
    )
    expect(checked).toEqual(['Memo'])
  })

  it('changes the kind on a row other than the checked one', () => {
    const onKind = vi.fn()
    const entries = noteMenuEntries({
      kind: 'note',
      busy: false,
      onKind,
      onNewVersion: noop,
      onTemplate: noop,
      onCopyLink: noop,
      onDelete: noop,
    })
    for (const e of entries)
      if (e !== MENU_RULE && 'checked' in e) e.onCheckedChange(true)
    expect(onKind.mock.calls).toEqual([['memo'], ['scratch']])
  })
})

let mounted: Root | null = null

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockClear()
  nav.navigate.mockClear()
  nav.invalidate.mockClear()
  toast.success.mockClear()
})

afterEach(() => {
  act(() => mounted?.unmount())
  mounted = null
  document.body.replaceChildren()
})

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  mounted = createRoot(host)
  act(() => mounted?.render(<ClockProvider now={NOW}>{node}</ClockProvider>))
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the ··· menu', () => {
  async function open() {
    const trigger = document.querySelector('[aria-label="More for this note"]')
    if (trigger === null) throw new Error('no ··· trigger')
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await settle()
  }

  function item(name: string): Element | undefined {
    return [
      ...document.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ),
    ].find((el) => text(el) === name)
  }

  const saveNewVersion = vi.fn(() => Promise.resolve('n2'))

  function mountMenu(kind: NoteData['kind'] = 'note') {
    mount(
      <NoteMoreMenu
        noteId="n1"
        title="Flent thesis"
        kind={kind}
        saveNewVersion={saveNewVersion}
      />,
    )
  }

  it('draws its rows in order, the current kind checked', async () => {
    mountMenu('scratch')
    await open()
    const menuEl = document.querySelector('[role="menu"]')
    const rows = [...(menuEl?.children ?? [])].map((el) =>
      el.getAttribute('role') === 'separator' ? '—' : text(el),
    )
    expect(rows).toEqual([
      'Kind',
      'Note',
      'Memo',
      'Scratch',
      '—',
      'Save as new version',
      'Save as template…',
      'Copy link',
      '—',
      'Delete…',
    ])
    expect(item('Scratch')?.getAttribute('aria-checked')).toBe('true')
    expect(item('Note')?.getAttribute('aria-checked')).toBe('false')
  })

  it('changes the kind through setNoteKind', async () => {
    mountMenu('note')
    await open()
    click(item('Memo'))
    await settle()
    expect(fns.setNoteKind).toHaveBeenCalledWith({
      data: { id: 'n1', kind: 'memo' },
    })
    expect(nav.invalidate).toHaveBeenCalled()
  })

  it('saves a new version through the page, and opens it', async () => {
    mountMenu()
    await open()
    click(item('Save as new version'))
    await settle()
    expect(saveNewVersion).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('New version saved')
    expect(nav.navigate).toHaveBeenCalledWith({
      to: '/notes/$noteId',
      params: { noteId: 'n2' },
    })
  })

  it('copies the page URL and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    mountMenu()
    await open()
    click(item('Copy link'))
    await settle()
    expect(writeText).toHaveBeenCalledWith('http://localhost/notes/n1')
    expect(toast.success).toHaveBeenCalledWith('Link copied')
  })

  it('opens Save as template… and saves through saveNoteAsTemplate', async () => {
    mountMenu()
    await open()
    click(item('Save as template…'))
    await settle(50)
    const form = document.querySelector('[role="dialog"] form')
    expect(form).not.toBeNull()
    act(() => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    await settle()
    expect(fns.saveNoteAsTemplate).toHaveBeenCalledWith({
      data: { noteId: 'n1', name: 'Flent thesis' },
    })
  })

  it('deletes through the confirm, then leaves for the list', async () => {
    mountMenu()
    await open()
    click(item('Delete…'))
    await settle(50)
    expect(fns.previewNoteDeletion).toHaveBeenCalledWith({
      data: { id: 'n1' },
    })
    const confirmButton = [
      ...document.querySelectorAll(
        '[role="alertdialog"] button, [role="dialog"] button',
      ),
    ].find((b) => text(b) === 'Delete')
    click(confirmButton)
    await settle()
    expect(fns.deleteNote).toHaveBeenCalledWith({ data: { id: 'n1' } })
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/notes' })
  })
})

const FLENT = {
  id: 'c1',
  name: 'Flent',
  kind: 'company' as const,
  objectSlug: 'companies',
  objectLabel: 'Company',
}
const FUND = {
  id: 'f1',
  name: 'Seed Fund II',
  kind: 'custom' as const,
  objectSlug: 'funds',
  objectLabel: 'Fund',
}
const FINTECH = { id: 's1', name: 'Fintech', archived: false }
const SPACES = [
  { id: 's1', name: 'Fintech', parentId: null, companies: 4 },
  { id: 's2', name: 'Payments', parentId: 's1', companies: 2 },
]

function rail(note: NoteData): HTMLElement {
  return dom(
    renderToStaticMarkup(
      <ClockProvider now={NOW}>
        <NoteRail note={note} allSpaces={SPACES} onPreview={noop} />
      </ClockProvider>,
    ),
  )
}

/** A rail section's head and its rows' text. */
function section(host: HTMLElement, name: string) {
  const body = host.querySelector(`[data-rail-section="${name}"]`)
  if (body === null) return null
  return {
    head: text(body.parentElement?.querySelector('h2')),
    rows: [...body.children].map(cells),
  }
}

describe('the rail', () => {
  it('FILED ON: records then spaces, each with its kind lane, ending + File on…', () => {
    const filedRail = rail(
      fixture({ filedAgainst: [FLENT, FUND], spaces: [FINTECH] }),
    )
    const filed = section(filedRail, 'filed-on')
    expect(filed?.head).toBe('Filed on · 3')
    expect(filed?.rows).toEqual([
      'Flent | company×',
      'Seed Fund II | fund×',
      'Fintech | space×',
      '+ | File on…',
    ])
    expect(
      filedRail
        .querySelector('[data-rail-section="filed-on"] a')
        ?.getAttribute('href'),
    ).toBe('/companies/c1')
    expect(filedRail.querySelector('a[href="/o/funds/f1"]')).not.toBeNull()
    expect(filedRail.querySelector('a[href="/spaces/s1"]')).not.toBeNull()
    expect(kindLane({ kind: 'space' })).toBe('space')
  })

  it('FILED ON with nothing filed: Not filed, then + File on…', () => {
    const filed = section(rail(fixture()), 'filed-on')
    expect(filed?.head).toBe('Filed on')
    expect(filed?.rows).toEqual(['Not filed | ', '+ | File on…'])
  })

  it('MENTIONS and MENTIONED IN only when they hold something', () => {
    const plain = rail(fixture())
    expect(section(plain, 'mentions')).toBeNull()
    expect(section(plain, 'mentioned-in')).toBeNull()
    const linked = rail(
      fixture({
        mentions: [FLENT],
        backlinks: [{ fromId: 'n9', name: 'IC prep', kind: 'note' }],
      }),
    )
    expect(section(linked, 'mentions')).toEqual({
      head: 'Mentions · 1',
      rows: ['Flent | company'],
    })
    expect(section(linked, 'mentioned-in')).toEqual({
      head: 'Mentioned in · 1',
      rows: ['IC prep | note'],
    })
    expect(linked.querySelector('a[href="/notes/n9"]')).not.toBeNull()
  })

  it('VISIBILITY: the switch for the author alone; private reads Only you', () => {
    const mine = rail(fixture())
    const sw = mine.querySelector(
      '[data-rail-section="visibility"] [role="switch"]',
    )
    expect(sw?.getAttribute('aria-checked')).toBe('true')
    expect(text(sw)).toBe('Shared with the workspace')
    const theirs = rail(fixture({ isMine: false }))
    expect(theirs.querySelector('[role="switch"]')).toBeNull()
    expect(text(theirs.querySelector('[data-rail-section="visibility"]'))).toBe(
      'Shared with the workspace',
    )
    const secret = rail(fixture({ isPrivate: true }))
    expect(
      secret
        .querySelector('[data-rail-section="visibility"] [role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false')
    expect(text(secret.querySelector('[data-rail-section="visibility"]'))).toBe(
      'Only you',
    )
  })

  it('HISTORY: exactly the rows the data supports, newest first', () => {
    const history = (note: NoteData) => section(rail(note), 'history')?.rows
    expect(history(fixture())).toEqual(['Written | 13 Oct · Anish Badri'])
    expect(history(fixture({ isPrivate: true }))).toEqual([
      'Written | 13 Oct · Anish Badri',
    ])
    // Saved inside the first minute is the writing, not an edit.
    expect(history(fixture({ updatedAt: oct(13, 14, 2) }))).toHaveLength(1)
    expect(history(fixture({ updatedAt: oct(15, 10, 0) }))).toEqual([
      'Edited | 15 Oct',
      'Written | 13 Oct · Anish Badri',
    ])
    expect(history(fixture(VIA))).toEqual([
      'Landed from Granola | 13 Oct · Priya Raman',
      'Written | 13 Oct · Priya Raman',
    ])
    expect(
      history(fixture({ ...REPLACED, updatedAt: oct(15, 10, 0) })),
    ).toEqual([
      'Replaced by Flent thesis v2 | 20 Oct',
      'Edited | 15 Oct',
      'Written | 13 Oct · Anish Badri',
    ])
    // No kind change is logged, so none is shown.
    expect(noteHistory(fixture({ kind: 'memo' })).map((h) => h.event)).toEqual([
      'Written',
    ])
  })
})

describe('the rail’s controls', () => {
  function mountRail(note: NoteData) {
    mount(<NoteRail note={note} allSpaces={SPACES} onPreview={noop} />)
  }

  it('unfiles a record through unfileNoteFrom', async () => {
    mountRail(fixture({ filedAgainst: [FLENT] }))
    click(document.querySelector('[aria-label="Unfile from Flent"]'))
    await settle()
    expect(fns.unfileNoteFrom).toHaveBeenCalledWith({
      data: { id: 'n1', targetId: 'c1' },
    })
    expect(nav.invalidate).toHaveBeenCalled()
  })

  it('unfiles a space through untagFromSpace', async () => {
    mountRail(fixture({ spaces: [FINTECH] }))
    click(document.querySelector('[aria-label="Unfile from Fintech"]'))
    await settle()
    expect(fns.untagFromSpace).toHaveBeenCalledWith({
      data: { entityId: 'n1', spaceId: 's1' },
    })
  })

  it('files on a space from + File on…, offered before anything is typed', async () => {
    mountRail(fixture({ spaces: [FINTECH] }))
    const add = [...document.querySelectorAll('button')].find(
      (b) => text(b) === '+File on…',
    )
    click(add)
    await settle(200)
    const options = [...document.querySelectorAll('[role="option"]')]
    // Fintech is already filed; its child is offered by its path.
    expect(options.map(cells)).toEqual(['Fintech › Payments | space'])
    act(() => {
      options[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await settle()
    expect(fns.tagIntoSpace).toHaveBeenCalledWith({
      data: { entityId: 'n1', spaceId: 's2' },
    })
    expect(fns.searchEntities).not.toHaveBeenCalled()
  })

  it('files on a record found by search from the same picker', async () => {
    mountRail(fixture())
    const add = [...document.querySelectorAll('button')].find(
      (b) => text(b) === '+File on…',
    )
    click(add)
    await settle()
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="File on a record or space"]',
    )
    if (input === null) throw new Error('no picker field')
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'acme')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(200)
    expect(fns.searchEntities).toHaveBeenCalledWith({
      data: { q: 'acme', kinds: ['company', 'person', 'deal', 'custom'] },
    })
    const acme = [...document.querySelectorAll('[role="option"]')].find(
      (o) => cells(o) === 'Acme | company',
    )
    act(() => {
      acme?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await settle()
    expect(fns.fileNoteAgainst).toHaveBeenCalledWith({
      data: { id: 'n1', targetId: 'c9' },
    })
  })

  it('makes the note private from the switch, for its author', async () => {
    mountRail(fixture())
    click(document.querySelector('[role="switch"]'))
    await settle()
    expect(fns.setNoteVisibility).toHaveBeenCalledWith({
      data: { id: 'n1', visibility: 'private' },
    })
    expect(
      text(document.querySelector('[data-rail-section="visibility"]')),
    ).toBe('Only you')
  })
})
