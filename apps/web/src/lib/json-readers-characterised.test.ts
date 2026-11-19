import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { manifestSchema } from '@spaces/sdk'
import type { Json } from '@spaces/core/json'
import { DEFAULT_MAIL_EXCLUDE } from './arrival/noise'
import { syncedMailSettingsOf } from './arrival/synced-settings'
import { readHeldBeacon } from './inbox/held'
import { decodeInit, decodeStatus } from './integrations/job-status-view'
import { capOf, withoutAccountPageKeys } from './integrations/ledger'
import { settingsFormOf } from './integrations/settings-form'

/**
 * The readers that decode stored or posted JSON outside a server fn, at
 * their edges: the beacon body, the job-status events, a mailbox's synced
 * settings, a plugin's cap and settings schema. Every row was held against
 * the zod shapes before they were Effect schemas.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'

describe('readHeldBeacon', () => {
  const ROWS: ReadonlyArray<readonly [string, unknown, unknown]> = [
    [
      'an accept',
      { decisions: [{ verb: 'accept', id: ID }] },
      [{ verb: 'accept', id: ID }],
    ],
    [
      'every verb',
      {
        decisions: [
          { verb: 'dismiss', id: ID },
          { verb: 'accept-column', attributeSlug: 'stage', runId: null },
          { verb: 'accept-column', attributeSlug: 'stage', runId: ID },
          { verb: 'dismiss-duplicate', candidateId: ID },
          { verb: 'apply-card', suggestionId: ID },
          { verb: 'skip-card', suggestionId: ID },
          { verb: 'add-option', suggestionId: ID, label: '  Seed ' },
        ],
      },
      [
        { verb: 'dismiss', id: ID },
        { verb: 'accept-column', attributeSlug: 'stage', runId: null },
        { verb: 'accept-column', attributeSlug: 'stage', runId: ID },
        { verb: 'dismiss-duplicate', candidateId: ID },
        { verb: 'apply-card', suggestionId: ID },
        { verb: 'skip-card', suggestionId: ID },
        { verb: 'add-option', suggestionId: ID, label: 'Seed' },
      ],
    ],
    [
      'a stray key',
      { decisions: [{ verb: 'accept', id: ID, admin: true }] },
      [{ verb: 'accept', id: ID }],
    ],
    [
      'a column with no run key',
      { decisions: [{ verb: 'accept-column', attributeSlug: 'stage' }] },
      null,
    ],
    [
      'an empty slug',
      {
        decisions: [{ verb: 'accept-column', attributeSlug: '', runId: null }],
      },
      null,
    ],
    [
      'a blank option',
      { decisions: [{ verb: 'add-option', suggestionId: ID, label: '  ' }] },
      null,
    ],
    [
      'a long option',
      {
        decisions: [
          { verb: 'add-option', suggestionId: ID, label: 'a'.repeat(61) },
        ],
      },
      null,
    ],
    ['a bad id', { decisions: [{ verb: 'accept', id: 'x' }] }, null],
    ['an unknown verb', { decisions: [{ verb: 'merge', id: ID }] }, null],
    ['no decisions', { decisions: [] }, null],
    [
      'too many',
      {
        decisions: Array.from({ length: 201 }, () => ({
          verb: 'accept',
          id: ID,
        })),
      },
      null,
    ],
    [
      'the most',
      {
        decisions: Array.from({ length: 200 }, () => ({
          verb: 'accept',
          id: ID,
        })),
      },
      Array.from({ length: 200 }, () => ({ verb: 'accept', id: ID })),
    ],
    ['a list', [{ verb: 'accept', id: ID }], null],
    ['null', null, null],
  ]
  it.each(ROWS)('%s', (_, raw, out) => {
    expect(readHeldBeacon(raw)).toEqual(out)
  })
})

const event = {
  jobRunId: 'r1',
  queue: 'plugin.enrich',
  integrationId: ID,
  entityId: null,
  status: 'running',
  startedAt: '2026-11-19T10:00:00.000Z',
  summary: null,
  error: null,
}

describe('decodeStatus', () => {
  const ROWS: ReadonlyArray<readonly [string, string, unknown]> = [
    ['an event', JSON.stringify(event), event],
    [
      'a watch',
      JSON.stringify({ ...event, watchId: 'w1' }),
      { ...event, watchId: 'w1' },
    ],
    [
      'a null watch',
      JSON.stringify({ ...event, watchId: null }),
      { ...event, watchId: null },
    ],
    ['a stray key', JSON.stringify({ ...event, closedAgoMs: 4 }), event],
    ['a bad status', JSON.stringify({ ...event, status: 'queued' }), null],
    ['no summary key', JSON.stringify({ ...event, summary: undefined }), null],
    ['a numeric run', JSON.stringify({ ...event, jobRunId: 1 }), null],
    ['not JSON', '{', null],
    ['a list', '[]', null],
  ]
  it.each(ROWS)('%s', (_, data, out) => {
    expect(decodeStatus(data)).toEqual(out)
  })
})

describe('decodeInit', () => {
  const ROWS: ReadonlyArray<readonly [string, string, unknown]> = [
    ['no rows', JSON.stringify({ rows: [] }), []],
    [
      'rows',
      JSON.stringify({
        rows: [
          { ...event, closedAgoMs: null },
          { ...event, status: 'failed', closedAgoMs: 1200 },
        ],
      }),
      [
        { ...event, closedAgoMs: null },
        { ...event, status: 'failed', closedAgoMs: 1200 },
      ],
    ],
    ['a row with no age', JSON.stringify({ rows: [event] }), null],
    [
      'a row with a string age',
      JSON.stringify({ rows: [{ ...event, closedAgoMs: '3' }] }),
      null,
    ],
    ['no rows key', JSON.stringify({}), null],
    ['not JSON', 'x', null],
  ]
  it.each(ROWS)('%s', (_, data, out) => {
    expect(decodeInit(data)).toEqual(out)
  })
})

describe('syncedMailSettingsOf', () => {
  const ROWS: ReadonlyArray<readonly [string, { [k: string]: Json }, unknown]> =
    [
      [
        'nothing set',
        {},
        { shareBodies: false, exclude: DEFAULT_MAIL_EXCLUDE },
      ],
      [
        'everything set',
        {
          shareBodies: true,
          excludeSenders: ['a@x.example'],
          excludeLabels: [],
        },
        {
          shareBodies: true,
          exclude: { senders: ['a@x.example'], labels: [] },
        },
      ],
      [
        'unreadable values',
        { shareBodies: 'yes', excludeSenders: [1], excludeLabels: 'SPAM' },
        { shareBodies: false, exclude: DEFAULT_MAIL_EXCLUDE },
      ],
    ]
  it.each(ROWS)('%s', (_, config, out) => {
    expect(syncedMailSettingsOf(config)).toEqual(out)
  })
})

const manifest = (
  settings: unknown,
  roles: Array<'email-calendar' | 'enrichment'> = ['enrichment'],
) =>
  Schema.decodeUnknownSync(manifestSchema)({
    manifestVersion: 1,
    id: 'apollo',
    version: '0.1.0',
    sdk: '^1.4',
    name: 'Apollo',
    description: 'Enrichment.',
    roles,
    settings,
    jobs: {
      sync: { trigger: 'schedule', schedule: '*/5 * * * *', uses: ['Content'] },
    },
  })

