import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ValueEditor } from '#/components/attributes/value-editor'
import type { RegistryEntry } from '#/components/attributes/value-editor'
import {
  RecordHistory,
  RecordInteractions,
  burstFigure,
  macroFigure,
} from '#/components/record-timeline'
import { ClockProvider } from '#/components/clock'
import { PropertyFold } from './property-fold'
import { RecordNotes } from './record-notes'
import type { RecordNoteRow } from './record-notes'
import type { MacroFacts } from '#/lib/timeline/record'

/**
 * Inside a record's tabs and details column: the empties fold, the
 * Interactions threads with their counts and row `···`, History's glyph and
 * figure lanes, the Notes order, and the property row's dates, numbers and
 * lists.
 * - happy-dom's globals go in by hand before React loads, as in the other
 *   window tests: the environment would also replace node's `URL`.
 */

await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/deals/x' })
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

vi.mock('#/lib/server-fns', () => ({
  getRecordEmailVisibility: vi.fn(() => Promise.resolve({ workspace: false })),
  setRecordEmailVisibility: vi.fn(() => Promise.resolve()),
  writeUpInteraction: vi.fn(),
  fileInteractionOnEntity: vi.fn(),
  unlinkInteractionFromEntity: vi.fn(),
  listUsers: vi.fn(),
  searchEntities: vi.fn(),
}))
/** The page's search; empty, so the email window stays shut, unless a test sets it. */
const routerSearch = vi.hoisted(() => {
  const current: { modal?: 'email'; id?: string } = {}
  return { current }
})

// The window has its own suite; here only the row.
vi.mock('#/components/email-dialog', () => ({ EmailModal: () => null }))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  useSearch: () => routerSearch.current,
  useNavigate: () => () => Promise.resolve(),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}))

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  routerSearch.current = {}
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

async function mount(node: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  root = r
  act(() => r.render(<ClockProvider now={NOW}>{node}</ClockProvider>))
  await flush()
  return host
}

/** The instant every date in these views is printed against. */
const NOW = '2026-10-26T12:00:00.000Z'

const button = (label: RegExp) => {
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

type Items = Parameters<typeof RecordHistory>[0]['items']

const interaction = (
  id: string,
  kind: 'email' | 'meeting' | 'call',
  extra: Partial<{
    at: string
    threadId: string | null
    linked: boolean
    via: string | null
    attachments: number
    answer: string | null
    noteId: string | null
    privateBody: boolean
    ownPrivate: boolean
    hasAttachments: boolean
    summary: string | null
    snippet: string | null
    categories: Array<'intro' | 'pitch' | 'update'>
    attendees: Array<{ id: string; name: string; kind: string; self: boolean }>
    sent: boolean
  }> = {},
): Items[number] => ({
  type: 'interaction',
  id,
  kind,
  subject: `${kind} ${id}`,
  noteId: null,
  threadId: null,
  linked: true,
  sent: false,
  privateBody: false,
  ownPrivate: false,
  at: '2026-10-01T10:00:00.000Z',
  attendees: [],
  via: null,
  attachments: 0,
  hasAttachments: false,
  answer: null,
  summary: null,
  snippet: null,
  categories: [],
  ...extra,
})

const burst = (
  id: string,
  changes: Array<{ slug: string; from?: string | null; to?: string }>,
  at = '2026-10-02T10:00:00.000Z',
): Items[number] => ({
  type: 'attrs',
  id,
  actorType: 'user',
  actorName: 'Priya Raman',
  integrationName: null,
  source: 'direct',
  at,
  changes: changes.map((c) => ({
    slug: c.slug,
    from: c.from ?? null,
    to: c.to ?? 'x',
    citations: [],
  })),
})

const NO_FACTS: MacroFacts = {
  amount: null,
  currency: null,
  document: null,
  space: null,
  merged: null,
  fields: null,
  fromEmail: false,
}

const macro = (
  id: string,
  verb: string,
  facts: Partial<MacroFacts> = {},
  at = '2026-10-03T10:00:00.000Z',
): Items[number] => ({
  type: 'macro',
  id,
  verb,
  actorName: 'Priya Raman',
  facts: { ...NO_FACTS, ...facts },
  at,
})

const check = (id: string, voidedAt: string | null): Items[number] => ({
  type: 'ledger',
  id,
  verb: 'investment.added',
  actorName: 'Anish',
  amount: 50_000,
  currency: 'USD',
  instrument: 'safe_post_money',
  date: '2026-09-01',
  voidedAt,
  at: '2026-10-03T10:00:00.000Z',
})

const FLENT = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Flent',
}

