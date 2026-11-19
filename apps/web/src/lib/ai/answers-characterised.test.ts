import { describe, expect, it } from 'vitest'
import { answerField, answerNotes, answerRecord } from './attribute-run'
import { readKindsAnswer } from './classify-document'
import { readCapTable } from './ledger-event'
import { readProviderMeta } from './providers/meta'
import { actionItemsOf } from './recorded-note-tasks'
import { readSpacesAnswer } from './suggest-spaces'
import { categoriesOf } from './summarize-email'
import { readToolList, readToolResult, rpcMessages } from '#/lib/ask/mount'

/**
 * The lenient readers: a model's structured answer, a provider's stored
 * meta, and a mounted MCP server's replies, each read at its edges. Every
 * row was held against the zod shapes before they were Effect schemas, so a
 * row that moves is an answer read differently. `null` (or the reader's
 * empty answer) is the refusal.
 */

type Row = readonly [label: string, input: unknown, out: unknown]

const table = (
  name: string,
  read: (input: unknown) => unknown,
  rows: ReadonlyArray<Row>,
) =>
  describe(name, () => {
    it.each(rows)('%s', (_, input, out) => {
      expect(read(input)).toEqual(out)
    })
  })

table('attribute-run: the answer record', answerRecord, [
  ['an object', { stage: { value: 1 } }, { stage: { value: 1 } }],
  ['an empty object', {}, {}],
  ['a list', [], null],
  ['text', 'stage', null],
  ['nothing', undefined, null],
  ['null', null, null],
  ['a date', new Date(0), null],
])

table(
  'attribute-run: the reason and new option',
  (input) =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? answerNotes(Object.fromEntries(Object.entries(input)))
      : 'not a record',
  [
    ['neither', { stage: 1 }, {}],
    [
      'both',
      { reason: ' Read it ', newOption: ' Climate ', stage: 1 },
      { reason: ' Read it ', newOption: ' Climate ' },
    ],
    ['a reason that is not text', { reason: 3 }, null],
    ['a null option', { newOption: null }, null],
  ],
)

table('attribute-run: one field', answerField, [
  [
    'a whole envelope',
    { value: 'seed', refs: ['note:1'], confidence: 0.4, extra: 1 },
    { value: 'seed', refs: ['note:1'], confidence: 0.4 },
  ],
  ['no refs', { value: 3, confidence: 1 }, { value: 3, confidence: 1 }],
  [
    'a null value',
    { value: null, confidence: 0 },
    { value: null, confidence: 0 },
  ],
  ['no value key at all', { confidence: 0.5 }, null],
  ['no confidence', { value: 'x' }, null],
  ['a confidence above one', { value: 'x', confidence: 1.01 }, null],
  ['a negative confidence', { value: 'x', confidence: -0.1 }, null],
  ['a confidence as text', { value: 'x', confidence: '0.5' }, null],
  ['an infinite confidence', { value: 'x', confidence: Infinity }, null],
  ['a NaN confidence', { value: 'x', confidence: Number.NaN }, null],
  ['refs that are not text', { value: 'x', confidence: 0.5, refs: [1] }, null],
  ['a bare value', 'seed', null],
])

table('classify-document: the kinds', (o) => readKindsAnswer(o)?.kinds ?? [], [
  [
    'kinds with and without confidence',
    {
      kinds: [
        { kind: 'deck', confidence: 0.9 },
        { kind: 'memo', x: 1 },
      ],
      reason: 'r',
    },
    [{ kind: 'deck', confidence: 0.9 }, { kind: 'memo' }],
  ],
  ['no kinds', { kinds: [] }, []],
  ['a kinds key missing', { reason: 'r' }, []],
  [
    'one kind out of range',
    { kinds: [{ kind: 'deck', confidence: 2 }, { kind: 'memo' }] },
    [],
  ],
  ['a reason that is not text', { kinds: [{ kind: 'deck' }], reason: 1 }, []],
  ['a list', [{ kind: 'deck' }], []],
  ['nothing', undefined, []],
])

