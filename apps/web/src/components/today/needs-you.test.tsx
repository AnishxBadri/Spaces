import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NeedsYou } from './needs-you'
import type { NeedsYouRow, ProposalActions } from './needs-you'
import type { NeedsFilter } from '#/lib/today/needs-you'
import { flattenInbox } from '#/lib/today/proposals'
import type { Proposal } from '#/lib/today/proposals'
import type {
  InboxRow,
  InboxSide,
  SuggestionItem,
  SuggestionRow,
} from '#/lib/server-fns'

/**
 * The Needs-you rows: one set of lanes for every kind — kind, mark, body,
 * action, who, figure, `···` — and Review as one row per proposal, whose
 * verbs take the who and figure lanes on hover.
 */

// The composer reads the session from the app route; it is not under test.
vi.mock('#/components/task-composer', () => ({
  TaskComposer: () => null,
}))

const task = (
  over: Partial<Extract<NeedsYouRow, { kind: 'task' }>> = {},
): NeedsYouRow => ({
  kind: 'task',
  key: 'task:t1',
  weight: 2,
  sensitive: null,
  task: {
    id: '00000000-0000-4000-8000-00000000000a',
    content: 'Chase the data room',
    dueDate: '2026-10-08',
    assigneeId: 'u2',
    entities: [],
  },
  record: 'Flent',
  who: 'Anika Rao',
  due: '−2d',
  late: true,
  ...over,
})

const deal: NeedsYouRow = {
  kind: 'deal',
  key: 'deal:d1',
  weight: 10,
  sensitive: null,
  id: '00000000-0000-4000-8000-0000000000d1',
  name: 'Exponent Seed',
  stage: 'Diligence',
  days: 32,
  median: 14,
  who: 'Priya Raman',
}

const mark: NeedsYouRow = {
  kind: 'mark',
  key: 'mark:h1',
  weight: 214,
  sensitive: 'Northgate',
  holdingId: '00000000-0000-4000-8000-0000000000b1',
  company: 'Northgate',
  value: '$3.0M',
  age: 214,
}

const meeting: NeedsYouRow = {
  kind: 'meeting',
  key: 'meeting:m1',
  weight: 2,
  sensitive: null,
  id: 'm1',
  title: 'Flent intro',
  record: 'Flent',
  who: 'Priya Raman',
  figure: '2d',
}

const ACTIONS: ProposalActions = {
  decide: () => {},
  acceptAll: () => {},
  canAddOption: true,
  since: () => '2d',
}