async function openMenu(label: string) {
  const trigger = document.querySelector(`[aria-label="More for ${label}"]`)
  if (trigger === null) throw new Error(`no ··· for ${label}`)
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
  await flush()
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
    el.textContent.trim(),
  )
}

const threadIds = (el: HTMLElement) =>
  [...el.querySelectorAll('li[data-thread]')].map((r) =>
    r.getAttribute('data-thread'),
  )

describe('the empties fold', () => {
  const defs = [
    { slug: 'description', name: 'Description', type: 'text', value: 'Sats' },
    { slug: 'founders', name: 'Founders', type: 'record_reference', value: [] },
    { slug: 'twitter', name: 'Twitter', type: 'url', value: null },
    { slug: 'location', name: 'Location', type: 'text', value: '  ' },
  ]
  type Def = (typeof defs)[number]
  const render = (d: Def) => (
    <p key={d.slug} data-row={d.slug}>
      {d.slug}
    </p>
  )
  const rows = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-row]')].map((r) =>
      r.getAttribute('data-row'),
    )

  it('shows the filled values and folds the empties into one n empty + row', async () => {
    const el = await mount(
      <PropertyFold defs={defs} valueOf={(d) => d.value} render={render} />,
    )
    expect(rows(el)).toEqual(['description'])
    const foot = el.querySelector('[data-property-foot]')
    expect(foot?.className.split(' ')).toEqual(
      expect.arrayContaining(['h-8', 'bg-bone', 'text-label', 'text-graphite']),
    )
    expect(foot?.textContent).toBe('3 empty+')
    expect(foot?.getAttribute('aria-label')).toBe('Add an attribute')
  })

  it('opens a search of the empties, name and mono type, and picks one into the grid', async () => {
    const el = await mount(
      <PropertyFold defs={defs} valueOf={(d) => d.value} render={render} />,
    )
    const foot = el.querySelector('[data-property-foot]')
    if (foot === null) throw new Error('no foot')
    await click(foot)
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Add an attribute…"]',
    )
    expect(input).not.toBeNull()
    const offered = [
      ...document.querySelectorAll('[aria-label="Empty attributes"] button'),
    ].map((b) => b.textContent)
    expect(offered).toEqual([
      'Foundersrecord reference',
      'Twitterurl',
      'Locationtext',
    ])
    expect(document.body.textContent).not.toMatch(/New attribute…/)
    await click(button(/^Twitterurl$/))
    expect(rows(el)).toEqual(['description', 'twitter'])
  })

  it("ends the popover on New attribute…, which opens the caller's window", async () => {
    const seen: Array<boolean> = []
    const el = await mount(
      <PropertyFold
        defs={defs}
        valueOf={(d) => d.value}
        render={render}
        create={({ open }) => {
          seen.push(open)
          return open ? <p data-creating /> : null
        }}
      />,
    )
    const foot = el.querySelector('[data-property-foot]')
    if (foot === null) throw new Error('no foot')
    await click(foot)
    await click(button(/^New attribute…$/))
    expect(seen.at(-1)).toBe(true)
    expect(el.querySelector('[data-creating]')).not.toBeNull()
  })

  it('draws no row when nothing is empty and nothing creates', async () => {
    const el = await mount(
      <PropertyFold
        defs={defs.slice(0, 1)}
        valueOf={(d) => d.value}
        render={render}
      />,
    )
    expect(el.querySelector('[data-property-foot]')).toBeNull()
  })

  it('keeps the row for the + alone when nothing is empty, with no 0', async () => {
    const el = await mount(
      <PropertyFold
        defs={defs.slice(0, 1)}
        valueOf={(d) => d.value}
        render={render}
        create={() => null}
      />,
    )
    expect(el.querySelector('[data-property-foot]')?.textContent).toBe('+')
  })
})

