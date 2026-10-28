import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  AskCardView,
  AskFindRow,
  AskSavedWatch,
  AskScopeChip,
  AskTurnView,
} from '#/lib/ask/types'
import type { LiveTurn } from './ask-thread'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode
    to: string
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouter: () => ({ navigate: () => Promise.resolve() }),
}))

vi.mock('#/lib/server-fns', () => ({
  askQuestion: vi.fn(),
  getAskThread: vi.fn(),
  saveAskAnswerAsNote: vi.fn(),
  applyAskCard: vi.fn(),
  skipAskCard: vi.fn(),
  actOnFindRow: vi.fn(),
  getSaveWatchSetup: vi.fn(),
  saveFindAsWatch: vi.fn(),
  previewAskRef: vi.fn(),
  searchAll: vi.fn(),
}))

const { AskTurns, AskComposer, applyAskEvent, settledThread } =
  await import('./ask-thread')

const win = new Window()
/** Static markup parsed into a node to query. */
const parse = (html: string) => {
  const host = win.document.createElement('div')
  host.innerHTML = html
  return host
}

/**
 * Ask's turns as the dock and `/ask` draw them: your turn right on
 * bone with a hairline, the answer left with no box and in sans, the scope
 * divider, and every terminal state's line.
 */

const ACME = '00000000-0000-4000-8000-00000000000a'

const turn = (over: Partial<AskTurnView>): AskTurnView => ({
  id: 't',
  role: 'user',
  body: '',
  refs: [],
  calls: [],
  cards: [],
  scope: [],
  state: null,
  route: null,
  savedAt: null,
  createdAt: '2026-10-12T09:30:00.000Z',
  hidden: false,
  ...over,
})

const question = (id: string, body: string, scopeName?: string) =>
  turn({
    id,
    body,
    scope:
      scopeName === undefined
        ? []
        : [
            {
              kind: 'record',
              id: ACME,
              name: scopeName,
              href: `/deals/${ACME}`,
            },
          ],
  })

const answer = (id: string, over: Partial<AskTurnView>) =>
  turn({ id, role: 'assistant', state: 'answered', ...over })

const render = (
  turns: ReadonlyArray<AskTurnView>,
  variant: 'dock' | 'page' = 'dock',
) => {
  return parse(
    renderToStaticMarkup(
      <AskTurns
        turns={turns}
        live={null}
        variant={variant}
        threadId="th"
        onRetry={() => {}}
        onStop={() => {}}
      />,
    ),
  )
}