table('suggest-spaces: the spaces', (o) => readSpacesAnswer(o)?.spaces ?? [], [
  [
    'spaces with and without confidence',
    { spaces: [{ spaceId: 's1', confidence: 0 }, { spaceId: 's2' }] },
    [{ spaceId: 's1', confidence: 0 }, { spaceId: 's2' }],
  ],
  ['a space id that is a number', { spaces: [{ spaceId: 1 }] }, []],
  [
    'a confidence below zero',
    { spaces: [{ spaceId: 's', confidence: -1 }] },
    [],
  ],
  ['nothing', null, []],
])

table('ledger-event: the cap table', readCapTable, [
  ['nothing read', {}, {}],
  [
    'a round and ownership',
    {
      round: {
        date: '2026-01-01',
        kind: 'Series A',
        raised: 5e6,
        currency: 'USD',
        preMoney: 2e7,
        postMoney: 2.5e7,
        pricePerShare: 1.25,
        sharesOutstanding: 2e7,
        extra: 1,
      },
      ownership: { ourShares: 1e5, fullyDilutedShares: 2e7, pct: 0.005 },
      reason: 'r',
    },
    {
      round: {
        date: '2026-01-01',
        kind: 'Series A',
        raised: 5e6,
        currency: 'USD',
        preMoney: 2e7,
        postMoney: 2.5e7,
        pricePerShare: 1.25,
        sharesOutstanding: 2e7,
      },
      ownership: { ourShares: 1e5, fullyDilutedShares: 2e7, pct: 0.005 },
      reason: 'r',
    },
  ],
  ['a round with no kind', { round: { date: '2026-01-01' } }, null],
  [
    'an infinite price',
    { round: { date: 'd', kind: 'k', pricePerShare: Infinity } },
    null,
  ],
  ['a NaN share count', { ownership: { ourShares: Number.NaN } }, null],
  ['a raise as text', { round: { date: 'd', kind: 'k', raised: '5m' } }, null],
  ['a null ownership', { ownership: null }, null],
  ['a list', [], null],
  ['text', 'cap table', null],
])

table('summarize-email: the categories', categoriesOf, [
  [
    'known ones kept, deduped and capped',
    { categories: ['pitch', 'spam', 'pitch', 'legal', 'admin', 'intro'] },
    ['pitch', 'legal', 'admin'],
  ],
  ['none', { categories: [] }, []],
  ['a category that is not text', { categories: ['pitch', 1] }, null],
  ['no categories key', {}, null],
  ['nothing', undefined, null],
])

table('recorded-note-tasks: the items', actionItemsOf, [
  [
    'items trimmed and deduped, a bad due dropped',
    {
      items: [
        { title: '  Send   the deck ', due: ' 2026-02-01 ' },
        { title: 'send the deck', due: null },
        { title: 'Book a call', due: 'Friday' },
        { title: 'Ping legal', due: 7 },
        { title: 'Read memo' },
        { title: '   ' },
      ],
    },
    [
      { title: 'Send the deck', due: '2026-02-01' },
      { title: 'Book a call', due: null },
      { title: 'Ping legal', due: null },
      { title: 'Read memo', due: null },
    ],
  ],
  ['a title that is not text', { items: [{ title: 1 }] }, null],
  ['no items key', {}, null],
  [
    'more than twenty',
    {
      items: Array.from({ length: 25 }, (_, i) => ({ title: `T${String(i)}` })),
    },
    Array.from({ length: 20 }, (_, i) => ({
      title: `T${String(i)}`,
      due: null,
    })),
  ],
])