const capSchema = (cap: unknown) => ({
  type: 'object',
  properties: { dailyCreditCap: cap },
})

describe('capOf', () => {
  const ROWS: ReadonlyArray<
    readonly [string, { [k: string]: Json }, unknown, number | null]
  > = [
    ['a configured cap', { dailyCreditCap: 50 }, undefined, 50],
    [
      'a configured zero',
      { dailyCreditCap: 0 },
      capSchema({ type: 'integer', default: 9 }),
      0,
    ],
    [
      'a negative cap, the default',
      { dailyCreditCap: -1 },
      capSchema({ type: 'integer', default: 9 }),
      9,
    ],
    [
      'a string cap, the default',
      { dailyCreditCap: '5' },
      capSchema({ type: 'integer', default: 9 }),
      9,
    ],
    [
      'a fractional default',
      {},
      capSchema({ type: 'number', default: 2.5 }),
      2.5,
    ],
    ['no default', {}, capSchema({ type: 'integer' }), null],
    [
      'a negative default',
      {},
      capSchema({ type: 'integer', default: -3 }),
      null,
    ],
    [
      'no cap property',
      {},
      { type: 'object', properties: { other: { type: 'string' } } },
      null,
    ],
    [
      'a property that is not an object',
      {},
      {
        type: 'object',
        properties: { dailyCreditCap: { default: 4 }, odd: 3 },
      },
      null,
    ],
    ['no properties', {}, { type: 'object' }, null],
    ['no manifest', {}, undefined, null],
  ]
  it.each(ROWS)('%s', (_, config, settings, out) => {
    expect(
      capOf(config, settings === undefined ? null : manifest(settings)),
    ).toBe(out)
  })
})

describe('withoutAccountPageKeys', () => {
  const ROWS: ReadonlyArray<readonly [string, unknown, unknown]> = [
    [
      'the account keys out',
      {
        type: 'object',
        properties: {
          shareBodies: { type: 'boolean' },
          signature: { type: 'string' },
        },
        required: ['shareBodies', 'signature'],
        propertyOrder: ['shareBodies', 'signature'],
      },
      {
        type: 'object',
        properties: { signature: { type: 'string' } },
        required: ['signature'],
        propertyOrder: ['shareBodies', 'signature'],
      },
    ],
    [
      'no required list',
      { type: 'object', properties: { excludeLabels: { type: 'array' } } },
      { type: 'object', properties: {} },
    ],
    [
      'a __proto__ property',
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}}',
      ),
      { type: 'object', properties: { a: { type: 'string' } } },
    ],
    ['no properties', { type: 'object' }, { type: 'object' }],
    [
      'properties that are a list',
      { type: 'object', properties: [] },
      { type: 'object', properties: [] },
    ],
    [
      'a required list of numbers',
      { type: 'object', properties: {}, required: [1] },
      { type: 'object', properties: {}, required: [1] },
    ],
  ]
  it.each(ROWS)('%s', (_, settings, out) => {
    expect(
      withoutAccountPageKeys(manifest(settings, ['email-calendar'])),
    ).toEqual(out)
  })
})

