import { Window } from 'happy-dom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type * as CmdkModule from 'cmdk'
import type * as PaletteModule from './command-palette'
import type * as PageActionsModule from '#/lib/page-actions'
import type * as HotkeyModule from '#/lib/use-hotkey'
import type { PageAction, StepChoice } from '#/lib/page-actions'
import type { Passage } from '#/lib/search/passages'
import type {
  ObjectPreview,
  PassagePreview,
  RecordPreview,
} from '#/lib/search/preview'
import type { SearchHit } from '#/lib/search/query'
import type { PreviewLoaders } from './palette-preview'

/**
 * The palette as D70 draws it, mounted on a happy-dom `Window`: the input,
 * the four groups in order, the second wave's running head, the record's
 * verbs, the step with its mode label, and the foot. `PaletteBody` is what
 * the window holds; the searches are stubs the test answers by hand.
 */

const win = new Window({ url: 'http://localhost/' })
let createRoot: typeof CreateRoot
let palette: typeof PaletteModule
let pageActions: typeof PageActionsModule
let hotkey: typeof HotkeyModule
let cmdk: typeof CmdkModule

beforeAll(async () => {
  vi.stubGlobal('window', win)
  vi.stubGlobal('self', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('HTMLInputElement', win.HTMLInputElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('MouseEvent', win.MouseEvent)
  vi.stubGlobal('KeyboardEvent', win.KeyboardEvent)
  vi.stubGlobal('Event', win.Event)
  vi.stubGlobal('ResizeObserver', win.ResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  cmdk = await import('cmdk')
  palette = await import('./command-palette')
  pageActions = await import('#/lib/page-actions')
  hotkey = await import('#/lib/use-hotkey')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await win.happyDOM.close()
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** A promise the test resolves by hand. */
function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const company = (id: string, name: string): SearchHit => ({
  rowKind: 'entity',
  id,
  kind: 'company',
  name,
  objectSlug: 'companies',
  snippet: null,
  matchedIn: 'name',
  parent: null,
  task: null,
})

const HALCYON = company('c-halcyon', 'Halcyon Grid')
const HALDANE = company('c-haldane', 'Haldane Robotics')

/** The deck the semantic lane would rank first — a passage, never a record. */
const DECK: Passage = {
  id: 'd-deck',
  kind: 'document',
  name: 'Grid storage memo.pdf',
  objectSlug: null,
  snippet: 'halcyon-class storage at grid scale',
  page: 4,
  parent: {
    id: 'c-halcyon',
    kind: 'company',
    name: 'Halcyon Grid',
    objectSlug: null,
  },
}

const dealVerbs = (onMove: () => void): Array<PageAction> => [
  { id: 'move-stage', label: 'Move stage', key: 'M', run: onMove },
  { id: 'log', label: 'Log interaction', key: 'L', run: () => {} },
  { id: 'hallmark', label: 'Hallmark this deal', run: () => {} },
]

type Mount = {
  pageActions?: ReadonlyArray<PageAction>
  records?: (q: string) => Promise<ReadonlyArray<SearchHit>>
  passages?: (q: string) => Promise<ReadonlyArray<Passage>>
  onRun?: (a: PageAction) => void
  onStepDone?: () => void
  loaders?: Partial<PreviewLoaders>
  onOpenFile?: (id: string, page: number | null) => void
  onGo?: (href: string) => void
}

const NO_LOADERS: PreviewLoaders = {
  record: () => new Promise(() => {}),
  object: () => new Promise(() => {}),
  passage: () => new Promise(() => {}),
}

function mount({
  pageActions: verbs = [],
  records = async () => [],
  passages = async () => [],
  onRun = () => {},
  onStepDone = () => {},
  loaders = {},
  onOpenFile = () => {},
  onGo = () => {},
}: Mount = {}) {
  const { Command } = cmdk
  const { PaletteBody, jumpTargets } = palette
  act(() =>
    root.render(
      <Command shouldFilter={false}>
        <PaletteBody
          pageActions={verbs}
          extraActions={pageActions.GLOBAL_ACTIONS}
          jump={jumpTargets(
            [],
            [
              {
                id: 'v1',
                name: 'Halcyon pipeline',
                path: '/deals',
                objectPlural: 'Deals',
              },
            ],
          )}
          searchRecords={records}
          searchPassages={passages}
          onGo={onGo}
          onTask={() => {}}
          onRun={onRun}
          onStepDone={onStepDone}
          loaders={{ ...NO_LOADERS, ...loaders }}
          onOpenFile={onOpenFile}
        />
      </Command>,
    ),
  )
}

const input = () => {
  const el = host.querySelector('input')
  if (!el) throw new Error('no input')
  return el
}

function type(value: string) {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    'value',
  )?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string) {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const groups = () =>
  [...host.querySelectorAll('[data-group]')].map((g) =>
    g.getAttribute('data-group'),
  )
const rowsIn = (group: string) =>
  [...host.querySelectorAll(`[data-group="${group}"] [cmdk-item]`)].map(
    (r) => r.textContent,
  )
const modeLabel = () => host.querySelector('[data-mode]')?.textContent

function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the palette, nothing typed', () => {
  it('on a page with no verbs shows only the input — no group, no recent items, no empty line', () => {
    mount()
    expect(groups()).toEqual([])
    expect(host.textContent).not.toContain('Nothing found')
    expect(input().placeholder).toBe('Find a record, a page, an action')
  })

  it("on a record lists that record's verbs only, with their printed keys", () => {
    mount({ pageActions: dealVerbs(() => {}) })
    expect(groups()).toEqual(['actions'])
    expect(rowsIn('actions')).toEqual([
      'Move stageM',
      'Log interactionL',
      'Hallmark this deal',
    ])
    // The global verbs wait for a typed word.
    expect(host.textContent).not.toContain('Upload a file')
  })
})

describe('the palette, typed', () => {
  it('draws Jump to, Actions, Records, then Passages a beat later, under a running head while it looks', async () => {
    const lane = deferred<ReadonlyArray<Passage>>()
    const asked: Array<string> = []
    mount({
      pageActions: dealVerbs(() => {}),
      records: async (q) => {
        asked.push(q)
        return [HALCYON, HALDANE]
      },
      passages: () => lane.promise,
    })

    type('hal')
    // Local groups answer at once; Records waits for the pause.
    expect(groups()).toEqual(['jump', 'actions'])
    expect(rowsIn('jump')).toEqual(['Halcyon pipelineview · Deals'])
    expect(rowsIn('actions')).toEqual(['Hallmark this deal'])

    await wait(180)
    expect(asked).toEqual(['hal'])
    expect(groups()).toEqual(['jump', 'actions', 'records'])
    expect(rowsIn('records').at(0)).toContain('Halcyon Grid')

    await wait(420)
    // The second wave is out: its head runs, with no spinner row under it.
    expect(groups()).toEqual(['jump', 'actions', 'records', 'passages'])
    const head = host.querySelector('[data-group="passages"]')
    expect(head?.querySelector('[data-running]')?.textContent).toBe(
      'still looking.',
    )
    expect(rowsIn('passages')).toEqual([])

    await act(async () => {
      lane.resolve([DECK])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(head?.querySelector('[data-running]')).toBeNull()
    expect(rowsIn('passages')).toEqual([
      '“halcyon-class storage at grid scale”Grid storage memo.pdf · p.4',
    ])
    // The deck the semantic lane found never joins Records.
    expect(rowsIn('records').map((r) => r.slice(0, 12))).toEqual([
      'Halcyon Grid',
      'Haldane Robo',
    ])
  })

  it('leaves a group with nothing in it absent, and says Nothing found once every lane has answered', async () => {
    mount({ pageActions: dealVerbs(() => {}) })
    type('zzqx')
    await wait(180)
    expect(host.textContent).not.toContain('Nothing found')
    await wait(420)
    await wait(0)
    expect(groups()).toEqual([])
    expect(host.textContent).toContain('Nothing found')
  })

  it('offers the global verbs on a typed word, after the page’s own', () => {
    mount({
      pageActions: [
        { id: 'task', label: 'Add a task', key: 'T', run: () => {} },
      ],
    })
    type('a')
    expect(rowsIn('actions')).toEqual(['Add a taskT', 'Upload a file…'])
    type('up')
    expect(rowsIn('actions')).toEqual(['Upload a file…'])
  })
})

describe('the palette grammar', () => {
  it('prints no esc, no ↵ and no ⌘K anywhere, and only our keys in the foot', async () => {
    mount({ pageActions: dealVerbs(() => {}), records: async () => [HALCYON] })
    const forbidden = (text: string | null) => {
      expect(text).not.toMatch(/esc|↵|⌘K/i)
    }
    forbidden(host.textContent)
    type('hal')
    await wait(700)
    forbidden(host.textContent)
    expect(host.querySelector('[data-foot]')?.textContent).toBe('↑↓ move')
  })

  it('draws 36px rows under 44px bone heads', async () => {
    mount({ pageActions: dealVerbs(() => {}), records: async () => [HALCYON] })
    type('hal')
    await wait(200)
    for (const row of host.querySelectorAll('[cmdk-item]'))
      expect(row.className).toMatch(/\bh-9\b/)
    for (const group of host.querySelectorAll('[cmdk-group]')) {
      expect(group.className).toContain('[&_[cmdk-group-heading]]:h-11')
      expect(group.className).toContain('[&_[cmdk-group-heading]]:bg-bone')
      // The shared primitive's 24px head is merged away, not stacked.
      expect(group.className).not.toContain('[&_[cmdk-group-heading]]:h-6')
    }
  })
})

describe('an action that asks one more answer', () => {
  const choices: Array<StepChoice> = [
    {
      id: 's1',
      label: 'Proptech › Property ops',
      meta: 'filed here',
      done: true,
    },
    { id: 's2', label: 'Proptech › Rental tech', meta: '12 companies' },
    { id: 's3', label: 'Climate', meta: '4 companies' },
  ]

  function fileIn(pick: (c: StepChoice) => Promise<StepChoice>): PageAction {
    return {
      id: 'file-in-space',
      label: 'File in a space…',
      step: {
        mode: 'File in',
        subject: 'Flent',
        placeholder: 'Find a space…',
        heading: 'Spaces',
        hint: 'files Flent, stays open for another',
        choices: async () => choices,
        pick,
      },
    }
  }

  it('asks in the same palette under FILE IN ›, and ⌫ on the empty input returns to Find with the query restored', async () => {
    const picked: Array<string> = []
    const done = vi.fn()
    mount({
      pageActions: [
        fileIn(async (c) => {
          picked.push(c.id)
          return { ...c, meta: 'filed here', done: true }
        }),
      ],
      onStepDone: done,
    })
    expect(modeLabel()).toBe('Find')
    type('fil')
    click(host.querySelector('[data-group="actions"] [cmdk-item]'))
    await wait(0)

    expect(modeLabel()).toBe('File in ›')
    expect(input().value).toBe('')
    expect(input().placeholder).toBe('Find a space…')
    expect(groups()).toEqual(['step'])
    expect(rowsIn('step')).toEqual([
      'Proptech › Property opsfiled here',
      'Proptech › Rental tech12 companies',
      'Climate4 companies',
    ])
    expect(host.querySelector('[data-foot]')?.textContent).toBe(
      '↑↓ move · ⌫ back to findfiles Flent, stays open for another',
    )

    type('rent')
    expect(rowsIn('step')).toEqual(['Proptech › Rental tech12 companies'])
    // ⌫ with text in the input edits the text; it does not leave the step.
    press('Backspace')
    expect(modeLabel()).toBe('File in ›')

    type('')
    click([...host.querySelectorAll('[data-group="step"] [cmdk-item]')].at(1))
    await wait(0)
    expect(picked).toEqual(['s2'])
    expect(done).toHaveBeenCalledOnce()
    // It stays open for another, the space now checked.
    expect(rowsIn('step').at(1)).toBe('Proptech › Rental techfiled here')
    // An already-filed space does nothing.
    click(host.querySelector('[data-group="step"] [cmdk-item]'))
    await wait(0)
    expect(picked).toEqual(['s2'])

    press('Backspace')
    expect(modeLabel()).toBe('Find')
    expect(input().value).toBe('fil')
  })
})

describe('the preview pane', () => {
  const HALCYON_PREVIEW: RecordPreview = {
    id: 'c-halcyon',
    kind: 'company',
    name: 'Halcyon Grid',
    singular: 'Company',
    spaces: [
      { id: 's1', name: 'Climate' },
      { id: 's2', name: 'Grid software' },
    ],
    readouts: {
      kind: 'company',
      readouts: {
        today: '2026-10-10',
        lastContact: '2026-10-04',
        moving30: 3,
        ownership: null,
      },
    },
    fields: [
      { slug: 'description', label: 'Description', value: 'Grid storage' },
      { slug: 'funding_stage', label: 'Funding stage', value: 'Seed' },
      { slug: 'location', label: 'Location', value: 'Oslo' },
      { slug: 'founded_year', label: 'Founded year', value: '2021' },
      { slug: 'linkedin', label: 'LinkedIn', value: 'linkedin.com/halcyon' },
      { slug: 'founders', label: 'Founders', value: 'Ada Lind' },
    ],
  }
  const HALDANE_PREVIEW: RecordPreview = {
    ...HALCYON_PREVIEW,
    id: 'c-haldane',
    name: 'Haldane Robotics',
    fields: [],
  }

  const pane = () => host.querySelector('[data-preview]')
  const foot = () => host.querySelector('[data-foot]')?.textContent

  function recordLoader(asked: Array<string>) {
    return async (id: string) => {
      asked.push(id)
      return id === HALCYON.id ? HALCYON_PREVIEW : HALDANE_PREVIEW
    }
  }

  it('opens on a highlighted record: its readout strip in variant B and six filled fields', async () => {
    const asked: Array<string> = []
    mount({
      records: async () => [HALCYON, HALDANE],
      loaders: { record: recordLoader(asked) },
    })
    type('hal')
    await wait(180)
    // The saved view under Jump to is highlighted first: nothing to preview.
    expect(pane()).toBeNull()
    expect(foot()).toBe('↑↓ move')

    press('ArrowDown')
    await wait(0)
    expect(pane()?.getAttribute('data-preview')).toBe('record')
    expect(pane()?.querySelector('h2')?.textContent).toBe('Halcyon Grid')
    expect(pane()?.querySelector('[data-stamp]')?.textContent).toBe('Company')
    expect(pane()?.querySelector('[data-crumb]')?.textContent).toBe(
      'Climate · Grid software',
    )
    // The record head's own strip: equal cells, value over label.
    const strip = pane()?.querySelector('[data-readouts]')
    expect(strip?.className).toContain('border-t border-hairline')
    expect([...(strip?.children ?? [])].map((c) => c.textContent)).toEqual([
      '10-04 · 6dLast contact',
      '3Moving, 30 days',
      '—Ownership',
    ])
    expect(
      [...(pane()?.querySelectorAll('[data-field]') ?? [])].map(
        (f) => f.textContent,
      ),
    ).toEqual([
      'DescriptionGrid storage',
      'Funding stageSeed',
      'LocationOslo',
      'Founded year2021',
      'LinkedInlinkedin.com/halcyon',
      'FoundersAda Lind',
    ])
    expect(foot()).toBe('↑↓ move · → actions')
    // The pane prints no universal key either.
    expect(pane()?.textContent).not.toMatch(/\besc\b|↵|⌘K/i)
  })

  it('fetches each id once per palette session, however often the highlight returns to it', async () => {
    const asked: Array<string> = []
    mount({
      records: async () => [HALCYON, HALDANE],
      loaders: { record: recordLoader(asked) },
    })
    type('hal')
    await wait(180)
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowDown']) {
      press(key)
      await wait(0)
    }
    press('ArrowUp')
    await wait(0)
    expect(pane()?.querySelector('h2')?.textContent).toBe('Halcyon Grid')
    expect(asked).toEqual([HALCYON.id, HALDANE.id])
  })

  it('opens on an object under Jump to with its saved views and counts, and closes when the highlight leaves it', async () => {
    const asked: Array<string> = []
    const DEALS: ObjectPreview = {
      slug: 'deals',
      plural: 'Deals',
      path: '/deals',
      views: [
        {
          id: 'v1',
          name: 'Halcyon pipeline',
          href: '/deals?view=v1',
          count: 4,
        },
        { id: 'v2', name: 'Late stage', href: '/deals?view=v2', count: 12 },
        { id: 'v3', name: 'Set to close', href: '/deals?view=v3', count: null },
      ],
    }
    const went: Array<string> = []
    mount({
      loaders: {
        object: async (slug) => {
          asked.push(slug)
          return DEALS
        },
      },
      onGo: (href) => went.push(href),
    })
    type('deals')
    await wait(0)
    expect(rowsIn('jump').at(0)).toBe('DealsobjectG D')
    expect(pane()?.getAttribute('data-preview')).toBe('object')
    expect(asked).toEqual(['deals'])
    expect(
      [...(pane()?.querySelectorAll('[data-view]') ?? [])].map(
        (v) => v.textContent,
      ),
    ).toEqual(['Halcyon pipeline4', 'Late stage12', 'Set to close—'])
    click(pane()?.querySelector('[data-view="v2"]'))
    expect(went).toEqual(['/deals?view=v2'])

    // A saved view is no object: the pane closes, the list runs full width.
    press('ArrowDown')
    await wait(0)
    expect(pane()).toBeNull()
    expect(foot()).toBe('↑↓ move')
    press('ArrowUp')
    await wait(0)
    expect(pane()?.getAttribute('data-preview')).toBe('object')
    expect(asked).toEqual(['deals'])
  })

  it('never opens for a settings page', async () => {
    const asked: Array<string> = []
    mount({
      loaders: {
        object: async (slug) => {
          asked.push(slug)
          return null
        },
      },
    })
    type('settings')
    await wait(0)
    const rows = rowsIn('jump').length
    expect(rows).toBeGreaterThan(1)
    for (let i = 0; i < rows; i++) {
      expect(pane()).toBeNull()
      press('ArrowDown')
      await wait(0)
    }
    expect(asked).toEqual([])
  })

  it('previews a passage’s page with the matched text set off, and ↵ opens the viewer at that page', async () => {
    const asked: Array<{ id: string; page: number | null }> = []
    const PAGE: PassagePreview = {
      page: 4,
      pages: 9,
      parts: [
        { text: 'Sited beside substations.', matched: false },
        { text: 'halcyon-class storage at grid scale', matched: true },
      ],
    }
    const opened: Array<[string, number | null]> = []
    mount({
      passages: async () => [DECK],
      loaders: {
        passage: async (p) => {
          asked.push({ id: p.id, page: p.page })
          return PAGE
        },
      },
      onOpenFile: (id, page) => opened.push([id, page]),
    })
    type('storage')
    await wait(700)
    await wait(0)
    expect(pane()?.getAttribute('data-preview')).toBe('passage')
    expect(asked).toEqual([{ id: DECK.id, page: 4 }])
    expect(pane()?.querySelector('[data-page-of]')?.textContent).toBe(
      'p.4 of 9',
    )
    expect(pane()?.querySelector('[data-matched]')?.textContent).toBe(
      'halcyon-class storage at grid scale',
    )
    expect(pane()?.querySelector('[data-page]')?.textContent).toContain(
      'Sited beside substations.',
    )
    expect(pane()?.textContent).toContain('on Halcyon Grid')

    press('Enter')
    expect(opened).toEqual([[DECK.id, 4]])
  })

  it('→ focuses the pane’s actions, ↑↓ moves among them, ← returns to the list; the foot’s actions does the same', async () => {
    mount({
      records: async () => [HALCYON],
      loaders: { record: recordLoader([]) },
    })
    type('halcyon g')
    await wait(180)
    if (pane() === null) {
      press('ArrowDown')
      await wait(0)
    }
    const actions = () =>
      [...(pane()?.querySelectorAll('[data-pane-action]') ?? [])].map((a) =>
        a.getAttribute('data-pane-action'),
      )
    expect(actions()).toEqual(['open', 'file-in-space'])

    input().setSelectionRange(9, 9)
    press('ArrowRight')
    expect(document.activeElement?.getAttribute('data-pane-action')).toBe(
      'open',
    )
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    expect(document.activeElement?.getAttribute('data-pane-action')).toBe(
      'file-in-space',
    )
    // The list's highlight stayed where it was.
    expect(pane()?.getAttribute('data-preview')).toBe('record')
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(input())

    click(host.querySelector('[data-foot-actions]'))
    expect(document.activeElement?.getAttribute('data-pane-action')).toBe(
      'open',
    )
  })
})

describe('usePageActions', () => {
  it('publishes a page’s verbs while it is mounted, and runs a printed key through the page binding', () => {
    const moved = vi.fn()
    const charted = vi.fn()
    let seen: ReadonlyArray<PageAction> = []
    function Page() {
      hotkey.useHotkeys([
        ['m', moved],
        ['g t', charted],
      ])
      pageActions.usePageActions([
        {
          id: 'move',
          label: 'Move stage',
          key: 'M',
          run: pageActions.runBinding('M'),
        },
      ])
      return null
    }
    function Reader() {
      seen = pageActions.usePageActionsList()
      return null
    }
    act(() =>
      root.render(
        <>
          <Reader />
          <Page />
        </>,
      ),
    )
    expect(seen.map((a) => a.id)).toEqual(['move'])
    const verb = pageActions.latestPageAction('move')
    if (!verb || !('run' in verb)) throw new Error('no runnable verb')
    act(() => verb.run())
    expect(moved).toHaveBeenCalledOnce()
    act(() => pageActions.runBinding('G T')())
    expect(charted).toHaveBeenCalledOnce()

    act(() => root.render(<Reader />))
    expect(seen).toEqual([])
  })
})