table(
  'providers: the stored meta',
  (input) =>
    readProviderMeta(
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? Object.fromEntries(Object.entries(input))
        : {},
    ),
  [
    ['empty', {}, {}],
    [
      'every key',
      {
        baseUrl: 'https://gw.example/v1',
        headers: { 'X-A': '1' },
        display: 'sk-…abcd',
        lastTestedAt: '2026-01-01T00:00:00Z',
        lastTestOk: true,
        embedTestedAt: '2026-01-02T00:00:00Z',
        embedTestOk: false,
        embedTestModel: 'nomic-embed-text',
        other: 'kept by the column, not here',
      },
      {
        baseUrl: 'https://gw.example/v1',
        headers: { 'X-A': '1' },
        display: 'sk-…abcd',
        lastTestedAt: '2026-01-01T00:00:00Z',
        lastTestOk: true,
        embedTestedAt: '2026-01-02T00:00:00Z',
        embedTestOk: false,
        embedTestModel: 'nomic-embed-text',
      },
    ],
    [
      'a padded base URL, trimmed',
      { baseUrl: '  https://gw.example  ' },
      { baseUrl: 'https://gw.example' },
    ],
    [
      'a base URL that is not one, dropped',
      { baseUrl: 'gw', display: 'd' },
      { display: 'd' },
    ],
    ['a null base URL, dropped', { baseUrl: null }, {}],
    [
      'headers with a number, dropped',
      { headers: { 'X-A': 1 }, lastTestOk: true },
      { lastTestOk: true },
    ],
    ['headers that are a list, dropped', { headers: ['X-A: 1'] }, {}],
    [
      'a verdict as text, dropped',
      { lastTestOk: 'true', embedTestOk: 1, lastTestedAt: 5 },
      {},
    ],
  ],
)

table('ask mount: a tools/list result', readToolList, [
  [
    'tools, a description defaulted',
    {
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
          annotations: { readOnlyHint: true },
        },
        { name: 'fetch', inputSchema: { type: 'object' } },
      ],
      nextCursor: 'c',
    },
    [
      {
        name: 'search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
      { name: 'fetch', description: 'fetch', inputSchema: { type: 'object' } },
    ],
  ],
  ['no tools', { tools: [] }, []],
  [
    'a nameless tool',
    { tools: [{ name: '', inputSchema: { type: 'object' } }] },
    null,
  ],
  [
    'an input schema that is not an object schema',
    { tools: [{ name: 't', inputSchema: { type: 'string' } }] },
    null,
  ],
  ['no input schema', { tools: [{ name: 't' }] }, null],
  [
    'a description that is not text',
    { tools: [{ name: 't', description: 1, inputSchema: { type: 'object' } }] },
    null,
  ],
  ['no tools key', {}, null],
  ['nothing', undefined, null],
])

table('ask mount: a tools/call result', readToolResult, [
  [
    'text blocks joined, others skipped',
    {
      content: [
        { type: 'text', text: 'one' },
        { type: 'image', data: 'xx' },
        { type: 'text', text: 'two' },
      ],
      isError: false,
    },
    { text: 'one\n\ntwo', isError: false },
  ],
  ['an error', { content: [], isError: true }, { text: '', isError: true }],
  ['no error flag', { content: [] }, { text: '', isError: false }],
  ['an error flag as text', { content: [], isError: 'yes' }, null],
  ['a block with no type', { content: [{ text: 'x' }] }, null],
  ['no content', { isError: true }, null],
])

describe('ask mount: the JSON-RPC messages', () => {
  it('reads a JSON body, keeping what it does not name', () => {
    expect(
      rpcMessages(
        'application/json',
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      ),
    ).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }])
  })

  it('reads SSE events and a batch, dropping what is no message', () => {
    const body = [
      `data: ${JSON.stringify([{ id: 'a', error: { message: 'no', code: 1 } }, { id: {} }])}`,
      '',
      'event: ping',
      'data: not json',
      '',
      `data: ${JSON.stringify({ method: 'notifications/progress' })}`,
      '',
      `data: ${JSON.stringify({ id: 2, error: { code: 1 } })}`,
      '',
    ].join('\n')
    expect(rpcMessages('text/event-stream', body)).toEqual([
      { id: 'a', error: { message: 'no', code: 1 } },
      { method: 'notifications/progress' },
    ])
  })

  it('reads a null result as one', () => {
    expect(rpcMessages('application/json', '{"id":3,"result":null}')).toEqual([
      { id: 3, result: null },
    ])
  })
})
