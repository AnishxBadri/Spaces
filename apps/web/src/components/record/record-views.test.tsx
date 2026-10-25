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
  historyCounts,
  interactionLane,
} from '#/components/record-timeline'
import { stamp } from '#/lib/timeline/stamp'
import { PropertyFold } from './property-fold'
import { RecordNotes } from './record-notes'

/**
 * Inside a record's tabs and details column: the empties fold, the kind
 * and History filters with their counts, a voided check struck, the notes
 * composer row first, and the property row's dates, numbers and lists.
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
  writeUpInteraction: vi.fn(),
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
  act(() => r.render(node))
  await flush()
  return host
}

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
    attendees: Array<{ id: string; name: string; kind: string }>
  }> = {},
): Items[number] => ({
  type: 'interaction',
  id,
  kind,
  subject: `${kind} ${id}`,
  noteId: null,
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

const burst = (id: string, slugs: Array<string>): Items[number] => ({
  type: 'attrs',
  id,
  actorType: 'user',
  actorName: 'Anish',
  integrationName: null,
  source: 'direct',
  at: '2026-10-02T10:00:00.000Z',
  changes: slugs.map((slug) => ({ slug, to: 'x', citations: [] })),
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

describe('the empties fold', () => {
  const defs = [
    { slug: 'description', value: 'Satellites' },
    { slug: 'founders', value: [] },
    { slug: 'twitter', value: null },
    { slug: 'location', value: '  ' },
  ]
  const render = (d: (typeof defs)[number]) => (
    <p key={d.slug} data-row={d.slug}>
      {d.slug}: {Array.isArray(d.value) ? '' : (d.value ?? '—')}
    </p>
  )

  it('shows the filled values and folds three empties under one row', async () => {
    const el = await mount(
      <PropertyFold defs={defs} valueOf={(d) => d.value} render={render} />,
    )
    const rows = () =>
      [...el.querySelectorAll('[data-row]')].map((r) =>
        r.getAttribute('data-row'),
      )
    expect(rows()).toEqual(['description'])
    const toggle = button(/^Show all · 3 empty$/)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    expect(rows()).toEqual(['description', 'founders', 'twitter', 'location'])
  })

  it('draws no fold row when nothing is empty', async () => {
    const el = await mount(
      <PropertyFold
        defs={defs.slice(0, 1)}
        valueOf={(d) => d.value}
        render={render}
      />,
    )
    expect(el.querySelector('button')).toBeNull()
  })
})

describe('the Interactions tab', () => {
  const items: Items = [
    interaction('a', 'email', {
      via: 'Anish',
      attachments: 2,
      hasAttachments: true,
    }),
    interaction('b', 'email'),
    interaction('c', 'meeting', { answer: 'accepted', noteId: 'n1' }),
    interaction('d', 'call'),
    burst('x', ['stage']),
  ]

  it('filters by kind, each filter with its count', async () => {
    const el = await mount(<RecordInteractions items={items} registry={[]} />)
    const filters = [...el.querySelectorAll('[role="group"] button')].map(
      (b) => b.textContent,
    )
    expect(filters).toEqual([
      'All 4',
      'Email 2',
      'Meeting 1',
      'Call 1',
      'Has attachments 1',
    ])
    expect(el.querySelectorAll('li')).toHaveLength(4)
    await click(button(/^Email 2$/))
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(button(/^Email 2$/).getAttribute('aria-pressed')).toBe('true')
  })

  it('lists only the rows with attachments under Has attachments, on the same filter row', async () => {
    const el = await mount(<RecordInteractions items={items} registry={[]} />)
    expect(el.querySelectorAll('[role="group"]')).toHaveLength(1)
    await click(button(/^Has attachments 1$/))
    expect(el.querySelectorAll('li')).toHaveLength(1)
    expect(el.querySelector('li')?.textContent).toContain('email a')
  })

  it('ends a row on its mono lane, with Write up as a row action', async () => {
    const el = await mount(<RecordInteractions items={items} registry={[]} />)
    const lanes = [...el.querySelectorAll('[data-end-lane]')].map(
      (l) => l.textContent,
    )
    const date = stamp('2026-10-01T10:00:00.000Z')
    expect(lanes.at(0)).toBe(`Write upvia Anish · ⧉ 2${date}`)
    // A written-up row opens its note from the subject, so has no action.
    expect(lanes.at(2)).toBe(`accepted${date}`)
    const writeUp = button(/^Write up$/)
    expect(writeUp.className).toContain('opacity-0')
    expect(writeUp.className).not.toContain('text-primary')
  })

  it('keeps a body private to someone else unlinked, with no Write up (D67)', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('p', 'call', { via: 'Gmail', privateBody: true })]}
        registry={[]}
      />,
    )
    const lanes = [...el.querySelectorAll('[data-end-lane]')].map(
      (l) => l.textContent,
    )
    expect(lanes).toEqual([
      `body private · via Gmail${stamp('2026-10-01T10:00:00.000Z')}`,
    ])
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toContain('call p')
  })

  it('opens a private email’s window, which shows its headers (D67)', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('p', 'email', { via: 'Gmail', privateBody: true })]}
        registry={[]}
      />,
    )
    expect(el.querySelectorAll('a')).toHaveLength(1)
    expect(el.querySelector('a')?.textContent).toBe('email p')
  })

  it('offers the record override in the head’s ··· to a viewer with private emails here (D67)', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('m', 'email', { ownPrivate: true })]}
        registry={[]}
        recordId="00000000-0000-4000-8000-0000000000aa"
      />,
    )
    expect(
      el.querySelector('[aria-label="More for interactions"]'),
    ).not.toBeNull()
  })

  it('offers no ··· to a viewer whose emails here are none of theirs', async () => {
    const el = await mount(
      <RecordInteractions
        items={[interaction('t', 'email', { privateBody: true })]}
        registry={[]}
        recordId="00000000-0000-4000-8000-0000000000aa"
      />,
    )
    expect(el.querySelector('[aria-label="More for interactions"]')).toBeNull()
  })

  it('draws a 40px row: glyph, subject, participants, the summary clamped at two lines, chips', async () => {
    const el = await mount(
      <RecordInteractions
        items={[
          interaction('s', 'email', {
            summary: 'Sends the Q3 deck ahead of Thursday.',
            snippet: 'Hi all, attached is',
            categories: ['update', 'pitch'],
            attendees: [
              { id: 'p1', name: 'Ada Lovelace', kind: 'person' },
              { id: 'c1', name: 'Acme', kind: 'company' },
            ],
          }),
        ]}
        registry={[]}
      />,
    )
    const row = el.querySelector('li')
    expect(row?.className).toContain('min-h-ledger-row')
    expect(row?.querySelector('svg[aria-label="email"]')).not.toBeNull()
    expect(row?.querySelector('a')?.textContent).toBe('email s')
    expect(row?.querySelector('[data-participants]')?.textContent).toBe(
      'Ada Lovelace · Acme',
    )
    const line = row?.querySelector('[data-line]')
    expect(line?.getAttribute('data-line')).toBe('summary')
    expect(line?.textContent).toBe('Sends the Q3 deck ahead of Thursday.')
    expect(line?.className).toContain('line-clamp-2')
    expect(
      [...(row?.querySelectorAll('[data-category]') ?? [])].map(
        (c) => c.textContent,
      ),
    ).toEqual(['update', 'pitch'])
    const end = row?.querySelector('[data-end-lane]')
    expect(end?.className).toContain('mono')
    expect(end?.querySelector('[data-date]')?.textContent).toBe(
      stamp('2026-10-01T10:00:00.000Z'),
    )
  })

  it('shows the snippet, unmarked, when no summary is written', async () => {
    const el = await mount(
      <RecordInteractions
        items={[
          interaction('n', 'email', {
            snippet: 'Hi all, attached is the deck',
          }),
          interaction('w', 'email', { summary: 'Sends the deck.' }),
        ]}
        registry={[]}
      />,
    )
    const lines = [...el.querySelectorAll('[data-line]')]
    const snippet = lines.at(0)
    const summary = lines.at(1)
    expect(snippet?.textContent).toBe('Hi all, attached is the deck')
    // Same type, same ink as a summary: nothing marks it as a fallback.
    expect(snippet?.className).toBe(summary?.className)
    expect(snippet?.parentElement?.textContent).toBe(
      'email nHi all, attached is the deck',
    )
  })

  it('draws no line under a row with neither', async () => {
    const el = await mount(
      <RecordInteractions items={[interaction('z', 'call')]} registry={[]} />,
    )
    expect(el.querySelector('[data-line]')).toBeNull()
  })

  it('tells the page when the filter changes, so the tab head’s count follows', async () => {
    const changes: Array<string> = []
    await mount(
      <RecordInteractions
        items={items}
        registry={[]}
        filter="all"
        onFilterChange={(f) => changes.push(f)}
      />,
    )
    await click(button(/^Has attachments 1$/))
    expect(changes).toEqual(['attachments'])
  })

  it('highlights the row ?modal=email&id= opens, behind its window (D74)', async () => {
    routerSearch.current = { modal: 'email', id: 'b' }
    const el = await mount(<RecordInteractions items={items} registry={[]} />)
    const lit = [...el.querySelectorAll('li[data-highlighted]')]
    expect(lit).toHaveLength(1)
    expect(lit.at(0)?.className).toContain('bg-bone')
    expect(lit.at(0)?.textContent).toContain('email b')
  })

  it('unfolds to the opened row when it sits past the fold', async () => {
    const many: Items = Array.from({ length: 23 }, (_, i) =>
      interaction(`m${i}`, 'email'),
    )
    routerSearch.current = { modal: 'email', id: 'm22' }
    const el = await mount(<RecordInteractions items={many} registry={[]} />)
    expect(el.querySelectorAll('li')).toHaveLength(23)
    expect(el.querySelector('li[data-highlighted]')?.textContent).toContain(
      'email m22',
    )
  })

  it('folds past twenty with an n of N foot', async () => {
    const many: Items = Array.from({ length: 23 }, (_, i) =>
      interaction(`m${i}`, 'email'),
    )
    const el = await mount(<RecordInteractions items={many} registry={[]} />)
    expect(el.querySelectorAll('li')).toHaveLength(20)
    await click(button(/^20 of 23 · more ›$/))
    expect(el.querySelectorAll('li')).toHaveLength(23)
  })

  it('prints the lane’s parts it has, and nothing for none', () => {
    expect(interactionLane({ via: null, attachments: 0, answer: null })).toBe(
      '',
    )
    expect(
      interactionLane({ via: 'Gmail', attachments: 1, answer: 'declined' }),
    ).toBe('via Gmail · ⧉ 1 · declined')
  })
})

describe('the History tab on a deal', () => {
  const items: Items = [
    burst('s1', ['stage']),
    burst('s2', ['stage', 'value']),
    burst('a1', ['close_date']),
    check('kept', null),
    check('voided', '2026-10-04T09:00:00.000Z'),
    interaction('i', 'call'),
  ]

  it('counts each filter and filters by Stage', async () => {
    expect(
      historyCounts(items.filter((i) => i.type !== 'interaction')),
    ).toEqual({ all: 5, stage: 2, attributes: 1, ledger: 2 })
    const el = await mount(
      <RecordHistory items={items} registry={[]} filters />,
    )
    const filters = [...el.querySelectorAll('[role="group"] button')].map(
      (b) => b.textContent,
    )
    expect(filters).toEqual(['All 5', 'Stage 2', 'Attributes 1', 'Ledger 2'])
    await click(button(/^Stage 2$/))
    expect(el.querySelectorAll('li')).toHaveLength(2)
  })

  it('strikes a voided check and says when it was voided', async () => {
    const el = await mount(
      <RecordHistory items={items} registry={[]} filters />,
    )
    await click(button(/^Ledger 2$/))
    const struck = el.querySelectorAll('[data-voided]')
    expect(struck).toHaveLength(1)
    expect(struck.item(0).className).toContain('line-through')
    expect(el.textContent).toContain('voided 10-04')
    expect(el.textContent).toContain('$50K SAFE post')
  })

  it('draws no filter row off a deal', async () => {
    const el = await mount(<RecordHistory items={items} registry={[]} />)
    expect(el.querySelector('[role="group"]')).toBeNull()
  })
})

describe('the Notes tab', () => {
  it('opens on its composer row, on paper with no band', async () => {
    const onNewNote = vi.fn()
    const el = await mount(
      <RecordNotes
        notes={{
          filed: [
            {
              id: 'n',
              title: 'IC memo',
              kind: 'memo',
              updatedAt: '2026-10-01',
              via: null,
            },
          ],
          fromMeetings: [],
          mentions: [],
        }}
        onNewNote={onNewNote}
      />,
    )
    const first = el.querySelector('li')
    expect(first?.textContent).toBe('+Write a note…N')
    expect(el.querySelector('.bg-bone')).toBeNull()
    await click(button(/^\+Write a note…N$/))
    expect(onNewNote).toHaveBeenCalledOnce()
  })

  it('filters All · Filed here · From meetings · Mentions, a recorder note serif and marked via its tool', async () => {
    const row = (
      id: string,
      title: string,
      via: { tool: string; author: string } | null = null,
    ) => ({ id, title, kind: 'note' as const, updatedAt: '2026-10-19', via })
    const granola = row('g', 'Granola notes · Maya', {
      tool: 'Granola',
      author: 'Maya',
    })
    const onFilterChange = vi.fn()
    const el = await mount(
      <RecordNotes
        notes={{
          filed: [row('m', 'IC memo'), granola],
          fromMeetings: [
            row('w', 'Flent — founder call'),
            granola,
            row('t', 'Typed notes · Granola', {
              tool: 'Granola',
              author: 'Anish',
            }),
          ],
          mentions: [row('x', 'Aside')],
        }}
        onFilterChange={onFilterChange}
        onNewNote={() => undefined}
      />,
    )
    const filters = [
      ...el.querySelectorAll('[role="group"][aria-label="Show notes"] button'),
    ].map((b) => b.textContent)
    expect(filters).toEqual([
      'All 5',
      'Filed here 2',
      'From meetings 3',
      'Mentions 1',
    ])
    const titles = () =>
      [...el.querySelectorAll('li a .font-serif')].map((t) => t.textContent)
    // All lists a filed meeting note once, under filed.
    expect(titles()).toEqual([
      'IC memo',
      'Granola notes · Maya',
      'Flent — founder call',
      'Typed notes · Granola',
      'Aside',
    ])
    const lane = (title: string) =>
      [...el.querySelectorAll('li a')]
        .find((a) => a.textContent.startsWith(title))
        ?.querySelector('.mono')?.textContent
    expect(lane('Granola notes · Maya')).toBe(
      'via Granola · Maya · note · 10-19',
    )
    expect(lane('IC memo')).toBe('note · 10-19')
    expect(lane('Typed notes · Granola')).toBe(
      'meeting · via Granola · Anish · note · 10-19',
    )
    expect(lane('Aside')).toBe('mention · note · 10-19')

    await click(button(/^From meetings 3$/))
    expect(onFilterChange).toHaveBeenLastCalledWith('meetings')
    expect(titles()).toEqual([
      'Flent — founder call',
      'Granola notes · Maya',
      'Typed notes · Granola',
    ])
    // A hand-typed write-up carries no mark.
    expect(lane('Flent — founder call')).toBe('note · 10-19')

    await click(button(/^Mentions 1$/))
    expect(titles()).toEqual(['Aside'])
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

  it('reads a stored date as ISO text', async () => {
    const el = await mount(
      <ValueEditor
        def={def('date')}
        value="2026-11-30"
        variant="field"
        onSave={() => undefined}
      />,
    )
    expect(el.textContent).toBe('2026-11-30')
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
