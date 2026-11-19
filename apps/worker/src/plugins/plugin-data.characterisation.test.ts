import { Predicate, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData } from '../job-data'
import type { JobSchema } from '../job-data'
import { costOf } from './credit'
import { cassetteFile } from './fakes/cassette'
import { scheduleOutput, watchOutput } from './host'
import { jsonRows } from './plugin-db'
import {
  actionData,
  eventData,
  payloadActionData,
  scheduleData,
  tickData,
  watchState,
  webhookData,
} from './queues'

/**
 * What the plugin host's shapes accept and refuse: the data its queues are
 * sent, what a job hands back, a `cost` hook's answer, a PluginDb row and a
 * cassette. Every row is a literal expectation: a failing row is a value a
 * plugin or the host already produces that would now be treated differently,
 * so change the row only with the contract.
 */

const REFUSED = 'refused'

type Decodes = JobSchema<unknown>

const decode = (schema: Decodes, input: unknown): unknown => {
  const decoded = decodeJobData(schema, input)
  return Result.isSuccess(decoded) ? decoded.success : REFUSED
}

type Row = readonly [label: string, input: unknown, expected: unknown]

const U = 'a3bb189e-8bf9-4888-9912-ace4e6543002'
const U2 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const AT = '2026-11-19T10:00:00.000Z'

class Point {
  constructor(readonly x: number) {}
}

const bare = (entries: Record<string, unknown>): object =>
  Object.assign(Object.create(null), entries)

/** The JSON a record of JSON values takes, wherever the host decodes one. */
const jsonObjectRows = (wrap: (v: unknown) => unknown): ReadonlyArray<Row> => [
  ['empty', wrap({}), wrap({})],
  [
    'nested values',
    wrap({ a: 1, b: [null, 'x', { c: true }], d: { e: -2.5 } }),
    wrap({ a: 1, b: [null, 'x', { c: true }], d: { e: -2.5 } }),
  ],
  ['a null-prototype object', wrap(bare({ a: 1 })), wrap({ a: 1 })],
  ['a list', wrap([]), REFUSED],
  ['a string', wrap('x'), REFUSED],
  ['a date', wrap(new Date(0)), REFUSED],
  ['a map', wrap(new Map([['a', 1]])), REFUSED],
  ['a class instance', wrap(new Point(1)), REFUSED],
  ['a nested date', wrap({ at: new Date(0) }), REFUSED],
  ['an undefined value', wrap({ a: undefined }), REFUSED],
  ['an infinite number', wrap({ a: Number.POSITIVE_INFINITY }), REFUSED],
  ['NaN', wrap({ a: Number.NaN }), REFUSED],
  ['a function', wrap({ a: () => 1 }), REFUSED],
  ['a bigint', wrap({ a: 1n }), REFUSED],
]

const eventBase = { entityId: U, occurredAt: AT }

const table: ReadonlyArray<
  readonly [name: string, schema: Decodes, rows: ReadonlyArray<Row>]
