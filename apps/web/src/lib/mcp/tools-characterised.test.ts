import { Effect, Predicate, Result } from 'effect'
import { asSchema } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showCompaniesInput } from '#/lib/ask/find'
import {
  ASK_TOOLS,
  MCP_TOOLS,
  modelInputSchema,
  toolRegistry,
} from './registry'
import { buildMcpServer } from './server'

/**
 * The tool table at its edges, as each client meets it: the `tools/list` an
 * external MCP client reads, what a `tools/call` hands the registry (or the
 * refusal it answers), what each tool's own decode takes, and the schema and
 * verdict Ask's model is given. Every literal was recorded against the zod
 * shapes the tools had before they were Effect schemas, so a row that moves
 * is a client who sees a different answer.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const REFUSED = 'REFUSED'

type Row = readonly [tool: string, label: string, input: unknown, out: unknown]

const ROWS: ReadonlyArray<Row> = [
  ['get_context', 'a name', { entity: 'Acme' }, { entity: 'Acme' }],
  ['get_context', 'an empty name', { entity: '' }, REFUSED],
  ['get_context', 'no entity', {}, REFUSED],
  ['get_context', 'nothing', undefined, REFUSED],
  ['get_context', 'an array', [], REFUSED],
  [
    'get_context',
    'every field',
    { entity: ID, task: '  diligence ', budget: 500 },
    { entity: ID, task: '  diligence ', budget: 500 },
  ],
  [
    'get_context',
    'the top budget',
    { entity: 'a', budget: 100_000 },
    { entity: 'a', budget: 100_000 },
  ],
  ['get_context', 'a budget too small', { entity: 'a', budget: 499 }, REFUSED],
  [
    'get_context',
    'a budget too big',
    { entity: 'a', budget: 100_001 },
    REFUSED,
  ],
  [
    'get_context',
    'a fractional budget',
    { entity: 'a', budget: 600.5 },
    REFUSED,
  ],
  ['get_context', 'a budget as text', { entity: 'a', budget: '600' }, REFUSED],
  ['get_context', 'a null task', { entity: 'a', task: null }, REFUSED],
  [
    'get_context',
    'a stray key',
    { entity: 'a', role: 'admin' },
    { entity: 'a' },
  ],

  ['get_record', 'an id', { id: ID }, { id: ID }],
  [
    'get_record',
    'an upper-case id',
    { id: ID.toUpperCase() },
    { id: ID.toUpperCase() },
  ],
  [
    'get_record',
    'the nil id',
    { id: '00000000-0000-0000-0000-000000000000' },
    { id: '00000000-0000-0000-0000-000000000000' },
  ],
  [
    'get_record',
    'the max id',
    { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
  ],
  [
    'get_record',
    'the upper-case max id',
    { id: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' },
    REFUSED,
  ],
  [
    'get_record',
    'a version-0 id',
    { id: '0b6ad7a2-6a3e-0c4f-9a43-5d1f1d8b6c11' },
    REFUSED,
  ],
  ['get_record', 'a name', { id: 'Acme' }, REFUSED],
  ['get_record', 'a padded id', { id: ` ${ID}` }, REFUSED],

  [
    'propose_suggestion',
    'a patch',
    {
      entity: 'Acme',
      patch: { stage: { value: 'seed', refs: ['note:1'], confidence: 0.5 } },
      rationale: 'Read it',
    },
    {
      entity: 'Acme',
      patch: { stage: { value: 'seed', refs: ['note:1'], confidence: 0.5 } },
      rationale: 'Read it',
    },
  ],
  [
    'propose_suggestion',
    'any JSON in the patch, and refs',
    {
      entity: 'Acme',
      patch: { a: null, b: [1, 'x', { c: true }], d: 'text', e: 3 },
      rationale: 'r',
      refs: ['note:1', ''],
    },
    {
      entity: 'Acme',
      patch: { a: null, b: [1, 'x', { c: true }], d: 'text', e: 3 },
      rationale: 'r',
      refs: ['note:1', ''],
    },
  ],
  [
    'propose_suggestion',
    'an empty patch',
    { entity: 'Acme', patch: {}, rationale: 'r' },
    { entity: 'Acme', patch: {}, rationale: 'r' },
  ],
  [
    'propose_suggestion',
    'a patch that is a list',
    { entity: 'Acme', patch: [], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_suggestion',
    'a patch that is text',
    { entity: 'Acme', patch: 'x', rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_suggestion',
    'an empty rationale',
    { entity: 'Acme', patch: {}, rationale: '' },
    REFUSED,
  ],
  [
    'propose_suggestion',
    'a blank rationale',
    { entity: 'Acme', patch: {}, rationale: '   ' },
    { entity: 'Acme', patch: {}, rationale: '   ' },
  ],
  [
    'propose_suggestion',
    'refs that are not strings',
    { entity: 'Acme', patch: {}, rationale: 'r', refs: [1] },
    REFUSED,
  ],
  [
    'propose_suggestion',
    'no patch',
    { entity: 'Acme', rationale: 'r' },
    REFUSED,
  ],

  ['search_records', 'a query', { query: 'acme' }, { query: 'acme' }],
  [
    'search_records',
    'a query in an object',
    { query: ' acme ', object: 'deals' },
    { query: ' acme ', object: 'deals' },
  ],
  ['search_records', 'an empty query', { query: '' }, REFUSED],
  [
    'search_records',
    'a query at 200',
    { query: 'q'.repeat(200) },
    { query: 'q'.repeat(200) },
  ],
  ['search_records', 'a query at 201', { query: 'q'.repeat(201) }, REFUSED],
  ['search_records', 'an empty object', { query: 'a', object: '' }, REFUSED],

  [
    'query_records',
    'an object',
    { object: 'companies' },
    { object: 'companies' },
  ],
  ['query_records', 'no object', {}, REFUSED],
  [
    'query_records',
    'every condition form',
    {
      object: 'deals',
      conditions: {
        stage: 'seed',
        amount: 5,
        open: true,
        owner: null,
        tags: ['a', 'b'],
        sector: { op: 'is_not', value: 'fintech' },
        closed: { op: 'empty' },
        raised: [
          { op: 'gt', value: 1 },
          { op: 'lt', value: 9 },
        ],
        space: { id: 'Hydrogen', includeDescendants: false },
      },
      sort: { by: 'last_interaction', direction: 'asc' },
      limit: 1,
    },
    {
      object: 'deals',
      conditions: {
        stage: 'seed',
        amount: 5,
        open: true,
        owner: null,
        tags: ['a', 'b'],
        sector: { op: 'is_not', value: 'fintech' },
        closed: { op: 'empty' },
        raised: [
          { op: 'gt', value: 1 },
          { op: 'lt', value: 9 },
        ],
        space: { id: 'Hydrogen', includeDescendants: false },
      },
      sort: { by: 'last_interaction', direction: 'asc' },
      limit: 1,
    },
  ],
  [
    'query_records',
    'a space condition on another key',
    { object: 'deals', conditions: { fund: { id: 'x' } } },
    { object: 'deals', conditions: { fund: { id: 'x' } } },
  ],
  [
    'query_records',
    'a stray key in an op condition',
    { object: 'deals', conditions: { stage: { op: 'is', value: 'a', x: 1 } } },
    { object: 'deals', conditions: { stage: { op: 'is', value: 'a' } } },
  ],
  [
    'query_records',
    'a stray key in the space',
    { object: 'deals', conditions: { space: { id: 's', x: 1 } } },
    { object: 'deals', conditions: { space: { id: 's' } } },
  ],
  [
    'query_records',
    'an unknown op',
    { object: 'deals', conditions: { stage: { op: 'like', value: 'a' } } },
    REFUSED,
  ],
  [
    'query_records',
    'an empty list, read as no strings',
    { object: 'deals', conditions: { stage: [] } },
    { object: 'deals', conditions: { stage: [] } },
  ],
  [
    'query_records',
    'an op list with a bare value in it',
    { object: 'deals', conditions: { stage: [{ op: 'is', value: 'a' }, 'b'] } },
    REFUSED,
  ],
  [
    'query_records',
    'a list of numbers',
    { object: 'deals', conditions: { stage: [1, 2] } },
    REFUSED,
  ],
  [
    'query_records',
    'a space with no id',
    { object: 'deals', conditions: { space: { includeDescendants: true } } },
    REFUSED,
  ],
  [
    'query_records',
    'a space with an empty id',
    { object: 'deals', conditions: { space: { id: '' } } },
    REFUSED,
  ],
  [
    'query_records',
    'a space given as text',
    { object: 'deals', conditions: { space: 'Hydrogen' } },
    REFUSED,
  ],
  [
    'query_records',
    'conditions as a list',
    { object: 'deals', conditions: [] },
    REFUSED,
  ],
  [
    'query_records',
    'a nested object value',
    { object: 'deals', conditions: { stage: { value: 'a' } } },
    REFUSED,
  ],
  [
    'query_records',
    'a sort with no direction',
    { object: 'deals', sort: { by: 'name' } },
    { object: 'deals', sort: { by: 'name' } },
  ],
  [
    'query_records',
    'a sort direction not asc or desc',
    { object: 'deals', sort: { by: 'name', direction: 'up' } },
    REFUSED,
  ],
  [
    'query_records',
    'a sort with an empty by',
    { object: 'deals', sort: { by: '' } },
    REFUSED,
  ],
  ['query_records', 'a zero limit', { object: 'deals', limit: 0 }, REFUSED],
  [
    'query_records',
    'a limit past the clamp',
    { object: 'deals', limit: 5000 },
    { object: 'deals', limit: 5000 },
  ],
  [
    'query_records',
    'the largest safe limit',
    { object: 'deals', limit: Number.MAX_SAFE_INTEGER },
    { object: 'deals', limit: Number.MAX_SAFE_INTEGER },
  ],
  [
    'query_records',
    'a limit past the safe integers',
    { object: 'deals', limit: 2 ** 53 },
    REFUSED,
  ],
  [
    'query_records',
    'a fractional limit',
    { object: 'deals', limit: 1.5 },
    REFUSED,
  ],

  ['portfolio_summary', 'nothing asked', {}, {}],
  [
    'portfolio_summary',
    'a day',
    { asOf: '2026-01-31' },
    { asOf: '2026-01-31' },
  ],
  [
    'portfolio_summary',
    'an impossible day',
    { asOf: '2026-13-45' },
    { asOf: '2026-13-45' },
  ],
  [
    'portfolio_summary',
    'a timestamp',
    { asOf: '2026-01-31T00:00:00Z' },
    REFUSED,
  ],
  ['portfolio_summary', 'a padded day', { asOf: ' 2026-01-31' }, REFUSED],
  ['portfolio_summary', 'no input at all', undefined, REFUSED],

  ['holding_detail', 'a holding', { holdingId: ID }, { holdingId: ID }],
  [
    'holding_detail',
    'a holding on a day',
    { holdingId: ID, asOf: '2026-01-31' },
    { holdingId: ID, asOf: '2026-01-31' },
  ],
  ['holding_detail', 'a name', { holdingId: 'Acme' }, REFUSED],
  ['holding_detail', 'no holding', { asOf: '2026-01-31' }, REFUSED],

  ['list_registry', 'everything', {}, {}],
  ['list_registry', 'one object', { object: 'deals' }, { object: 'deals' }],
  ['list_registry', 'an empty object', { object: '' }, REFUSED],
  ['list_registry', 'an object as a number', { object: 1 }, REFUSED],
]

const CARD_ROWS: ReadonlyArray<Row> = [
  [
    'propose_card',
    'a task, trimmed',
    {
      kind: 'task',
      record: 'Acme',
      title: '  Call the founder  ',
      due: '2026-02-01',
      refs: ['record:1'],
      rationale: '  They asked. ',
    },
    {
      kind: 'task',
      record: 'Acme',
      title: 'Call the founder',
      due: '2026-02-01',
      refs: ['record:1'],
      rationale: 'They asked.',
    },
  ],
  [
    'propose_card',
    'a move',
    {
      kind: 'move_stage',
      record: ID,
      stage: 'Diligence',
      refs: ['note:1'],
      rationale: 'r',
    },
    {
      kind: 'move_stage',
      record: ID,
      stage: 'Diligence',
      refs: ['note:1'],
      rationale: 'r',
    },
  ],
  [
    'propose_card',
    'every kind the grammar has',
    {
      kind: 'save_as_watch',
      record: 'a',
      space: 'Hydrogen',
      refs: ['x'],
      rationale: 'r',
    },
    {
      kind: 'save_as_watch',
      record: 'a',
      space: 'Hydrogen',
      refs: ['x'],
      rationale: 'r',
    },
  ],
  [
    'propose_card',
    'an unknown kind',
    { kind: 'merge', record: 'a', refs: ['x'], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'a blank title',
    { kind: 'task', record: 'a', title: '   ', refs: ['x'], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'a title of 500 once trimmed',
    {
      kind: 'task',
      record: 'a',
      title: ` ${'t'.repeat(500)} `,
      refs: ['x'],
      rationale: 'r',
    },
    {
      kind: 'task',
      record: 'a',
      title: 't'.repeat(500),
      refs: ['x'],
      rationale: 'r',
    },
  ],
  [
    'propose_card',
    'a title of 501',
    {
      kind: 'task',
      record: 'a',
      title: 't'.repeat(501),
      refs: ['x'],
      rationale: 'r',
    },
    REFUSED,
  ],
  [
    'propose_card',
    'a due that is not a day',
    { kind: 'task', record: 'a', due: 'Friday', refs: ['x'], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'no evidence',
    { kind: 'task', record: 'a', refs: [], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'an empty ref',
    { kind: 'task', record: 'a', refs: [''], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'a blank rationale',
    { kind: 'task', record: 'a', refs: ['x'], rationale: '  ' },
    REFUSED,
  ],
  [
    'propose_card',
    'a rationale of 1001',
    { kind: 'task', record: 'a', refs: ['x'], rationale: 'r'.repeat(1001) },
    REFUSED,
  ],
  [
    'propose_card',
    'an empty stage',
    { kind: 'move_stage', record: 'a', stage: '', refs: ['x'], rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_card',
    'a stray key',
    { kind: 'note', record: 'a', refs: ['x'], rationale: 'r', body: 'b' },
    { kind: 'note', record: 'a', refs: ['x'], rationale: 'r' },
  ],
]

/** Rows only an in-process caller can send: JSON has no undefined or Date. */
const IN_PROCESS_ROWS: ReadonlyArray<Row> = [
  [
    'get_context',
    'an explicitly undefined task',
    { entity: 'a', task: undefined },
    { entity: 'a' },
  ],
  [
    'propose_suggestion',
    'a date in the patch',
    { entity: 'a', patch: { at: new Date(0) }, rationale: 'r' },
    REFUSED,
  ],
  [
    'propose_suggestion',
    'a NaN in the patch',
    { entity: 'a', patch: { n: Number.NaN }, rationale: 'r' },
    REFUSED,
  ],
  [
    'query_records',
    'an infinite condition value',
    { object: 'deals', conditions: { amount: Number.POSITIVE_INFINITY } },
    REFUSED,
  ],
]