describe('the Interactions tab', () => {
  const items: Items = [
    interaction('a', 'email', {
      threadId: 't1',
      at: '2026-10-01T10:00:00.000Z',
    }),
    interaction('b', 'email', {
      threadId: 't1',
      at: '2026-10-02T10:00:00.000Z',
      attachments: 2,
      hasAttachments: true,
    }),
    interaction('c', 'email'),
    interaction('d', 'meeting', { noteId: 'n1' }),
    interaction('e', 'call'),
    burst('x', [{ slug: 'stage' }]),
  ]

  it('draws one row per thread, the newest message with its count', async () => {
    const el = await mount(<RecordInteractions items={items} />)
    expect(threadIds(el)).toEqual(['b', 'c', 'd', 'e'])
    const thread = el.querySelector('li[data-thread="b"]')
    expect(thread?.querySelector('[data-messages]')?.textContent).toBe('2')
    expect(el.querySelector('li[data-thread="c"] [data-messages]')).toBeNull()
  })

  it('counts each kind by thread in the Segmented, All uncounted, and filters', async () => {
    const el = await mount(<RecordInteractions items={items} />)
    const segments = [...el.querySelectorAll('[role="radio"]')].map(
      (b) => b.textContent,
    )
    expect(segments).toEqual(['All', 'Email2', 'Meetings1', 'Calls1'])
    await click(button(/^Email2$/))
    expect(threadIds(el)).toEqual(['b', 'c'])
    expect(button(/^Email2$/).getAttribute('aria-checked')).toBe('true')
  })

  it('lists only the threads with files under With files, counted', async () => {
    const el = await mount(<RecordInteractions items={items} />)
    const toggle = el.querySelector('[role="switch"]')
    expect(toggle?.textContent).toBe('With files1')
    if (toggle === null) throw new Error('no toggle')
    await click(toggle)
    expect(threadIds(el)).toEqual(['b'])
  })

  it('breaks the threads by week on bone bands', async () => {
    const el = await mount(
      <RecordInteractions
        items={[
          interaction('now', 'call', { at: '2026-10-26T09:00:00.000Z' }),
          interaction('last', 'call', { at: '2026-10-21T09:00:00.000Z' }),
          interaction('old', 'call', { at: '2026-10-01T09:00:00.000Z' }),
        ]}
      />,
    )
    const bands = [...el.querySelectorAll('[data-band]')].map(
      (b) => b.textContent,
    )
    expect(bands).toEqual(['This week', 'Last week', 'Earlier'])
  })

  it('has no composer: empty, it is one Interactions + row, which the log window wraps', async () => {
    const wrapped: Array<string> = []
    const el = await mount(
      <RecordInteractions
        items={[burst('x', [{ slug: 'stage' }])]}
        logInteraction={(trigger) => {
          wrapped.push('log')
          return trigger
        }}
      />,
    )
    expect(el.textContent).toBe('Interactions+')
    expect(el.querySelector('[data-empty-row]')).not.toBeNull()
    expect(wrapped).toEqual(['log'])
  })

  it('holds Write up in the row ···, with Unlink from the record last', async () => {
    await mount(
      <RecordInteractions items={[interaction('c', 'call')]} record={FLENT} />,
    )
    expect(await openMenu('call c')).toEqual([
      'Write up',
      'Copy link',
      'File on a deal…',
      'Unlink from Flent…',
    ])
  })

  it('opens an email, offers no Write up on a written-up row, and no Unlink where the edge is the company’s', async () => {
    await mount(
      <RecordInteractions
        items={[interaction('m', 'meeting', { noteId: 'n1', linked: false })]}
        record={FLENT}
      />,
    )
    expect(await openMenu('meeting m')).toEqual([
      'Open',
      'Copy link',
      'File on a deal…',
    ])
  })

  it('keeps a body private to someone else unlinked, with no Write up (D67)', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('p', 'call', { privateBody: true })]}
      />,
    )
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toContain('call p')
    expect(await openMenu('call p')).not.toContain('Write up')
  })

  it('offers the record override to a viewer with private emails here, its one item a switch (D67)', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('m', 'email', { ownPrivate: true })]}
        record={FLENT}
      />,
    )
    expect(el.querySelector('[aria-label="More for interactions"]')).toBeNull()
    const toggles = [...el.querySelectorAll('[role="switch"]')]
    expect(toggles.map((t) => t.textContent)).toEqual([
      'With files',
      'My emails visible to the workspace',
    ])
  })

  it('offers no override to a viewer whose emails here are none of theirs', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('t', 'email', { privateBody: true })]}
        record={FLENT}
      />,
    )
    expect(el.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  it('highlights the row ?modal=email&id= opens, behind its window (D74)', async () => {
    routerSearch.current = { modal: 'email', id: 'c' }
    const el = await mount(<RecordInteractions items={items} />)
    const lit = [...el.querySelectorAll('li[data-highlighted]')]
    expect(lit).toHaveLength(1)
    expect(lit.at(0)?.className).toContain('bg-bone')
    expect(lit.at(0)?.textContent).toContain('email c')
  })

  it('folds past twenty threads, and unfolds to the opened one', async () => {
    const many: Items = Array.from({ length: 23 }, (_, i) =>
      interaction(`m${i}`, 'email'),
    )
    const el = await mount(<RecordInteractions items={many} />)
    expect(threadIds(el)).toHaveLength(20)
    await click(button(/^3 more$/))
    expect(threadIds(el)).toHaveLength(23)

    act(() => root?.unmount())
    routerSearch.current = { modal: 'email', id: 'm22' }
    const opened = await mount(<RecordInteractions items={many} />)
    expect(threadIds(opened)).toHaveLength(23)
  })
})