describe('settingsFormOf', () => {
  const field = (property: unknown) => ({
    type: 'object',
    properties: { cap: property },
  })
  const ROWS: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['an empty object', {}, { ok: true, fields: [] }],
    [
      'a null',
      null,
      {
        ok: false,
        reason:
          'settings is not an object schema — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a stray keyword',
      { type: 'object', properties: {}, minProperties: 1 },
      {
        ok: false,
        reason:
          'settings is not an object schema — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'additional properties allowed',
      { type: 'object', additionalProperties: true },
      {
        ok: false,
        reason:
          'settings is not an object schema — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'properties as a list',
      { type: 'object', properties: [] },
      {
        ok: false,
        reason:
          'settings is not an object schema — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'an integer',
      field({
        type: 'integer',
        minimum: 0,
        maximum: 9007199254740991,
        default: 5,
        title: 'Daily cap',
      }),
      {
        ok: true,
        fields: [
          {
            kind: 'number',
            key: 'cap',
            label: 'Daily cap',
            hint: null,
            required: false,
            default: 5,
            integer: true,
            minimum: 0,
            maximum: 9007199254740991,
            exclusiveMinimum: null,
            exclusiveMaximum: null,
          },
        ],
      },
    ],
    [
      'a string with a format',
      {
        ...field({
          type: 'string',
          format: 'email',
          minLength: 3,
          description: 'Where to send',
        }),
        required: ['cap'],
      },
      {
        ok: true,
        fields: [
          {
            kind: 'string',
            key: 'cap',
            label: 'Cap',
            hint: 'Where to send',
            required: true,
            default: null,
            minLength: 3,
            maxLength: null,
            pattern: null,
            format: 'email',
          },
        ],
      },
    ],
    [
      'an enum with no type',
      field({ enum: ['a', 'b'], default: 'a' }),
      {
        ok: true,
        fields: [
          {
            kind: 'enum',
            key: 'cap',
            label: 'Cap',
            hint: null,
            required: false,
            default: 'a',
            options: ['a', 'b'],
          },
        ],
      },
    ],
    [
      'a boolean',
      field({ type: 'boolean', default: true }),
      {
        ok: true,
        fields: [
          {
            kind: 'boolean',
            key: 'cap',
            label: 'Cap',
            hint: null,
            required: false,
            default: true,
          },
        ],
      },
    ],
    [
      'an empty enum',
      field({ enum: [] }),
      {
        ok: false,
        reason:
          'setting cap is a schema the form cannot draw — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a fractional min length',
      field({ type: 'string', minLength: 1.5 }),
      {
        ok: false,
        reason:
          'setting cap is a string — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a negative max length',
      field({ type: 'string', maxLength: -1 }),
      {
        ok: false,
        reason:
          'setting cap is a string — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'an unknown format',
      field({ type: 'string', format: 'date' }),
      {
        ok: false,
        reason:
          'setting cap is a string — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a stray keyword on a field',
      field({ type: 'number', multipleOf: 2 }),
      {
        ok: false,
        reason:
          'setting cap is a number — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a string default on a number',
      field({ type: 'number', default: '5' }),
      {
        ok: false,
        reason:
          'setting cap is a number — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'an array',
      field({ type: 'array', items: { type: 'string' } }),
      {
        ok: false,
        reason:
          'setting cap is an array — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'a nullable',
      field({ type: ['string', 'null'] }),
      {
        ok: false,
        reason:
          'setting cap is a string or null — the form renders string, number, boolean and enum settings only',
      },
    ],
    [
      'no type at all',
      field({ title: 'x' }),
      {
        ok: false,
        reason:
          'setting cap is a schema the form cannot draw — the form renders string, number, boolean and enum settings only',
      },
    ],
  ]
  it.each(ROWS)('%s', (_, settings, out) => {
    expect(settingsFormOf(settings)).toEqual(out)
  })
})

describe('demoIdsOf', () => {
  const ROWS: ReadonlyArray<readonly [string, { [k: string]: Json }, unknown]> =
    [
      ['recorded ids', { demo: { entity_ids: [ID] } }, [ID]],
      ['no ids', { demo: { entity_ids: [] } }, []],
      ['a stray key', { demo: { entity_ids: [ID], at: 'x' } }, [ID]],
      ['no demo', {}, null],
      ['a null demo', { demo: null }, null],
      ['numeric ids', { demo: { entity_ids: [1] } }, null],
      ['ids as a string', { demo: { entity_ids: ID } }, null],
    ]
  // Dynamic: the seed module reaches `@spaces/db`, whose pool reads
  // `DATABASE_URL` at import time.
  it.each(ROWS)('%s', async (_, settings, out) => {
    const { demoIdsOf } = await import('./seeds/demo')
    expect(demoIdsOf(settings)).toEqual(out)
  })
})