async function render(
  rows: ReadonlyArray<NeedsYouRow>,
  {
    filter = 'all',
    loading = false,
    actions = ACTIONS,
  }: {
    filter?: NeedsFilter
    loading?: boolean
    actions?: ProposalActions
  } = {},
) {
  const root = createRootRoute({
    component: () => (
      <NeedsYou
        rows={rows}
        filter={filter}
        onFilter={() => {}}
        readout={null}
        loading={loading}
        onComplete={() => {}}
        onOpen={() => {}}
        taskMenu={() => [
          { label: 'Due date…', onSelect: () => {} },
          { label: 'Assign…', onSelect: () => {} },
        ]}
        onCreated={() => {}}
        washes={() => false}
        actions={actions}
      />
    ),
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

/** The markup of the one row of `kind`. */
function rowOf(html: string, kind: string): string {
  const at = html.indexOf(`data-needs-row="${kind}"`)
  if (at === -1) throw new Error(`no ${kind} row`)
  const end = html.indexOf('</li>', at)
  return html.slice(at, end)
}

describe('the Needs-you lanes', () => {
  it('draws a task: caps kind, checkbox, body and record, who, a bad figure, the ···', async () => {
    const html = rowOf(await render([task()]), 'task')
    expect(html).toMatch(/w-16[^"]*label-caps[^"]*text-graphite[^>]*>task</)
    expect(html).toContain('aria-label="Complete task"')
    expect(html).toMatch(/text-body text-foreground[^>]*>Chase the data room</)
    expect(html).toMatch(/text-label[^>]*>Flent</)
    expect(html).toMatch(/w-30[^>]*>Anika Rao</)
    expect(html).toMatch(/w-12[^"]*text-destructive[^>]*>−2d</)
    expect(html).toContain('href="/tasks?task=')
    // The row `···` is the task menu.
    expect(html).toContain('aria-label="More for Chase the data room"')
  })

  it("leaves the who lane blank on the reader's own task (H2)", async () => {
    const html = rowOf(await render([task({ who: null })]), 'task')
    expect(html).toMatch(
      /w-30 shrink-0 truncate text-label text-graphite"><\/span>/,
    )
    expect(html).not.toContain('Anika Rao')
  })

  it('draws a deal: its stage, days against the median, the owner, days in stage', async () => {
    const html = rowOf(await render([deal]), 'deal')
    expect(html).toContain('href="/deals/00000000-0000-4000-8000-0000000000d1"')
    expect(html).toMatch(/>Exponent Seed</)
    expect(html).toMatch(/>Diligence</)
    expect(html).toContain('title="Median 14d in Diligence"')
    expect(html).toMatch(/<svg width="120" height="8"/)
    expect(html).toMatch(/w-30[^>]*>Priya Raman</)
    expect(html).toMatch(/text-destructive[^>]*>32d</)
  })

  it('draws a mark: the value in mono, no who, the age, and a lock when sensitive', async () => {
    const html = rowOf(await render([mark]), 'mark')
    expect(html).toMatch(/>Northgate</)
    expect(html).toMatch(/mono text-micro[^>]*>\$3\.0M</)
    expect(html).not.toContain('last mark')
    expect(html).not.toContain('record mark')
    expect(html).toMatch(/text-destructive[^>]*>214d</)
    expect(html).toContain('aria-label="Sensitive · AI never reads Northgate"')
  })

  it('draws a meeting: Write in the action lane, the first external participant', async () => {
    const html = rowOf(await render([meeting]), 'meeting')
    expect(html).toMatch(/>Flent intro</)
    expect(html).toMatch(/<button[^>]*>Write<\/button>/)
    expect(html).toMatch(/w-30[^>]*>Priya Raman</)
    expect(html).toMatch(/>2d</)
  })
})

const SPACE = '00000000-0000-4000-8000-0000000000a1'
const PERSON = '00000000-0000-4000-8000-0000000000c1'

const suggestion = (over: Partial<SuggestionItem>): SuggestionItem => ({
  id: 's1',
  kind: 'attribute_patch',
  payload: {},
  rationale: null,
  citations: [],
  fields: null,
  origin: { via: 'app' },
  source: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  runId: null,
  ...over,
})

const card = (
  item: SuggestionItem,
  page: SuggestionRow['page'] = null,
): SuggestionRow => ({
  kind: 'suggestion',
  id: 'r1',
  record: {
    id: 'r1',
    name: 'Exponent',
    kind: 'company',
    objectSlug: null,
    objectSingular: null,
  },
  page,
  suggestions: [item],
  latestAt: item.createdAt,
})

const discovery = (item: SuggestionItem): InboxRow => ({
  kind: 'discovery',
  id: SPACE,
  space: { id: SPACE, name: 'Property ops', path: 'Proptech / Property ops' },
  via: ['Exa'],
  suggestions: [item],
  latestAt: item.createdAt,
})

/** The queue's rows as Today's Review rows. */
const reviewRows = (rows: ReadonlyArray<InboxRow>): NeedsYouRow[] =>
  flattenInbox(rows, { today: '2026-10-28', filedIn: {} }).map(
    (p: Proposal): NeedsYouRow => ({
      kind: 'review',
      key: `review:${p.key}`,
      weight: 0,
      sensitive: null,
      proposal: p,
      figure: '2d',
    }),
  )

/** The verbs a row shows on hover, in order. */
function verbsOf(html: string): string[] {
  const at = html.indexOf('data-verbs')
  if (at === -1) throw new Error('no verbs')
  const end = html.indexOf('</li>', at)
  return [...html.slice(at, end).matchAll(/>([^<>]+)<\/(?:button|a)>/g)].map(
    (m) => m[1],
  )
}

describe('a proposal row', () => {
  it('reads subject, line and who, and opens Review on its record', async () => {
    const html = rowOf(
      await render(
        reviewRows([
          card(
            suggestion({
              source: 'Apollo',
              fields: [
                {
                  slug: 'funding_stage',
                  name: 'Funding stage',
                  type: 'select',
                  options: { options: [{ id: 'a', label: 'Series A' }] },
                  isSystem: false,
                  value: 'a',
                  current: null,
                  confidence: null,
                },
              ],
            }),
          ),
        ]),
      ),
      'review',
    )
    expect(html).toMatch(/w-16[^>]*>review</)
    expect(html).toMatch(/text-body text-foreground[^>]*>Exponent</)
    expect(html).toMatch(/text-label[^>]*>Funding stage → Series A</)
    expect(html).toMatch(/w-30[^>]*>Via Apollo</)
    expect(html).toContain('href="/review?record=r1"')
    // The verbs take the who and figure lanes on hover, on bone.
    expect(html).toMatch(/data-verbs[^>]*group-hover:flex/)
    expect(html).toMatch(/w-30[^"]*group-hover:invisible/)
    expect(html).not.toContain('<svg')
  })

  it.each<[string, SuggestionItem, SuggestionRow['page'], string]>([
    ['attribute_patch', suggestion({}), null, 'Accept'],
    ['document_kind', suggestion({ kind: 'document_kind' }), null, 'Accept'],
    [
      'supersedes',
      suggestion({ kind: 'supersedes' }),
      null,
      'Mark as newer version',
    ],
    ['space_tag', suggestion({ kind: 'space_tag' }), null, 'Add to space'],
    ['note', suggestion({ kind: 'note' }), null, 'Add note'],
    ['ledger_event', suggestion({ kind: 'ledger_event' }), null, 'Record mark'],
    [
      'captured identity',
      suggestion({ kind: 'identity', payload: { name: 'Priya Raman' } }),
      { title: 'Priya Raman — LinkedIn', url: null },
      'File on Priya Raman',
    ],
    ['task', suggestion({ kind: 'task' }), null, 'Add task'],
    [
      'option proposal',
      suggestion({
        fields: [],
        rationale: 'Proposed new option "Climate" for Sector (sector).',
      }),
      null,
      'Add option',
    ],
  ])(
    'offers Dismiss and its primary: %s',
    async (_kind, item, page, primary) => {
      const html = await render(reviewRows([card(item, page)]))
      expect(verbsOf(html)).toEqual(['Dismiss', primary])
    },
  )

  it("offers a member no Add option: the registry is an admin's", async () => {
    const html = await render(
      reviewRows([
        card(
          suggestion({
            fields: [],
            rationale: 'Proposed new option "Climate" for Sector (sector).',
          }),
        ),
      ]),
      { actions: { ...ACTIONS, canAddOption: false } },
    )
    expect(verbsOf(html)).toEqual(['Dismiss'])
  })

  it('offers a duplicate Not the same, and Compare into Review', async () => {
    const side = (id: string, name: string): InboxSide => ({
      id,
      name,
      kind: 'company',
      createdAt: '2026-10-01T00:00:00.000Z',
      objectSlug: 'company',
      objectSingular: 'Company',
      sourceClass: 'manual',
      sourceCapability: null,
      label: 'manual',
      domains: [],
      identityDomain: null,
      otherNames: [],
      mentionCount: 0,
      valueCount: 0,
      spaces: [],
    })
    const html = await render(
      reviewRows([
        {
          kind: 'duplicate_candidate',
          id: 'p1',
          score: 0.9,
          reason: { shared: 'domain' },
          latestAt: '2026-10-19T00:00:00.000Z',
          a: side('a1', 'Acme'),
          b: side('b1', 'Acme Inc'),
        },
      ]),
    )
    expect(html).toContain('Acme ⇄ Acme Inc')
    expect(html).toContain('Possibly the same · domain on both')
    expect(verbsOf(html)).toEqual(['Not the same', 'Compare'])
    expect(html).toContain('href="/review?record=a1&amp;lane=duplicates"')
  })

  it("draws a watch's space as a group: ▸, its counts, Open in Review", async () => {
    const add = suggestion({
      kind: 'add_record',
      source: 'Exa',
      payload: {
        spaceId: SPACE,
        domain: 'rentwise.com',
        name: 'Rentwise',
        evidence: [],
        aliases: [],
        subspaceHint: null,
      },
    })
    const html = rowOf(await render(reviewRows([discovery(add)])), 'review')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('▸')
    expect(html).toMatch(/>Proptech \/ Property ops</)
    expect(html).toMatch(/>1 to add</)
    expect(html).toMatch(/w-30[^>]*>Via Exa</)
    expect(verbsOf(html)).toEqual(['Open in Review ›'])
    expect(html).toContain(`href="/review?space=${SPACE}"`)
  })

  it('draws a column run with Accept all and an Ask thread with Open thread', async () => {
    const patch = suggestion({
      id: 'c1',
      runId: 'run1',
      fields: [
        {
          slug: 'hq',
          name: 'HQ',
          type: 'text',
          options: null,
          isSystem: false,
          value: 'Pune',
          current: null,
          confidence: null,
        },
      ],
    })
    const run = await render(
      reviewRows([
        {
          kind: 'column_run',
          id: 'run1',
          run: {
            id: 'run1',
            task: 'Column run · HQ',
            status: 'done',
            error: null,
            rowsRun: 1,
            startedAt: '2026-10-20T10:00:00.000Z',
            author: 'Anika Rao',
          },
          attributeSlug: 'hq',
          cards: [card(patch)],
          latestAt: '2026-10-20T10:00:00.000Z',
        },
      ]),
    )
    expect(run).toMatch(/w-30[^>]*>Anika Rao</)
    expect(verbsOf(run)).toEqual(['Open in Review ›', 'Accept all 1'])

    const ask = await render(
      reviewRows([
        {
          kind: 'ask_cards',
          id: 'th1',
          title: 'Who leads Exponent?',
          cards: [card(suggestion({ id: 'k1' }))],
          latestAt: '2026-10-20T10:00:00.000Z',
        },
      ]),
    )
    expect(ask).toMatch(/w-30[^>]*>Via Ask</)
    expect(verbsOf(ask)).toEqual(['Open thread ›'])
    expect(ask).toContain('href="/ask?thread=th1"')
  })

  it('counts top-level rows in the Review segment, not their children', async () => {
    const two = (id: string) =>
      suggestion({
        id,
        kind: 'file_record',
        payload: {
          spaceId: SPACE,
          domain: `${id}.com`,
          name: id,
          evidence: [],
          entityId: PERSON,
        },
      })
    const group: InboxRow = {
      kind: 'discovery',
      id: SPACE,
      space: { id: SPACE, name: 'Property ops', path: 'Property ops' },
      via: [],
      suggestions: [two('x'), two('y')],
      latestAt: '2026-10-20T10:00:00.000Z',
    }
    const html = await render(
      reviewRows([group, card(suggestion({ id: 'z' }))]),
    )
    expect(html).toMatch(/>Review<span data-segment-count[^>]*>2</)
  })
})

describe('the Needs-you head', () => {
  it('carries no count, and a Segmented of the kinds that have rows', async () => {
    const html = await render([task(), deal, mark])
    expect(html).not.toContain('data-section-count')
    expect(html).toContain('aria-label="Needs you by kind"')
    expect(html).toMatch(/aria-checked="true"[^>]*>All</)
    for (const label of ['Tasks', 'Deals', 'Marks'])
      expect(html).toMatch(new RegExp(`>${label}<span data-segment-count`))
    expect(html).not.toMatch(/>Review</)
    expect(html).not.toMatch(/>Meetings</)
  })

  it('shows the loading row while the attention read is out', async () => {
    const html = await render([task()], { loading: true })
    expect(html).toContain('data-twinkle')
    expect(html).toContain('Loading what needs you')
  })
})

describe('the Needs-you fold', () => {
  const tasks = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      task({ key: `task:${i}`, task: { ...taskOf(i) } }),
    )
  const taskOf = (i: number) => ({
    id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    content: `Task ${i}`,
    dueDate: '2026-10-08',
    assigneeId: 'u2',
    entities: [],
  })

  it('folds eleven rows at eight and names what it hides', async () => {
    const html = await render(tasks(11))
    expect(html.match(/data-needs-row="task"/g)).toHaveLength(8)
    expect(html).toContain('3 more · 3 tasks')
    expect(html).toContain('Show all ›')
  })

  it('shows ten rows whole rather than fold two away', async () => {
    const html = await render(tasks(10))
    expect(html.match(/data-needs-row="task"/g)).toHaveLength(10)
    expect(html).not.toContain('Show all ›')
  })
})
