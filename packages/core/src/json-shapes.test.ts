import { Result, SchemaParser } from 'effect'
import type { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { Json } from '@spaces/db/json'
import {
  draftAttachmentsSchema,
  jsonRecord,
  draftRecipientsSchema,
  jsonValue,
  readEmailTemplateBody,
  readInteractionMeta,
  readRecorderSettings,
} from './json'
import { aiConfigInput } from './ai/attribute-ai'

/**
 * The shapes the server boundaries take from core, at their edges: the
 * verdict and the decoded value for each input. Every row held against the
 * zod shapes before they were Effect schemas.
 */

const decode = (schema: Schema.Decoder<unknown>, value: unknown) => {
  const parsed = SchemaParser.decodeUnknownResult(schema)(value)
  return Result.isSuccess(parsed)
    ? { ok: true, data: parsed.success }
    : { ok: false }
}

const UUID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'

class Thing {
  a = 1
}

const nullProto = Object.assign(Object.create(null), { a: 1 })

const JSON_CASES: ReadonlyArray<[string, unknown]> = [
  ['a string', 'x'],
  ['an empty string', ''],
  ['zero', 0],
  ['a negative', -1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['true', true],
  ['null', null],
  ['undefined', undefined],
  ['an empty array', []],
  ['an array of mixed', [1, 'a', null, false]],
  ['nested', { a: [{ b: { c: [1, { d: null }] } }] }],
  ['an object with an undefined value', { a: undefined }],
  ['an array holding undefined', [undefined]],
  ['an object holding NaN', { a: Number.NaN }],
  ['a date', new Date(0)],
  ['a map', new Map()],
  ['a class instance', new Thing()],
  ['a null-prototype object', nullProto],
  ['a function', () => 1],
  ['a bigint', 1n],
  ['a symbol', Symbol('s')],
  ['an object holding a function', { f: () => 1 }],
  ['an object holding a date', { at: new Date(0) }],
  // eslint-disable-next-line no-sparse-arrays -- a hole reads as undefined
  ['a sparse array', [1, , 3]],
  ['an object with a symbol key', { [Symbol('s')]: 1, a: 1 }],
  [
    'an object with a __proto__ key',
    JSON.parse('{"__proto__": {"x": 1}, "a": 1}'),
  ],
  ['an object whose constructor is not a function', { constructor: 1, a: 1 }],
  ['an object of objects', { a: { b: { c: 'd' } }, e: [] }],
]

const RECIPIENT_CASES: ReadonlyArray<[string, unknown]> = [
  ['empty', []],
  ['one address', [{ email: 'ana@acme.io' }]],
  ['a full chip', [{ email: 'ana@acme.io', entityId: UUID, name: 'Ana' }]],
  ['a bad address', [{ email: 'ana' }]],
  ['a padded address', [{ email: ' ana@acme.io ' }]],
  ['an upper-case address', [{ email: 'Ana@Acme.IO' }]],
  ['a long address', [{ email: `${'a'.repeat(310)}@acme.io` }]],
  ['a bad entity id', [{ email: 'ana@acme.io', entityId: 'x' }]],
  [
    'an upper-case entity id',
    [{ email: 'ana@acme.io', entityId: UUID.toUpperCase() }],
  ],
  ['an undefined entity id', [{ email: 'ana@acme.io', entityId: undefined }]],
  ['a null name', [{ email: 'ana@acme.io', name: null }]],
  ['a long name', [{ email: 'ana@acme.io', name: 'a'.repeat(401) }]],
  ['a stray key', [{ email: 'ana@acme.io', role: 'cc' }]],
  ['a string', ['ana@acme.io']],
  ['not a list', { email: 'ana@acme.io' }],
  [
    'a hundred',
    Array.from({ length: 100 }, (_, i) => ({ email: `p${i}@acme.io` })),
  ],
  [
    'a hundred and one',
    Array.from({ length: 101 }, (_, i) => ({ email: `p${i}@acme.io` })),
  ],
]

const ATTACHMENT_CASES: ReadonlyArray<[string, unknown]> = [
  ['empty', []],
  ['one', [{ documentId: UUID }]],
  ['a bad id', [{ documentId: 'x' }]],
  ['a nil id', [{ documentId: '00000000-0000-0000-0000-000000000000' }]],
  ['a stray key', [{ documentId: UUID, name: 'deck.pdf' }]],
  ['missing id', [{}]],
  ['fifty', Array.from({ length: 50 }, () => ({ documentId: UUID }))],
  ['fifty-one', Array.from({ length: 51 }, () => ({ documentId: UUID }))],
  ['null', null],
]

const AI_CASES: ReadonlyArray<[string, unknown]> = [
  ['a summary', { mode: 'summarize', prompt: ' Why now? ' }],
  ['every mode', ['classify', 'summarize', 'research', 'nope']],
  ['an empty prompt', { mode: 'summarize', prompt: '' }],
  ['a blank prompt', { mode: 'summarize', prompt: '   ' }],
  ['a long prompt', { mode: 'summarize', prompt: 'a'.repeat(2001) }],
  [
    'a long padded prompt',
    { mode: 'summarize', prompt: ` ${'a'.repeat(2000)} ` },
  ],
  ['no prompt', { mode: 'summarize' }],
  ['no mode', { prompt: 'x' }],
  ['a stray key', { mode: 'summarize', prompt: 'x', lane: 'classify' }],
  ['null', null],
]

describe('jsonValue, characterised', () => {
  it.each(JSON_CASES)('%s', (_, value) => {
    expect(decode(jsonValue, value)).toMatchSnapshot()
  })

  it('returns a copy, not the input', () => {
    const input = { a: [1] }
    const out = decode(jsonValue, input)
    expect(out).toEqual({ ok: true, data: input })
    expect(out.ok && out.data !== input).toBe(true)
  })
})

describe('draftRecipientsSchema, characterised', () => {
  it.each(RECIPIENT_CASES)('%s', (_, value) => {
    expect(decode(draftRecipientsSchema, value)).toMatchSnapshot()
  })
})

describe('draftAttachmentsSchema, characterised', () => {
  it.each(ATTACHMENT_CASES)('%s', (_, value) => {
    expect(decode(draftAttachmentsSchema, value)).toMatchSnapshot()
  })
})

describe('aiConfigInput, characterised', () => {
  it.each(AI_CASES)('%s', (name, value) => {
    const values =
      name === 'every mode' && Array.isArray(value)
        ? value.map((mode) => ({ mode, prompt: 'x' }))
        : [value]
    expect(values.map((v) => decode(aiConfigInput, v))).toMatchSnapshot()
  })
})

describe('the json readers, characterised', () => {
  const email: { [k: string]: Json } = {
    kind: 'email',
    from: 'a@acme.io',
    to: ['b@acme.io'],
    cc: [],
    date: '2026-01-01T00:00:00Z',
    mime_blob_sha: null,
  }
  const meeting: { [k: string]: Json } = {
    kind: 'meeting',
    ends_at: '2026-01-01T01:00:00Z',
    status: 'scheduled',
    conference_url: null,
    organizer: null,
    recurring_instance_id: null,
    rsvp: { 'a@acme.io': 'accepted' },
  }
  const call: { [k: string]: Json } = {
    kind: 'call',
    provider_event_id: 'e1',
    duration_seconds: 60,
  }
  const META: ReadonlyArray<[string, Json]> = [
    ['email', email],
    [
      'email missing cc',
      Object.fromEntries(Object.entries(email).filter(([k]) => k !== 'cc')),
    ],
    ['meeting', meeting],
    ['meeting with a bad rsvp', { ...meeting, rsvp: { a: 'maybe' } }],
    [
      'meeting with recorder events',
      {
        ...meeting,
        recorder_events: [{ provider_event_id: 'p', receipt_id: 'r' }],
      },
    ],
    ['call', call],
    ['call with negative duration', { ...call, duration_seconds: -1 }],
    ['call with fractional duration', { ...call, duration_seconds: 1.5 }],
    ['call with null duration', { ...call, duration_seconds: null }],
    ['an unknown kind', { kind: 'sms' }],
    ['no kind', {}],
    ['a string', 'x'],
  ]
  it.each(META)('readInteractionMeta: %s', (_, raw) => {
    const named = jsonRecord(raw).kind
    const kind =
      named === 'meeting' || named === 'call' ? named : ('email' as const)
    const read = readInteractionMeta(kind, raw)
    // The reason's wording is the decoder's; the verdict and the meta are the contract.
    expect(read.ok ? read : { ok: false }).toMatchSnapshot()
  })

  const SETTINGS: ReadonlyArray<[string, Json]> = [
    ['null', null],
    [
      'a full form',
      { folder_ids: ['a', 'b', 'a'], typed_notes: true, transcript: true },
    ],
    ['blank ids', { folder_ids: ['', 'a'] }],
    ['a string list', { folder_ids: 'a' }],
    ['strings for flags', { typed_notes: 'yes', transcript: 1 }],
    ['an array', ['a']],
    ['a stray key', { folder_ids: ['a'], other: 1 }],
  ]
  it.each(SETTINGS)('readRecorderSettings: %s', (_, raw) => {
    expect(readRecorderSettings(raw)).toMatchSnapshot()
  })

  const body: { [k: string]: Json } = {
    subject: 'Hi',
    body_md: 'Hello',
    attachments: [{ documentId: UUID }],
  }
  const BODIES: ReadonlyArray<[string, Json]> = [
    ['a body', body],
    ['a long subject', { ...body, subject: 'a'.repeat(999) }],
    ['missing attachments', { subject: 'Hi', body_md: 'Hello' }],
    ['a stray key', { ...body, cc: [] }],
    ['a bad attachment', { ...body, attachments: [{ documentId: 'x' }] }],
    ['null', null],
  ]
  it.each(BODIES)('readEmailTemplateBody: %s', (_, raw) => {
    expect(readEmailTemplateBody(raw)).toMatchSnapshot()
  })
})