> = [
  [
    'actionData',
    actionData,
    [
      ['an entity', { entityId: U, x: 1 }, { entityId: U }],
      ['not a uuid', { entityId: 'x' }, REFUSED],
      [
        'the max uuid upper case',
        { entityId: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' },
        REFUSED,
      ],
      ['null', null, REFUSED],
    ],
  ],
  [
    'payloadActionData',
    payloadActionData,
    [
      ...jsonObjectRows((payload) => ({ payload })),
      ['an extra key is dropped', { payload: {}, x: 1 }, { payload: {} }],
      ['no payload', {}, REFUSED],
      ['a null payload', { payload: null }, REFUSED],
    ],
  ],
  [
    'scheduleData',
    scheduleData,
    [
      ['empty', {}, {}],
      ['an extra key is dropped', { cursor: 'c' }, {}],
      ['null', null, REFUSED],
      ['undefined', undefined, REFUSED],
      ['a list', [], REFUSED],
    ],
  ],
  [
    'tickData',
    tickData,
    [
      ['empty', {}, {}],
      ['null', null, REFUSED],
      ['a list', [], REFUSED],
    ],
  ],
  [
    'eventData',
    eventData,
    [
      [
        'entity.created',
        { event: { name: 'entity.created', kind: 'deal', ...eventBase } },
        { event: { name: 'entity.created', kind: 'deal', ...eventBase } },
      ],
      [
        'filed',
        {
          event: { name: 'filed', kind: 'company', spaceId: U2, ...eventBase },
        },
        {
          event: { name: 'filed', kind: 'company', spaceId: U2, ...eventBase },
        },
      ],
      [
        'deal.linked',
        {
          event: {
            name: 'deal.linked',
            kind: 'person',
            dealId: U2,
            ...eventBase,
          },
        },
        {
          event: {
            name: 'deal.linked',
            kind: 'person',
            dealId: U2,
            ...eventBase,
          },
        },
      ],
      [
        'deal.linked on a deal',
        {
          event: {
            name: 'deal.linked',
            kind: 'deal',
            dealId: U2,
            ...eventBase,
          },
        },
        REFUSED,
      ],
      [
        'identity.added',
        {
          event: {
            name: 'identity.added',
            kind: 'company',
            key: 'domain',
            value: 'acme.example',
            ...eventBase,
          },
        },
        {
          event: {
            name: 'identity.added',
            kind: 'company',
            key: 'domain',
            value: 'acme.example',
            ...eventBase,
          },
        },
      ],
      [
        'identity.added by phone',
        {
          event: {
            name: 'identity.added',
            kind: 'company',
            key: 'phone',
            value: '1',
            ...eventBase,
          },
        },
        REFUSED,
      ],
      [
        'identity.added with no value',
        {
          event: {
            name: 'identity.added',
            kind: 'person',
            key: 'email',
            value: '',
            ...eventBase,
          },
        },
        REFUSED,
      ],
      [
        'interaction.logged',
        {
          event: {
            name: 'interaction.logged',
            kind: 'person',
            interactionId: U2,
            interactionKind: 'call',
            ...eventBase,
          },
        },
        {
          event: {
            name: 'interaction.logged',
            kind: 'person',
            interactionId: U2,
            interactionKind: 'call',
            ...eventBase,
          },
        },
      ],
      [
        'interaction.logged for an email',
        {
          event: {
            name: 'interaction.logged',
            kind: 'person',
            interactionId: U2,
            interactionKind: 'email',
            ...eventBase,
          },
        },
        REFUSED,
      ],
      [
        'extra keys are dropped at both levels',
        {
          event: { name: 'entity.created', kind: 'person', x: 1, ...eventBase },
          y: 2,
        },
        { event: { name: 'entity.created', kind: 'person', ...eventBase } },
      ],
      [
        'an unknown event',
        { event: { name: 'entity.deleted', kind: 'person', ...eventBase } },
        REFUSED,
      ],
      [
        'an unknown kind',
        { event: { name: 'entity.created', kind: 'fund', ...eventBase } },
        REFUSED,
      ],
      [
        'no time',
        { event: { name: 'entity.created', kind: 'person', entityId: U } },
        REFUSED,
      ],
      [
        'an empty time',
        {
          event: {
            name: 'entity.created',
            kind: 'person',
            entityId: U,
            occurredAt: '',
          },
        },
        REFUSED,
      ],
      ['no event', {}, REFUSED],
    ],
  ],
  [
    'webhookData',
    webhookData,
    [
      [
        'an object',
        { payload: { a: [1] }, receivedAt: AT },
        { payload: { a: [1] }, receivedAt: AT },
      ],
      [
        'null',
        { payload: null, receivedAt: AT },
        { payload: null, receivedAt: AT },
      ],
      [
        'a string',
        { payload: 's', receivedAt: AT },
        { payload: 's', receivedAt: AT },
      ],
      [
        'a list',
        { payload: [1, 'x'], receivedAt: AT },
        { payload: [1, 'x'], receivedAt: AT },
      ],
      ['no payload', { receivedAt: AT }, REFUSED],
      [
        'an infinite payload',
        { payload: Number.POSITIVE_INFINITY, receivedAt: AT },
        REFUSED,
      ],
      ['a date payload', { payload: new Date(0), receivedAt: AT }, REFUSED],
      ['an empty time', { payload: {}, receivedAt: '' }, REFUSED],
    ],
  ],
  [
    'watchState',
    watchState,
    [
      ...jsonObjectRows((state) => ({ state })),
      ['null', { state: null }, { state: null }],
      ['missing', {}, REFUSED],
      ['an extra key is dropped', { state: null, x: 1 }, { state: null }],
      ['undefined', undefined, REFUSED],
    ],
  ],
  [
    'watchOutput',
    watchOutput,
    [
      ...jsonObjectRows((state) => ({ state })),
      ['null', { state: null }, { state: null }],
      ['missing', {}, REFUSED],
      ['undefined', undefined, REFUSED],
    ],
  ],
  [
    'scheduleOutput',
    scheduleOutput,
    [
      ['a cursor', { nextCursor: 'c' }, { nextCursor: 'c' }],
      ['an empty cursor', { nextCursor: '' }, { nextCursor: '' }],
      ['null', { nextCursor: null }, { nextCursor: null }],
      [
        'an extra key is dropped',
        { nextCursor: 'c', cursorInvalid: 'x' },
        { nextCursor: 'c' },
      ],
      ['missing', {}, REFUSED],
      ['a number', { nextCursor: 1 }, REFUSED],
      ['undefined', undefined, REFUSED],
    ],
  ],
  [
    'jsonRows',
    jsonRows,
    [
      ['none', [], []],
      [
        'rows',
        [{ a: 1, b: 'x', c: null, d: [true], e: { f: 1 } }, {}],
        [{ a: 1, b: 'x', c: null, d: [true], e: { f: 1 } }, {}],
      ],
      ['a list row', [[1]], REFUSED],
      ['a scalar row', [1], REFUSED],
      ['a null row', [null], REFUSED],
      ['not a list', { a: 1 }, REFUSED],
    ],
  ],
  [
    'cassetteFile',
    cassetteFile,
    [
      [
        'one interaction',
        {
          keyHeader: 'authorization',
          interactions: [
            {
              method: 'GET',
              url: 'https://api.example/v1/x?q=*',
              status: 200,
              file: 'x.json',
            },
          ],
        },
        {
          keyHeader: 'authorization',
          interactions: [
            {
              method: 'GET',
              url: 'https://api.example/v1/x?q=*',
              status: 200,
              file: 'x.json',
            },
          ],
        },
      ],
      [
        'revoked',
        {
          keyHeader: 'x-key',
          interactions: [
            {
              method: 'POST',
              url: 'https://a.example',
              status: 201,
              file: 'a',
            },
          ],
          revoked: { status: 401, file: 'r.json' },
        },
        {
          keyHeader: 'x-key',
          interactions: [
            {
              method: 'POST',
              url: 'https://a.example',
              status: 201,
              file: 'a',
            },
          ],
          revoked: { status: 401, file: 'r.json' },
        },
      ],
      ['no interactions', { keyHeader: 'x-key', interactions: [] }, REFUSED],
      [
        'a status out of range',
        {
          keyHeader: 'x-key',
          interactions: [
            { method: 'GET', url: 'https://a.example', status: 600, file: 'a' },
          ],
        },
        REFUSED,
      ],
      [
        'a fractional status',
        {
          keyHeader: 'x-key',
          interactions: [
            {
              method: 'GET',
              url: 'https://a.example',
              status: 200.5,
              file: 'a',
            },
          ],
        },
        REFUSED,
      ],
      [
        'an unknown method',
        {
          keyHeader: 'x-key',
          interactions: [
            {
              method: 'HEAD',
              url: 'https://a.example',
              status: 200,
              file: 'a',
            },
          ],
        },
        REFUSED,
      ],
      [
        'a relative url',
        {
          keyHeader: 'x-key',
          interactions: [{ method: 'GET', url: '/x', status: 200, file: 'a' }],
        },
        REFUSED,
      ],
    ],
  ],
]

describe.each(table)('%s', (_name, schema, rows) => {
  it.each(rows)('%s', (_label, input, expected) => {
    expect(decode(schema, input)).toStrictEqual(expected)
  })
})

describe('a key named __proto__', () => {
  const withProto = JSON.parse('{"__proto__":{"polluted":1},"a":1}')

  it.each([
    ['payloadActionData', payloadActionData, { payload: withProto }],
    ['watchState', watchState, { state: withProto }],
    ['watchOutput', watchOutput, { state: withProto }],
  ] as const)('%s', (_name, schema, input) => {
    const out = decode(schema, input)
    expect(out).not.toBe(REFUSED)
    const inner: unknown = Predicate.isObject(out)
      ? Object.values(out).at(0)
      : undefined
    expect(Predicate.isObject(inner)).toBe(true)
    expect(Object.keys(inner ?? {})).toStrictEqual(['a'])
    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype)
  })
})

/** A `cost` hook's answer, through `costOf`: what it returns, or a throw. */
const costRows: ReadonlyArray<Row> = [
  ['zero', { credits: 0 }, { credits: 0 }],
  ['a fraction', { credits: 2.5 }, { credits: 2.5 }],
  ['an extra key is dropped', { credits: 1, why: 'x' }, { credits: 1 }],
  ['negative', { credits: -1 }, REFUSED],
  ['a numeric string', { credits: '1' }, REFUSED],
  ['NaN', { credits: Number.NaN }, REFUSED],
  ['infinite', { credits: Number.POSITIVE_INFINITY }, REFUSED],
  ['missing', {}, REFUSED],
  ['null', null, REFUSED],
  ['a number', 3, REFUSED],
]

describe('costOf', () => {
  it('is null without a hook', () => {
    expect(costOf({})).toBeNull()
    expect(costOf({ cost: 1 })).toBeNull()
  })

  it.each(costRows)('%s', (_label, answer, expected) => {
    const hook = costOf({ cost: () => answer })
    expect(hook).not.toBeNull()
    const run = (): unknown => {
      try {
        return hook?.({ entityIds: [U] })
      } catch {
        return REFUSED
      }
    }
    expect(run()).toStrictEqual(expected)
  })
})