describe('the History tab', () => {
  const STAGE: RegistryEntry = {
    slug: 'stage',
    name: 'Stage',
    type: 'status',
    isSystem: true,
    options: {
      options: [
        { id: 'dil', label: 'Diligence' },
        { id: 'ts', label: 'Term sheet' },
      ],
    },
  }
  const TEAM: RegistryEntry = {
    slug: 'team_size',
    name: 'Team size',
    type: 'number',
    isSystem: false,
    options: null,
  }
  const LOCATION: RegistryEntry = {
    slug: 'location',
    name: 'Location',
    type: 'text',
    isSystem: false,
    options: null,
  }
  const registry = [STAGE, TEAM, LOCATION]

  it('prints the figure each activity kind carries', () => {
    expect(
      macroFigure({
        facts: { ...NO_FACTS, amount: 4_500_000, currency: 'USD' },
      }),
    ).toBe('$4.5M')
    expect(macroFigure({ facts: { ...NO_FACTS, fields: 6 } })).toBe(
      '6 attributes',
    )
    expect(
      macroFigure({ facts: { ...NO_FACTS, document: 'Q3 board deck.pdf' } }),
    ).toBe('Q3 board deck.pdf')
    expect(
      macroFigure({ facts: { ...NO_FACTS, merged: 'Exponent Labs' } }),
    ).toBe('Exponent Labs')
    expect(
      macroFigure({
        facts: { ...NO_FACTS, space: 'Proptech › Property ops' },
      }),
    ).toBe('Proptech › Property ops')
    expect(macroFigure({ facts: { ...NO_FACTS, fromEmail: true } })).toBe(
      'from an email',
    )
    expect(macroFigure({ facts: NO_FACTS })).toBeNull()
    expect(burstFigure(['Team size', 'Location', 'Sector'])).toBe(
      'Team size, Location, +1',
    )
    expect(burstFigure(['Team size'])).toBe('Team size')
  })

  it('draws 40px rows: the glyph, the sentence, the mono figure and the day', async () => {
    const el = await mount(
      <RecordHistory
        items={[
          macro('mk', 'mark.added', { amount: 4_500_000, currency: 'USD' }),
          macro('sp', 'space.tagged', { space: 'Proptech › Property ops' }),
          burst('st', [{ slug: 'stage', from: 'dil', to: 'ts' }]),
          burst('at', [
            { slug: 'team_size', from: '90', to: '120' },
            { slug: 'location', to: 'Pune' },
            { slug: 'sector', to: 'Proptech' },
          ]),
          interaction('i', 'call'),
        ]}
        registry={registry}
      />,
    )
    const entries = [...el.querySelectorAll('li[data-history]')]
    expect(entries.map((r) => r.getAttribute('data-history'))).toEqual([
      'mark',
      'space',
      'stage',
      'edit',
    ])
    const mark = entries[0]
    expect(mark.className).toContain('h-ledger-row')
    expect(mark.querySelector('[data-glyph]')?.textContent).toBe('■')
    expect(mark.textContent).toContain('Priya Raman recorded a mark')
    expect(mark.querySelector('[data-figure]')?.textContent).toBe('$4.5M')
    expect(mark.querySelector('time')?.textContent).toBe('3 Oct')
    expect(entries[1].querySelector('[data-glyph] svg')).not.toBeNull()
    expect(entries[2].querySelector('[data-figure]')?.textContent).toBe(
      'Diligence→Term sheet',
    )
    expect(
      entries[2].querySelector('[data-figure] [data-slot="badge"]')
        ?.textContent,
    ).toBe('Term sheet')
    expect(entries[3].querySelector('[data-figure]')?.textContent).toBe(
      'Team size, Location, +1',
    )
  })

  it('opens a burst in place: a bone head over each change, from → to', async () => {
    const el = await mount(
      <RecordHistory
        items={[
          burst('at', [
            { slug: 'team_size', from: '90', to: '120' },
            { slug: 'location', to: 'Pune' },
          ]),
        ]}
        registry={registry}
      />,
    )
    const head = button(/^›Priya Raman changed 2 attributes/)
    await click(head)
    expect(head.className).toContain('bg-bone')
    expect(head.textContent).toContain('⌄Priya Raman changed 2 attributes')
    const changes = [...el.querySelectorAll('[data-change]')].map(
      (c) => c.textContent,
    )
    expect(changes).toEqual(['Team size90→120', 'LocationPune'])
  })

  it('strikes a voided check and says when it was voided', async () => {
    const el = await mount(
      <RecordHistory
        items={[
          check('kept', null),
          check('voided', '2026-10-04T09:00:00.000Z'),
        ]}
        registry={[]}
      />,
    )
    const struck = el.querySelectorAll('[data-voided]')
    expect(struck).toHaveLength(1)
    expect(struck.item(0).parentElement?.className).toContain('line-through')
    expect(el.textContent).toContain('voided 4 Oct')
    expect(el.textContent).toContain('$50K SAFE post')
  })

  it('breaks by week and pages at 25 with a fold, and has no filter row', async () => {
    const many: Items = Array.from({ length: 30 }, (_, i) =>
      macro(`n${i}`, 'note.created', {}, '2026-10-01T10:00:00.000Z'),
    )
    const el = await mount(
      <RecordHistory
        items={[
          macro('today', 'note.created', {}, '2026-10-26T08:00:00.000Z'),
          ...many,
        ]}
        registry={[]}
      />,
    )
    expect(el.querySelector('[role="group"]')).toBeNull()
    expect(el.querySelector('[role="radiogroup"]')).toBeNull()
    expect(
      [...el.querySelectorAll('[data-band]')].map((b) => b.textContent),
    ).toEqual(['This week', 'Earlier'])
    expect(el.querySelectorAll('li[data-history]')).toHaveLength(25)
    await click(button(/^6 more$/))
    expect(el.querySelectorAll('li[data-history]')).toHaveLength(31)
  })

  it('prints nothing when there is no history', async () => {
    const el = await mount(<RecordHistory items={[]} registry={[]} />)
    expect(el.textContent).toBe('')
  })
})