const SHOW_ROWS: ReadonlyArray<
  readonly [label: string, input: unknown, out: unknown]
> = [
  [
    'a company, trimmed',
    {
      companies: [
        {
          name: '  Acme ',
          domain: ' acme.com ',
          line: '  Rockets.  ',
          place: ' Berlin ',
          sources: [' https://acme.com/about '],
        },
      ],
    },
    {
      companies: [
        {
          name: 'Acme',
          domain: 'acme.com',
          line: 'Rockets.',
          place: 'Berlin',
          sources: ['https://acme.com/about'],
        },
      ],
    },
  ],
  [
    'no place, an empty line',
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['https://a.io'],
        },
      ],
    },
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['https://a.io'],
        },
      ],
    },
  ],
  [
    'a missing place',
    {
      companies: [
        { name: 'A', domain: 'a.io', line: '', sources: ['https://a.io'] },
      ],
    },
    REFUSED,
  ],
  [
    'a blank name',
    {
      companies: [
        {
          name: '  ',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['https://a.io'],
        },
      ],
    },
    REFUSED,
  ],
  [
    'a source that is not a URL',
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['a.io/about'],
        },
      ],
    },
    REFUSED,
  ],
  [
    'a source in any scheme',
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['mailto:hi@a.io'],
        },
      ],
    },
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['mailto:hi@a.io'],
        },
      ],
    },
  ],
  [
    'four sources',
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: [
            'https://a.io/1',
            'https://a.io/2',
            'https://a.io/3',
            'https://a.io/4',
          ],
        },
      ],
    },
    REFUSED,
  ],
  [
    'no sources',
    {
      companies: [
        { name: 'A', domain: 'a.io', line: '', place: null, sources: [] },
      ],
    },
    REFUSED,
  ],
  ['no companies', { companies: [] }, REFUSED],
  [
    'fifty-one companies',
    {
      companies: Array.from({ length: 51 }, (_, i) => ({
        name: `C${String(i)}`,
        domain: `c${String(i)}.io`,
        line: '',
        place: null,
        sources: ['https://c.io'],
      })),
    },
    REFUSED,
  ],
  [
    'a stray key',
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['https://a.io'],
          x: 1,
        },
      ],
      y: 2,
    },
    {
      companies: [
        {
          name: 'A',
          domain: 'a.io',
          line: '',
          place: null,
          sources: ['https://a.io'],
        },
      ],
    },
  ],
]