describe('AskTurns', () => {
  it('puts your turn right on bone with a hairline and the answer left, unboxed, in sans with ref chips', () => {
    const host = render([
      question('q1', 'Which deals went quiet?'),
      answer('a1', {
        body: `Acme went quiet [record:${ACME}].`,
        refs: [
          {
            ref: `record:${ACME}`,
            label: 'Acme',
            href: `/deals/${ACME}`,
            entityId: ACME,
          },
        ],
        route: 'Anthropic · claude-opus-5',
        calls: [
          { tool: 'query_records', state: 'done', input: 'deals', found: 3 },
        ],
      }),
    ])
    const mine = host.querySelector('[data-turn="user"]')
    expect(mine?.className).toContain('items-end')
    const bubble = mine?.firstElementChild
    expect(bubble?.className).toContain('bg-bone')
    expect(bubble?.className).toContain('border-hairline')
    expect(bubble?.className).toContain('max-w-3/4')

    const theirs = host.querySelector('[data-turn="assistant"]')
    expect(theirs?.className).not.toContain('border')
    expect(theirs?.className).not.toContain('bg-')
    expect(theirs?.querySelector('.font-sans')).not.toBeNull()
    expect(theirs?.querySelector(`a[href="/deals/${ACME}"]`)?.textContent).toBe(
      'Acme',
    )
    expect(theirs?.textContent).toContain('query_records')
    expect(theirs?.textContent).toContain('Sources 1 ›')
  })

  it('refuses an unreferenced claim in a stored answer', () => {
    const host = render([
      question('q1', 'q'),
      answer('a1', { body: 'Acme is the best.' }),
    ])
    expect(host.textContent).toContain('A claim with no source was left out.')
    expect(host.textContent).not.toContain('Acme is the best.')
  })

  it('marks a scope change with a centred divider', () => {
    const host = render([
      question('q1', 'one', 'Acme'),
      answer('a1', { body: '', state: 'empty' }),
      question('q2', 'two'),
    ])
    const dividers = [...host.querySelectorAll('[role="separator"]')].map(
      (d) => d.textContent,
    )
    expect(dividers).toHaveLength(1)
    expect(dividers.at(0)).toMatch(/^Scope now Whole workspace · \d{2}:\d{2}$/)
  })

  it('prints the terminal states: hidden, no provider, refused, stopped, empty', () => {
    const host = render([
      question('q1', 'a'),
      answer('a1', { hidden: true }),
      question('q2', 'b'),
      answer('a2', {
        state: 'no_provider',
        route: 'Ask needs a model to answer',
      }),
      question('q3', 'c'),
      answer('a3', {
        state: 'refused',
        route: 'Refused · Sensitive material is not sent to Anthropic',
      }),
      question('q4', 'd'),
      answer('a4', {
        state: 'stopped',
        body: 'Partial',
        calls: [
          { tool: 'query_records', state: 'done', input: 'deals', found: 2 },
          { tool: 'get_record', state: 'done', input: 'Acme', found: 1 },
          { tool: 'get_context', state: 'failed', input: 'Acme', found: null },
        ],
      }),
      question('q5', 'e'),
      answer('a5', {
        state: 'empty',
        calls: [
          {
            tool: 'search_records',
            state: 'done',
            input: '“zeppelins”',
            found: 0,
          },
        ],
      }),
    ])
    const text = host.textContent
    expect(text).toContain(
      'An answer here cited something you can no longer see',
    )
    expect(host.querySelector('a[href="/settings/models"]')?.textContent).toBe(
      'Add a model ›',
    )
    expect(text).toContain('Sensitive space · nothing sent')
    expect(text).toContain('Stopped · 2 of 3 calls')
    expect(text).toContain('Nothing found.')
    expect(text).toContain('“zeppelins”')
  })

  it('adds day dividers on /ask only', () => {
    const turns = [question('q1', 'a'), answer('a1', { state: 'empty' })]
    expect(
      render(turns, 'dock').querySelectorAll('[role="separator"]'),
    ).toHaveLength(0)
    expect(
      render(turns, 'page').querySelectorAll('[role="separator"]'),
    ).toHaveLength(1)
  })
})