describe('the Notes tab', () => {
  const row = (
    id: string,
    title: string,
    over: Partial<RecordNoteRow> = {},
  ): RecordNoteRow => ({
    id,
    title,
    kind: 'note',
    updatedAt: '2026-10-19T10:00:00.000Z',
    via: null,
    author: null,
    attendees: [],
    excerpt: null,
    supersededBy: null,
    ...over,
  })

  it('is one Notes + row with no notes: no composer, no sentence', async () => {
    const onNewNote = vi.fn()
    const el = await mount(
      <RecordNotes
        notes={{ filed: [], fromMeetings: [], mentions: [] }}
        onNewNote={onNewNote}
      />,
    )
    expect(el.textContent).toBe('Notes+')
    const empty = el.querySelector('[data-empty-row]')
    if (empty === null) throw new Error('no empty row')
    await click(empty)
    expect(onNewNote).toHaveBeenCalledOnce()
  })

  it('opens on its composer, then filed notes, a FROM MEETINGS band, and superseded notes last', async () => {
    const onNewNote = vi.fn()
    const el = await mount(
      <RecordNotes
        notes={{
          filed: [
            row('old', 'IC memo v1', { kind: 'memo', supersededBy: 'memo' }),
            row('s', 'Loose ends', {
              kind: 'scratch',
              author: 'Priya Raman',
              excerpt: 'Ask about churn in the Pune cohort.',
            }),
            row('memo', 'IC memo', { kind: 'memo' }),
          ],
          fromMeetings: [
            row('g', 'Flent — founder call', {
              via: { tool: 'Granola', author: 'Maya' },
              attendees: ['Maya Iyer', 'Ravi Shah'],
            }),
          ],
          mentions: [row('x', 'Aside', { author: 'Sam Lee' })],
        }}
        onNewNote={onNewNote}
      />,
    )
    expect(el.querySelector('button')?.textContent).toBe('+Write a note…N')
    await click(button(/^\+Write a note…N$/))
    expect(onNewNote).toHaveBeenCalledOnce()
    expect(el.querySelector('[role="group"]')).toBeNull()

    const titles = [
      ...el.querySelectorAll('li[data-note] .font-serif.text-title'),
    ].map((t) => t.textContent)
    expect(titles).toEqual([
      'IC memo',
      'Loose ends',
      'Aside',
      'Flent — founder call',
      'IC memo v1',
    ])
    expect(
      [...el.querySelectorAll('[data-band]')].map((b) => b.textContent),
    ).toEqual(['From meetings'])

    const lane = (id: string, slot: string) =>
      el.querySelector(`li[data-note="${id}"] [data-${slot}]`)?.textContent
    expect(lane('memo', 'kind')).toBe('memo')
    expect(lane('s', 'kind')).toBe('scratch')
    expect(lane('x', 'kind')).toBe('')
    expect(lane('g', 'kind')).toBe('via Granola')
    expect(lane('old', 'kind')).toBe('superseded')
    expect(lane('s', 'people')).toBe('Priya Raman')
    expect(lane('g', 'people')).toBe('Maya Iyer · Ravi Shah')
    expect(lane('s', 'excerpt')).toBe('Ask about churn in the Pune cohort.')

    // A superseded note is one graphite line with no excerpt.
    expect(
      el.querySelector('li[data-note="old"] .font-serif')?.className,
    ).toContain('text-graphite')
    expect(lane('old', 'excerpt')).toBeUndefined()
  })
})