const byName = (name: string) => {
  const tool = ASK_TOOLS.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool
}

const decoded = (name: string, input: unknown) => {
  const out = byName(name).decode(input)
  return Result.isSuccess(out) ? out.success : REFUSED
}

/** Ask's model schema: the AI SDK's validate, as the turn runs it. */
const modelVerdict = async (
  schema: Parameters<typeof asSchema>[0],
  input: unknown,
) => {
  const validate = asSchema(schema).validate
  if (validate === undefined) throw new Error('no validate on the model schema')
  const out = await validate(input)
  return out.success ? out.value : REFUSED
}

const connect = async () => {
  const server = buildMcpServer({
    id: 'characterised',
    name: 'Characterised',
    email: 'characterised@spaces.test',
    tokenId: 'token',
    scopes: [],
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'characterised', version: '0.0.0' })
  await client.connect(clientSide)
  return client
}

/** The one text block a tool answers with. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const block = Array.isArray(result.content) ? result.content.at(0) : null
  if (!block || block.type !== 'text' || typeof block.text !== 'string')
    throw new Error('expected one text block')
  return block.text
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tools/list', () => {
  it('is what an external client read before the tools were Effect schemas', async () => {
    const client = await connect()
    expect(await client.listTools()).toEqual(TOOLS_LIST)
    expect(client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
    })
    await client.close()
  })
})

describe('each tool’s own decode', () => {
  it.each([...ROWS, ...CARD_ROWS, ...IN_PROCESS_ROWS])(
    '%s: %s',
    (tool, _, input, out) => {
      expect(decoded(tool, input)).toEqual(out)
    },
  )

  it.each(ASK_TOOLS.map((t) => [t.name, t] as const))(
    '%s advertises exactly the fields it reads, and requires the ones it needs',
    (name, tool) => {
      const accepted = [...ROWS, ...CARD_ROWS].filter(
        ([t, , , out]) => t === name && out !== REFUSED,
      )
      // Every advertised field has a row whose decode keeps it, and no more.
      const kept = new Set(
        accepted.flatMap(([, , , out]) =>
          Predicate.isObject(out) ? Object.keys(out) : [],
        ),
      )
      expect([...kept].sort()).toEqual(
        Object.keys(tool.inputSchema.properties).sort(),
      )
      const required = tool.inputSchema.required ?? []
      const sample = accepted
        .map(([, , input]) => input)
        .find(
          (input): input is { readonly [k: string]: unknown } =>
            Predicate.isObject(input) && required.every((k) => k in input),
        )
      if (sample === undefined) throw new Error(`no full row for ${name}`)
      const minimal = Object.fromEntries(required.map((k) => [k, sample[k]]))
      expect(Result.isSuccess(tool.decode(minimal))).toBe(true)
      for (const k of required)
        expect(
          Result.isFailure(
            tool.decode(
              Object.fromEntries(
                Object.entries(minimal).filter(([key]) => key !== k),
              ),
            ),
          ),
          k,
        ).toBe(true)
    },
  )
})

describe('tools/call through the MCP server', () => {
  const spyCalls = () => {
    const handed: Array<unknown> = []
    vi.spyOn(toolRegistry, 'call').mockImplementation((_name, _caller, raw) => {
      handed.push(raw)
      return Effect.succeed({
        value: 'ok',
        touches: [],
        refs: [],
        found: null,
        input: '',
        card: null,
        proposal: false,
      })
    })
    return handed
  }

  // A list is not `arguments` at all: the protocol refuses the request.
  const sendable = ROWS.filter(([, , input]) => !Array.isArray(input))

  it.each(sendable)('%s: %s', async (tool, _, input, out) => {
    const handed = spyCalls()
    const client = await connect()
    const result = await client.callTool(
      Predicate.isObject(input)
        ? { name: tool, arguments: input }
        : { name: tool },
    )
    await client.close()
    if (out === REFUSED) {
      expect(handed).toEqual([])
      expect(result.isError).toBe(true)
      expect(textOf(result)).toMatch(
        new RegExp(
          `^MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: `,
        ),
      )
    } else {
      expect(handed).toEqual([out])
      expect(textOf(result)).toBe('"ok"')
    }
  })

  it('refuses arguments that are a list before any tool sees them', async () => {
    const handed = spyCalls()
    const client = await connect()
    const request = { name: 'get_context', arguments: { entity: 'a' } }
    Reflect.set(request, 'arguments', [])
    await expect(client.callTool(request)).rejects.toThrow(
      /^MCP error -32603: .*expected record, received array/s,
    )
    await client.close()
    expect(handed).toEqual([])
  })

  it('answers a tool it does not have, and Ask’s card is not one of them', async () => {
    const client = await connect()
    for (const name of ['nope', 'propose_card']) {
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(`MCP error -32602: Tool ${name} not found`)
    }
    await client.close()
  })
})

describe('Ask’s model', () => {
  it('is shown each tool’s input with its objects closed', async () => {
    for (const tool of ASK_TOOLS) {
      const listed = TOOLS_LIST.tools.find((t) => t.name === tool.name)
      const expected =
        listed === undefined
          ? ASK_ONLY_SCHEMAS.propose_card
          : closed({ ...listed.inputSchema })
      expect(await asSchema(modelInputSchema(tool)).jsonSchema).toEqual(
        expected,
      )
    }
    expect(await asSchema(showCompaniesInput).jsonSchema).toEqual(
      ASK_ONLY_SCHEMAS.show_companies,
    )
  })

  it.each([...ROWS, ...CARD_ROWS])('%s: %s', async (tool, _, input, out) => {
    expect(await modelVerdict(modelInputSchema(byName(tool)), input)).toEqual(
      out,
    )
  })

  it.each(SHOW_ROWS)('show_companies: %s', async (_, input, out) => {
    expect(await modelVerdict(showCompaniesInput, input)).toEqual(out)
  })

  it('lists exactly the MCP table and the card', () => {
    expect(ASK_TOOLS.map((t) => t.name)).toEqual([
      ...MCP_TOOLS.map((t) => t.name),
      'propose_card',
    ])
  })
})

/**
 * The AI SDK's spelling of an input for the model: every object that names
 * its properties and says nothing of others refuses others.
 */