describe('AskComposer', () => {
  it('prints ⌘↵ once in its end lane, never esc or a bare ↵, and has no Send button', () => {
    const host = parse(
      renderToStaticMarkup(
        <AskComposer
          value="hi"
          onChange={() => {}}
          onSend={() => {}}
          streaming={false}
          focus={0}
        />,
      ),
    )
    const text = host.textContent
    expect(text.match(/⌘↵/g)).toHaveLength(1)
    expect(text.toLowerCase()).not.toContain('esc')
    expect(text.replace('⌘↵', '')).not.toContain('↵')
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('holds the chips inside its one box, and prints nothing with none', () => {
    const chips = (scope: ReadonlyArray<AskScopeChip>) =>
      parse(
        renderToStaticMarkup(
          <AskComposer
            value=""
            onChange={() => {}}
            onSend={() => {}}
            scope={scope}
            onRemoveChip={() => {}}
            webSources={['Exa']}
            streaming={false}
            focus={0}
          />,
        ),
      )
    const host = chips([
      { kind: 'record', id: ACME, name: 'Exponent', href: `/deals/${ACME}` },
      { kind: 'web', id: null, name: 'Web', href: null },
    ])
    const box = host.querySelector('[data-composer]')
    expect(box?.querySelectorAll('[data-chip]')).toHaveLength(2)
    expect(box?.querySelector('[data-chip="web"]')?.className).toContain(
      'bg-bone',
    )
    expect(
      [...(box?.querySelectorAll('[data-chip]') ?? [])].map(
        (c) => c.textContent,
      ),
    ).toEqual(['Exponent', 'Web · Exa'])
    expect(
      [...(box?.querySelectorAll('[data-chip] button') ?? [])].map((b) =>
        b.getAttribute('title'),
      ),
    ).toEqual(['Ask beyond Exponent', 'Leave the web out'])
    const none = chips([])
    expect(none.querySelector('[data-chips]')).toBeNull()
    expect(none.textContent).not.toContain('Whole workspace')
  })
})

describe('the live turn', () => {
  const live = (over: Partial<LiveTurn>): LiveTurn => ({
    question: question('q', 'Who went quiet?'),
    answerId: 'a',
    route: 'Anthropic · claude-opus-5',
    text: '',
    calls: [],
    cards: [],
    phase: 'streaming',
    ...over,
  })
  const renderLive = (l: LiveTurn) =>
    parse(
      renderToStaticMarkup(
        <AskTurns
          turns={[]}
          live={l}
          variant="dock"
          threadId="th"
          onRetry={() => {}}
          onStop={() => {}}
        />,
      ),
    )

  it('puts Stop in the turn as an outline button at its right, with a Twinkle and what it is reading', () => {
    const host = renderLive(
      live({
        calls: [
          {
            id: 'c1',
            call: {
              tool: 'query_records',
              state: 'done',
              input: 'deals',
              found: 4,
            },
          },
          {
            id: 'c2',
            call: {
              tool: 'get_record',
              state: 'running',
              input: 'Acme',
              found: null,
            },
          },
        ],
      }),
    )
    const answerTurn = host.querySelector('[data-turn="assistant"]')
    const stop = answerTurn?.querySelector('button')
    expect(stop?.textContent).toBe('Stop')
    expect(stop?.getAttribute('data-variant')).toBe('outline')
    expect(stop?.className).toContain('ml-auto')
    const thinking = answerTurn?.querySelector('[data-thinking]')
    expect(thinking?.querySelector('[data-twinkle]')).not.toBeNull()
    expect(thinking?.textContent).toBe('Reading 4 sources')
    expect(answerTurn?.textContent).toContain('Running')
  })

  it('has no Stop once the turn has stopped', () => {
    const host = renderLive(live({ phase: 'stopped', text: 'Partial' }))
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Stopped')
  })
})

describe('the notice row', () => {
  it('renders for a sensitive turn, a capped one and a refused one', () => {
    const host = render([
      question('q1', 'a'),
      answer('a1', {
        body: `Acme went quiet [record:${ACME}].`,
        refs: [
          {
            ref: `record:${ACME}`,
            label: 'Acme',
            href: `/deals/${ACME}`,
            entityId: ACME,
          },
        ],
        route:
          'Sensitive (inherited from Fund II) · answered locally by Ollama · llama3.2',
      }),
      question('q2', 'b'),
      answer('a2', {
        state: 'capped',
        route:
          'Daily AI cap reached · 200,412 of 200,000 tokens · resets 00:00 UTC',
      }),
      question('q3', 'c'),
      answer('a3', {
        state: 'refused',
        route: 'Refused · Sensitive material is not sent to Anthropic',
      }),
    ])
    const notices = [...host.querySelectorAll('[data-notice]')]
    expect(notices.map((n) => n.getAttribute('data-notice'))).toEqual([
      'warning',
      'destructive',
      'destructive',
    ])
    expect(notices.at(0)?.textContent).toBe(
      'Sensitive space in scope · answered on the local model',
    )
    expect(notices.at(1)?.textContent).toContain('Daily AI cap reached')
    expect(notices.at(1)?.querySelector('a')?.getAttribute('href')).toBe(
      '/settings/usage',
    )
    expect(notices.at(2)?.textContent).toContain(
      'Sensitive space · nothing sent',
    )
    expect(notices.at(2)?.querySelector('a')?.textContent).toBe(
      'Add a local model ›',
    )
    // The foot keeps Provider · model.
    expect(host.textContent).toContain('Ollama · llama3.2')
  })
})

describe('applyAskEvent', () => {
  it('drops the text of an attempt a new route replaces', () => {
    const live = {
      question: question('q', 'x'),
      answerId: null,
      route: 'Anthropic · m',
      text: 'half an answer',
      calls: [],
      cards: [],
      phase: 'streaming' as const,
    }
    const next = applyAskEvent(live, {
      type: 'route',
      line: 'Sensitive · answered locally by Ollama · llama3.2',
      sensitive: true,
    })
    expect(next.text).toBe('')
    expect(next.route).toContain('Ollama')
  })
})

describe('settledThread', () => {
  it('reads again until a stopped answer has left streaming', async () => {
    const states: Array<AskTurnView['state']> = [
      'streaming',
      'streaming',
      'stopped',
    ]
    let reads = 0
    const read = async () => ({
      id: 'th',
      title: 't',
      createdAt: '2026-10-12T09:30:00.000Z',
      turns: [
        question('q', 'x'),
        answer('a', {
          state: states[Math.min(reads++, 2)] ?? null,
          body: 'Partial',
        }),
      ],
    })
    const settled = await settledThread(read, 'th', 'a', 10, 0)
    expect(reads).toBe(3)
    expect(settled?.turns.at(1)?.state).toBe('stopped')
  })
})

describe('action cards', () => {
  const card = (over: Partial<AskCardView>): AskCardView => ({
    id: 'sg',
    kind: 'task',
    record: { id: ACME, name: 'Acme', href: `/companies/${ACME}` },
    summary: 'Call Acme · due 2026-10-20',
    rationale: 'Quiet for sixty days',
    evidence: [
      {
        ref: `record:${ACME}`,
        label: 'Acme',
        href: `/companies/${ACME}`,
        entityId: ACME,
      },
    ],
    outcome: 'open',
    by: null,
    moved: null,
    ...over,
  })
  const withCards = (cards: ReadonlyArray<AskCardView>) =>
    render([question('q1', 'Who went quiet?'), answer('a1', { cards })])

  it('draws an open card with its evidence, one pine Apply and Skip as the outline secondary', () => {
    const host = withCards([card({})])
    const li = host.querySelector('[data-card="task"]')
    expect(li?.textContent).toContain('Create task')
    expect(li?.textContent).toContain('Call Acme · due 2026-10-20')
    expect(li?.querySelector(`a[href="/companies/${ACME}"]`)).not.toBeNull()
    const buttons = [...(li?.querySelectorAll('button') ?? [])]
    expect(buttons.map((b) => b.textContent)).toEqual(['Skip', 'Apply'])
    expect(buttons.map((b) => b.getAttribute('data-variant'))).toEqual([
      'outline',
      'default',
    ])
    expect(host.textContent).toContain('1 card')
  })

  it('prints a decided card as a mono state word, never a disabled button', () => {
    const host = withCards([
      card({ id: 'a', outcome: 'applied' }),
      card({ id: 'b', kind: 'move_stage', outcome: 'conflict' }),
      card({ id: 'c', outcome: 'skipped' }),
    ])
    expect(host.querySelectorAll('[data-card] button')).toHaveLength(0)
    expect(host.textContent).toContain('Applied · in Tasks')
    expect(host.textContent).toContain('Not applied · already at that stage')
    expect(host.textContent).toContain('Skipped')
  })

  it('dashes a proposed card, and sends an undecided earlier one to Review', () => {
    const proposed = withCards([card({ outcome: 'proposed' })])
    expect(proposed.querySelector('[data-card]')?.className).toContain(
      'border-dashed',
    )
    const host = render([
      question('q1', 'Who went quiet?'),
      answer('a1', { cards: [card({})] }),
      question('q2', 'And now?'),
      answer('a2', { state: 'empty' }),
    ])
    expect(host.querySelector('a[href="/review"]')?.textContent).toBe(
      'Waiting in Review ›',
    )
  })

  it('refuses a card without evidence', () => {
    const host = withCards([card({ evidence: [] })])
    expect(host.querySelector('[data-card]')).toBeNull()
    expect(host.textContent).toContain('A card with no evidence was left out.')
  })
})

describe('a find table', () => {
  const via = { integrationId: 'exa', name: 'Exa' }
  const row = (name: string, standing: AskFindRow['standing']): AskFindRow => ({
    name,
    domain: `${name.toLowerCase()}.example`,
    line: `${name} does rentals`,
    place: 'Bengaluru',
    sources: [{ url: `https://${name.toLowerCase()}.example/` }],
    via,
    standing,
    entityId: standing === 'unknown' ? null : ACME,
  })
  const withTable = (
    rows: Array<AskFindRow>,
    hidden: number,
    savedWatch?: AskSavedWatch,
  ) =>
    render([
      question('q1', 'Rental software startups in India'),
      answer('a1', {
        body: 'Fourteen operators turned up.',
        calls: [
          {
            tool: 'web_search_exa',
            state: 'done',
            input: '“rental software”',
            found: 14,
            via,
          },
          {
            tool: 'web',
            state: 'unmounted',
            input: '',
            found: null,
            via,
          },
          {
            tool: 'show_companies',
            state: 'done',
            input: '16 companies',
            found: rows.length,
            find: {
              space: { id: 's', name: 'Property ops' },
              rows,
              hidden,
              ...(savedWatch === undefined ? {} : { savedWatch }),
            },
          },
        ],
      }),
    ])

  it('greys a filed row with no control, offers File here and Add, and folds past twelve', () => {
    const rows = [
      row('Leasewise', 'filed'),
      row('Keyhold', 'held'),
      ...Array.from({ length: 12 }, (_, i) => row(`Op${String(i)}`, 'unknown')),
    ]
    const host = withTable(rows, 2)
    const trs = [...host.querySelectorAll('tbody tr')]
    expect(trs).toHaveLength(12)
    const filed = host.querySelector('tr[data-standing="filed"]')
    expect(filed?.querySelectorAll('button')).toHaveLength(0)
    expect(filed?.textContent).toContain('Filed')
    const held = host.querySelector('tr[data-standing="held"]')
    expect(held?.textContent).toContain('File here')
    expect(
      host.querySelector('tr[data-standing="unknown"]')?.textContent,
    ).toContain('Add')
    expect(host.textContent).toContain('+2 more · 2 hidden')
    expect(host.textContent).toContain('Exa')
  })

  it('marks a plugin call with its provider in the strip, and an unmounted cell as such', () => {
    const host = withTable([row('Leasewise', 'filed')], 0)
    const strip = host.querySelector('[aria-label="Tools called"]')
    expect(strip?.textContent).toContain('web_search_exa')
    expect(strip?.textContent).toContain('Unmounted')
    expect(strip?.querySelector('[title="via Exa"]')).not.toBeNull()
  })

  it('keeps the line to the watch it was saved as, and says so once the watch is deleted', () => {
    const saved = { id: 'w1', spaceId: 's', spaceName: 'Property ops' }
    const live = withTable([row('Keyhold', 'unknown')], 0, saved)
    const line = live.querySelector('[data-saved-watch="live"]')
    expect(line?.textContent).toBe('Saved as a watch on Property ops ›')
    expect(line?.querySelector('a')?.getAttribute('href')).toBe(
      '/spaces/$spaceId',
    )
    const gone = withTable([row('Keyhold', 'unknown')], 0, {
      ...saved,
      deleted: true,
    })
    expect(gone.querySelector('[data-saved-watch="live"]')).toBeNull()
    expect(
      gone.querySelector('[data-saved-watch="deleted"]')?.textContent,
    ).toBe('Saved as a watch on Property ops · watch deleted')
    expect(gone.querySelector('[data-saved-watch="deleted"] a')).toBeNull()
  })

  it('has no head until a table is saved or an engine can watch it', () => {
    const host = withTable([row('Keyhold', 'unknown')], 0)
    expect(host.querySelector('[data-saved-watch]')).toBeNull()
    expect(host.textContent).not.toContain('Save as watch')
  })
})