describe('a property row’s values', () => {
  const def = (type: string, extra: Partial<RegistryEntry> = {}) => ({
    slug: type,
    name: type,
    type,
    options: null,
    isSystem: false,
    ...extra,
  })

  it('reads an empty date as a dash, and opens the native control on click', async () => {
    const el = await mount(
      <ValueEditor
        def={def('date')}
        value={null}
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(el.querySelector('input[type="date"]')).toBeNull()
    expect(el.textContent).toBe('—')
    await click(button(/^—$/))
    expect(el.querySelector('input[type="date"]')).not.toBeNull()
  })

  it('reads a stored date as the day', async () => {
    const el = await mount(
      <ValueEditor
        def={def('date')}
        value="2026-11-30"
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(el.textContent).toBe('30 Nov')
  })

  it('left-aligns a number in the value lane, and right-aligns it in a cell', async () => {
    const field = await mount(
      <ValueEditor
        def={def('number')}
        value={2019}
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(field.querySelector('input')?.className).not.toContain('numeric')
    act(() => root?.unmount())
    const cell = await mount(
      <ValueEditor
        def={def('number')}
        value={2019}
        variant="cell"
        onSave={() => undefined}
      />,
    )
    expect(cell.querySelector('input')?.className).toContain('numeric')
  })

  it('shows a list’s first email and +n for the rest', async () => {
    const el = await mount(
      <ValueEditor
        def={def('email', { options: { multi: true } })}
        value={['a@x.example', 'b@x.example', 'c@x.example']}
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(el.textContent).toContain('a@x.example')
    expect(el.textContent).not.toContain('b@x.example')
    expect(el.textContent).toContain('+2')
  })
})