function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closed)
  if (typeof schema !== 'object' || schema === null) return schema
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [
      k,
      k === 'properties' || k === 'definitions'
        ? Object.fromEntries(
            Object.entries(v ?? {}).map(([p, s]) => [p, closed(s)]),
          )
        : closed(v),
    ]),
  )
  if ('properties' in out && !('additionalProperties' in out))
    out.additionalProperties = false
  return out
}

const TOOLS_LIST = {
  tools: [
    {
      name: 'get_context',
      title: 'Record context',
      description:
        'What Spaces knows about one record — its attributes, history, notes, memos, documents, the full path of every space it is filed in, the other companies in its leaf space, and tasks — ranked and trimmed to a character budget, each item with a citation. Exactly what the record page’s Context section shows the same person. A space answers as a market: its path, subspace tree with counts, companies by stage, memos and terms. A document answers with its own pages first. Pass an id, or an exact name.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            minLength: 1,
            description: 'Record id (uuid), or the record’s exact name',
          },
          task: {
            description:
              'What you are trying to do; ranks matching document passages first',
            type: 'string',
          },
          budget: {
            description: 'Character budget; default 8000',
            type: 'integer',
            minimum: 500,
            maximum: 100000,
          },
        },
        required: ['entity'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'get_record',
      title: 'Record',
      description:
        'One record, shaped by its object’s attribute registry: every attribute with its stored value and a readable rendering (the inverse half of a relationship marked derived, its value read from the other side), then its links in both directions and the spaces it is tagged into.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            pattern:
              '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            description: 'Record id (uuid)',
          },
        },
        required: ['id'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'propose_suggestion',
      title: 'Propose a suggestion',
      description:
        'Propose attribute values for one record. Nothing is written: the proposal lands in Review in Spaces, labelled with this token, and a person accepts or rejects it. The patch is keyed by attribute slug (see get_record), each field wrapped as {value, refs, confidence}; it is validated against the record’s live attribute registry and refused field by field.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            minLength: 1,
            description: 'Record id (uuid), or the record’s exact name',
          },
          patch: {
            type: 'object',
            propertyNames: {
              type: 'string',
            },
            additionalProperties: {
              $ref: '#/definitions/__schema0',
            },
            description:
              '{[attribute slug]: {value, refs: string[], confidence: 0..1}}',
          },
          rationale: {
            type: 'string',
            minLength: 1,
            description: 'Why these values — what the reviewer reads first',
          },
          refs: {
            description:
              'Citation refs for the whole proposal; default: the union of each field’s refs',
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['entity', 'patch', 'rationale'],
        $schema: 'http://json-schema.org/draft-07/schema#',
        definitions: {
          __schema0: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'number',
              },
              {
                type: 'boolean',
              },
              {
                type: 'null',
              },
              {
                type: 'array',
                items: {
                  $ref: '#/definitions/__schema0',
                },
              },
              {
                type: 'object',
                propertyNames: {
                  type: 'string',
                },
                additionalProperties: {
                  $ref: '#/definitions/__schema0',
                },
              },
            ],
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'search_records',
      title: 'Search records',
      description:
        'Search Spaces the way its Cmd-K box does — record names and aliases (typo-tolerant), note bodies, document text, tasks, and meaning when an embedding model is configured — fused into one ranked list of at most 20 hits. Each hit carries its id (pass it to get_record or get_context), kind, name, object, and a snippet marked «like this». Pass `object` to keep only one object’s records.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'What to look for',
          },
          object: {
            description:
              'An object’s slug, singular or plural name (see list_registry); only its records are returned',
            type: 'string',
            minLength: 1,
          },
        },
        required: ['query'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'query_records',
      title: 'Query records',
      description:
        'Records of one object that meet conditions, sorted, with the total that match — computed in the database by the same compiler as the list pages’ filters and view counts, never estimated and never summarised. Conditions are keyed by attribute slug (see list_registry) with ops is, is_not, contains, empty, not_empty, gt, lt; a bare value means "is". A space condition {id, includeDescendants} keeps records filed in that space and, by default, any space below it. The interaction columns last_interaction, first_email, last_email and next_meeting filter as days and sort by time. Each row carries its id (pass it to get_record or get_context), name, stored values and sort value; at most 200 rows, and total counts them all. An unknown attribute or space is refused by name.',
      inputSchema: {
        type: 'object',
        properties: {
          object: {
            type: 'string',
            minLength: 1,
            description:
              'An object’s slug, singular or plural name (see list_registry): companies, people, deals or a custom object',
          },
          conditions: {
            description:
              '{[attribute slug]: value | {op, value} | [{op, value}, …]}, all ANDed; a bare value means op "is". Ops: is, is_not, contains, empty, not_empty (no value), gt, lt. Select and status values are option ids (see list_registry). Also the interaction columns last_interaction, first_email, last_email, next_meeting, compared as YYYY-MM-DD days',
            type: 'object',
            properties: {
              space: {
                description:
                  'Records filed in this space (its id, or its exact name). includeDescendants, default true, also takes records filed in any space below it',
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    minLength: 1,
                  },
                  includeDescendants: {
                    type: 'boolean',
                  },
                },
                required: ['id'],
              },
            },
            additionalProperties: {
              anyOf: [
                {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'number',
                    },
                    {
                      type: 'boolean',
                    },
                    {
                      type: 'null',
                    },
                    {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                    },
                  ],
                },
                {
                  type: 'object',
                  properties: {
                    op: {
                      type: 'string',
                      enum: [
                        'is',
                        'is_not',
                        'contains',
                        'empty',
                        'not_empty',
                        'gt',
                        'lt',
                      ],
                    },
                    value: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'number',
                        },
                        {
                          type: 'boolean',
                        },
                        {
                          type: 'null',
                        },
                        {
                          type: 'array',
                          items: {
                            type: 'string',
                          },
                        },
                      ],
                    },
                  },
                  required: ['op'],
                },
                {
                  minItems: 1,
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      op: {
                        type: 'string',
                        enum: [
                          'is',
                          'is_not',
                          'contains',
                          'empty',
                          'not_empty',
                          'gt',
                          'lt',
                        ],
                      },
                      value: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'number',
                          },
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                          {
                            type: 'array',
                            items: {
                              type: 'string',
                            },
                          },
                        ],
                      },
                    },
                    required: ['op'],
                  },
                },
                {
                  type: 'object',
                  properties: {
                    id: {
                      type: 'string',
                      minLength: 1,
                    },
                    includeDescendants: {
                      type: 'boolean',
                    },
                  },
                  required: ['id'],
                },
              ],
            },
          },
          sort: {
            description:
              'Default: newest records first. Empty values sort last',
            type: 'object',
            properties: {
              by: {
                type: 'string',
                minLength: 1,
                description:
                  'An attribute flagged filterable or sortable, or one of last_interaction, first_email, last_email, next_meeting',
              },
              direction: {
                type: 'string',
                enum: ['asc', 'desc'],
              },
            },
            required: ['by'],
          },
          limit: {
            description:
              'Rows to return; default 50, at most 200 (more is clamped)',
            type: 'integer',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
        required: ['object'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'portfolio_summary',
      title: 'Portfolio summary',
      description:
        'The portfolio as the Portfolio page reads it, computed from the event ledger rather than estimated: per holding and for the whole book, invested (cost basis), value (what is still held — the latest mark, or cost when never marked), distributions (cash returned), TVPI, DPI and gross IRR (annualized; 0.15 is 15%). Money is plain numbers in the named currency: each holding in its own currency when all its events share one, else base; the total always in base. A holding missing an exchange rate has null figures, names the rates it needs, and is left out of the total. Each holding carries its id for holding_detail.',
      inputSchema: {
        type: 'object',
        properties: {
          asOf: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description:
              'As-of day, YYYY-MM-DD: events dated after it are left out, and a void written after it had not happened yet. Omit for everything',
          },
        },
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'holding_detail',
      title: 'Holding detail',
      description:
        'One holding’s figures (as portfolio_summary), ownership, and its ledger — investments, marks and distributions — as it stood on the as-of day: entries dated after it are left out, a voided entry is gone once its void had happened, and correction rows never appear. An entry voided after the as-of day is shown, with reversedAt naming when it was voided. Money is plain numbers with each entry’s currency.',
      inputSchema: {
        type: 'object',
        properties: {
          holdingId: {
            type: 'string',
            format: 'uuid',
            pattern:
              '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            description: 'A holding id, as portfolio_summary lists it',
          },
          asOf: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description:
              'As-of day, YYYY-MM-DD: events dated after it are left out, and a void written after it had not happened yet. Omit for everything',
          },
        },
        required: ['holdingId'],
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
    {
      name: 'list_registry',
      title: 'Object registry',
      description:
        'The workspace’s object registry: every object (Companies, People, Deals and any custom object), each with its attributes in order — slug, name, description, type, the object a reference points at, and per-type options such as select and status choices. Always current: an object or attribute created a moment ago is listed.',
      inputSchema: {
        type: 'object',
        properties: {
          object: {
            description:
              'Just this object — its slug, singular or plural name; omit for all',
            type: 'string',
            minLength: 1,
          },
        },
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      execution: {
        taskSupport: 'forbidden',
      },
    },
  ],
}

const ASK_ONLY_SCHEMAS = {
  propose_card: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [
          'task',
          'move_stage',
          'file_into_space',
          'log_signal',
          'note',
          'draft_email',
          'add_record',
          'save_as_watch',
        ],
        description:
          'task (create a task on the record), move_stage (a deal to another pipeline stage), file_into_space (file the record in a space)',
      },
      record: {
        type: 'string',
        minLength: 1,
        description: 'The record the card acts on: id (uuid) or exact name',
      },
      title: {
        description: 'task: what to do, as the task will read',
        type: 'string',
        minLength: 1,
        maxLength: 500,
      },
      due: {
        description: 'task: due date, YYYY-MM-DD',
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      stage: {
        description: 'move_stage: the stage to move to, by id or label',
        type: 'string',
        minLength: 1,
      },
      space: {
        description: 'file_into_space: the space, by id or exact name',
        type: 'string',
        minLength: 1,
      },
      refs: {
        minItems: 1,
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
        },
        description:
          'Evidence: refs this turn retrieved — [record:<id>] or a context ref as written. A card without evidence is not shown.',
      },
      rationale: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Why, in one sentence, for the reader',
      },
    },
    required: ['kind', 'record', 'refs', 'rationale'],
    additionalProperties: false,
  },
  show_companies: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      companies: {
        minItems: 1,
        maxItems: 50,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 300,
            },
            domain: {
              type: 'string',
              minLength: 1,
              maxLength: 253,
            },
            line: {
              type: 'string',
              maxLength: 300,
              description: 'What the company does, in one line',
            },
            place: {
              anyOf: [
                {
                  type: 'string',
                  maxLength: 120,
                },
                {
                  type: 'null',
                },
              ],
              description: 'Where it is based; null when the pages do not say',
            },
            sources: {
              minItems: 1,
              maxItems: 3,
              type: 'array',
              items: {
                type: 'string',
                maxLength: 2000,
                format: 'uri',
              },
              description:
                'One to three page URLs, exactly as a web tool returned them',
            },
          },
          required: ['name', 'domain', 'line', 'place', 'sources'],
          additionalProperties: false,
        },
      },
    },
    required: ['companies'],
    additionalProperties: false,
  },
}
