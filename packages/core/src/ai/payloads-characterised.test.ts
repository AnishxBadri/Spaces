import { describe, expect, it } from 'vitest'
import {
  addRecordPayloadSchema,
  discoverySpaceOf,
  fileRecordPayloadSchema,
  readAddRecordPayload,
  readFileRecordPayload,
} from './discovery'
import {
  documentKindPayloadSchema,
  readDocumentKindPayload,
} from './document-kind'
import { identityPayloadSchema, readIdentityPayload } from './identity'
import {
  ledgerEventPayloadSchema,
  readLedgerEventPayload,
} from './ledger-event'
import { notePayloadSchema, readNotePayload } from './note'
import { readPayload } from './decode'
import { readSpaceTagPayload, spaceTagPayloadSchema } from './space-tag'
import { readSupersedesPayload, supersedesPayloadSchema } from './supersedes'
import { readTaskPayload, taskPayloadSchema } from './task'

/**
 * The suggestion payloads, characterised: for each input, every issue the
 * propose path is refused with (path and words, in order) or the decoded
 * payload, and what the stored-payload reader makes of the same input.
 * Recorded against the zod decoders before they were Effect schemas.
 */

const UUID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const UUID_2 = '1c7be8b3-7b4f-4d5a-8b54-6e2a2e9c7d22'
const UPPER_UUID = '0B6AD7A2-6A3E-4C4F-9A43-5D1F1D8B6C11'
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const UPPER_MAX_UUID = 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const V0_UUID = '0b6ad7a2-6a3e-0c4f-9a43-5d1f1d8b6c11'

class Holder {}

const sym = Symbol('s')

const long = (n: number) => 'a'.repeat(n)

const protoOf = (v: unknown): string => {
  if (typeof v !== 'object' || v === null) return typeof v
  if (Array.isArray(v)) return 'array'
  const p: unknown = Object.getPrototypeOf(v)
  if (p === null) return 'null-prototype'
  return p === Object.prototype ? 'plain' : 'other'
}

type Rows = ReadonlyArray<[string, unknown]>

/** The rows every object payload is put through, around one valid input. */
function shapeRows(valid: Record<string, unknown>): Rows {
  const rows: Array<[string, unknown]> = [
    ['valid', valid],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 5],
    ['an array', [valid]],
    ['a date', new Date(0)],
    ['a map', new Map(Object.entries(valid))],
    ['a class instance', Object.assign(new Holder(), valid)],
    ['a null-prototype copy', Object.assign(Object.create(null), valid)],
    ['inherited fields', Object.create(valid)],
    [
      'a __proto__ key',
      JSON.parse(`{"__proto__": {"a": 1}, ${JSON.stringify(valid).slice(1)}`),
    ],
    ['a symbol key', { ...valid, [sym]: 1 }],
    ['an extra key', { ...valid, extra: 1 }],
    ['two extra keys', { zz: 1, ...valid, aa: 2 }],
    ['an undefined extra key', { ...valid, extra: undefined }],
    ['a constructor key', { ...valid, constructor: 'x' }],
    ['empty', {}],
  ]
  for (const key of Object.keys(valid)) {
    const without = Object.fromEntries(
      Object.entries(valid).filter(([k]) => k !== key),
    )
    rows.push(
      [`${key} missing`, without],
      [`${key} undefined`, { ...valid, [key]: undefined }],
      [`${key} null`, { ...valid, [key]: null }],
      [`${key} a number`, { ...valid, [key]: 5 }],
      [`${key} a string`, { ...valid, [key]: 'x' }],
      [`${key} an object`, { ...valid, [key]: {} }],
      [`${key} an array`, { ...valid, [key]: [] }],
      [`${key} true`, { ...valid, [key]: true }],
      [`${key} missing, plus an extra key`, { ...without, extra: 1 }],
    )
  }
  return rows
}

/** The edges of one string or number field, as rows over `valid`. */
function fieldRows(
  valid: Record<string, unknown>,
  key: string,
  values: ReadonlyArray<[string, unknown]>,
): Rows {
  return values.map(([name, value]) => [
    `${key} ${name}`,
    { ...valid, [key]: value },
  ])
}

const UUIDS: ReadonlyArray<[string, unknown]> = [
  ['upper-case', UPPER_UUID],
  ['the max uuid', MAX_UUID],
  ['the upper-case max uuid', UPPER_MAX_UUID],
  ['the nil uuid', NIL_UUID],
  ['a version-0 uuid', V0_UUID],
  ['padded', ` ${UUID} `],
  ['empty', ''],
  ['not a uuid', 'nope'],
]

const CONFIDENCES: ReadonlyArray<[string, unknown]> = [
  ['0', 0],
  ['-0', -0],
  ['1', 1],
  ['just over 1', 1.0000001],
  ['negative', -0.1],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a numeric string', '0.5'],
]

/** A trimmed, bounded string field's edges. */
const trimmed = (max: number): ReadonlyArray<[string, unknown]> => [
  ['padded', ' x '],
  ['blank', '   '],
  ['empty', ''],
  [`of ${max}`, long(max)],
  [`of ${max + 1}`, long(max + 1)],
  [`of ${max} padded`, ` ${long(max)} `],
  ['with inner space', 'a  b'],
]

function table(
  name: string,
  rows: Rows,
  decode: (raw: unknown) => unknown,
  read: (raw: unknown) => unknown,
) {
  describe(name, () => {
    for (const [row, raw] of rows) {
      it(row, () => {
        const decoded = decode(raw)
        const reader = read(raw)
        expect({
          decoded,
          reader,
          proto: protoOf(reader),
        }).toMatchSnapshot()
      })
    }
  })
}

const identity = {
  name: 'Ana',
  role: 'CEO',
  email: 'ana@acme.io',
  linkedin: 'linkedin.com/in/ana',
  attribute: 'founders',
}

table(
  'identity payload',
  [
    ...shapeRows(identity),
    ['a name only', { name: 'Ana' }],
    ...fieldRows(identity, 'name', trimmed(500)),
    ...fieldRows(identity, 'role', trimmed(200)),
    ...fieldRows(identity, 'linkedin', trimmed(500)),
    ...fieldRows(identity, 'attribute', trimmed(100)),
    ...fieldRows(identity, 'email', [
      ['padded', ' Ana@Acme.io '],
      ['blank', '  '],
      ['not an email', 'nope'],
      ['of 255', `${long(247)}@acme.io`],
      ['of 256', `${long(248)}@acme.io`],
      ['of 255 padded', ` ${long(247)}@acme.io `],
      ['long and invalid', long(300)],
    ]),
    [
      'every optional undefined',
      {
        name: 'Ana',
        role: undefined,
        email: undefined,
        linkedin: undefined,
        attribute: undefined,
      },
    ],
    ['a blank name and a bad email', { name: ' ', email: 'x', extra: 1 }],
  ],
  (raw) => readPayload(identityPayloadSchema, raw),
  readIdentityPayload,
)

const documentKind = { kind: 'deck', confidence: 0.9 }

table(
  'document kind payload',
  [
    ...shapeRows(documentKind),
    ['a kind only', { kind: 'deck' }],
    ...fieldRows(documentKind, 'kind', [
      ['other', 'other'],
      ['capitalised', 'Deck'],
      ['padded', ' deck '],
      ['cap_table', 'cap_table'],
    ]),
    ...fieldRows(documentKind, 'confidence', CONFIDENCES),
    ['other and a bad confidence', { kind: 'other', confidence: 2 }],
    ['other and an extra key', { kind: 'other', extra: 1 }],
  ],
  (raw) => readPayload(documentKindPayloadSchema, raw),
  readDocumentKindPayload,
)

const note = { title: 'Call notes', markdown: '# Hi\n\nBody', sourceId: UUID }

table(
  'note payload',
  [
    ...shapeRows(note),
    ...fieldRows(note, 'title', trimmed(300)),
    ...fieldRows(note, 'markdown', [
      ['padded', '  body  \n'],
      ['blank', ' \n '],
      ['of 200000', long(200_000)],
      ['of 200001', long(200_001)],
    ]),
    ...fieldRows(note, 'sourceId', UUIDS),
  ],
  (raw) => readPayload(notePayloadSchema, raw),
  readNotePayload,
)

const spaceTag = { spaceId: UUID, label: 'Energy / Storage', confidence: 0.7 }

table(
  'space tag payload',
  [
    ...shapeRows(spaceTag),
    ['no confidence', { spaceId: UUID, label: 'Energy' }],
    ...fieldRows(spaceTag, 'spaceId', UUIDS),
    ...fieldRows(spaceTag, 'label', trimmed(1000)),
    ...fieldRows(spaceTag, 'confidence', CONFIDENCES),
  ],
  (raw) => readPayload(spaceTagPayloadSchema, raw),
  readSpaceTagPayload,
)

const evidence = { url: 'https://acme.io/about', title: 'About' }

const addRecord = {
  spaceId: UUID,
  domain: 'acme.io',
  name: 'Acme',
  evidence: [evidence],
  watchIds: [UUID_2],
  aliases: ['Acme Inc'],
  subspaceHint: 'Storage',
}

const evidenceRows = (
  valid: Record<string, unknown>,
): ReadonlyArray<[string, unknown]> => [
  ['evidence empty', { ...valid, evidence: [] }],
  [
    'evidence without a title',
    { ...valid, evidence: [{ url: 'https://a.io' }] },
  ],
  [
    'evidence with a padded url',
    { ...valid, evidence: [{ url: ' https://a.io/x ' }] },
  ],
  ['evidence with a bare host', { ...valid, evidence: [{ url: 'acme.io' }] }],
  [
    'evidence with a mailto url',
    { ...valid, evidence: [{ url: 'mailto:ana@acme.io' }] },
  ],
  [
    'evidence with a custom scheme',
    { ...valid, evidence: [{ url: 'foo:bar' }] },
  ],
  ['evidence with an empty host', { ...valid, evidence: [{ url: 'http://' }] }],
  [
    'evidence with a url of 2001',
    { ...valid, evidence: [{ url: `https://a.io/${long(1988)}` }] },
  ],
  [
    'evidence with an upper-case url',
    { ...valid, evidence: [{ url: 'HTTPS://ACME.IO/A B' }] },
  ],
  [
    'evidence with a padded title',
    { ...valid, evidence: [{ url: 'https://a.io', title: ' About ' }] },
  ],
  [
    'evidence with a blank title',
    { ...valid, evidence: [{ url: 'https://a.io', title: ' ' }] },
  ],
  [
    'evidence with an undefined title',
    { ...valid, evidence: [{ url: 'https://a.io', title: undefined }] },
  ],
  [
    'evidence with an extra key',
    { ...valid, evidence: [{ url: 'https://a.io', score: 1 }] },
  ],
  ['evidence holding null', { ...valid, evidence: [evidence, null] }],
  [
    'evidence of 51',
    { ...valid, evidence: Array.from({ length: 51 }, () => evidence) },
  ],
  [
    'evidence of 50',
    { ...valid, evidence: Array.from({ length: 50 }, () => evidence) },
  ],
  [
    'evidence with two bad items',
    { ...valid, evidence: [{ url: 'x' }, { url: 'https://a.io', title: '' }] },
  ],
  ['watchIds empty', { ...valid, watchIds: [] }],
  [
    'watchIds of 51',
    { ...valid, watchIds: Array.from({ length: 51 }, () => UUID) },
  ],
  ['watchIds with a bad id', { ...valid, watchIds: [UUID, 'nope'] }],
  ['watchIds upper-case', { ...valid, watchIds: [UPPER_UUID] }],
  ['domain padded', { ...valid, domain: ' Acme.io ' }],
  ['domain blank', { ...valid, domain: ' ' }],
  ['domain of 254', { ...valid, domain: long(254) }],
  ['name blank', { ...valid, name: '' }],
  ['name of 301', { ...valid, name: long(301) }],
  ...fieldRows(valid, 'spaceId', UUIDS),
]

table(
  'add record payload',
  [
    ...shapeRows(addRecord),
    ...evidenceRows(addRecord),
    ['aliases empty', { ...addRecord, aliases: [] }],
    ['aliases padded', { ...addRecord, aliases: [' A ', 'B'] }],
    ['aliases with a blank', { ...addRecord, aliases: ['A', ' '] }],
    [
      'aliases of 21',
      { ...addRecord, aliases: Array.from({ length: 21 }, () => 'A') },
    ],
    ['aliases with one of 301', { ...addRecord, aliases: [long(301)] }],
    ...fieldRows(addRecord, 'subspaceHint', trimmed(300)),
    [
      'several fields wrong',
      { ...addRecord, domain: '', evidence: [{ url: 'x' }], subspaceHint: '' },
    ],
  ],
  (raw) => readPayload(addRecordPayloadSchema, raw),
  (raw) => ({
    payload: readAddRecordPayload(raw),
    space: discoverySpaceOf(raw),
  }),
)

const fileRecord = {
  spaceId: UUID,
  domain: 'acme.io',
  name: 'Acme',
  evidence: [evidence],
  watchIds: [UUID_2],
  entityId: UUID_2,
}

table(
  'file record payload',
  [
    ...shapeRows(fileRecord),
    ...evidenceRows(fileRecord),
    ...fieldRows(fileRecord, 'entityId', UUIDS),
    ['an add record payload', { ...addRecord }],
  ],
  (raw) => readPayload(fileRecordPayloadSchema, raw),
  (raw) => ({
    payload: readFileRecordPayload(raw),
    space: discoverySpaceOf(raw),
  }),
)

const task = { title: 'Send the deck', due: '2026-11-20', entity_id: UUID }

table(
  'task payload',
  [
    ...shapeRows(task),
    ...fieldRows(task, 'title', trimmed(500)),
    ...fieldRows(task, 'due', [
      ['short', '2026-1-2'],
      ['padded', ' 2026-11-20 '],
      ['with a time', '2026-11-20T10:00'],
      ['an impossible day', '2026-13-45'],
    ]),
    ...fieldRows(task, 'entity_id', UUIDS),
  ],
  (raw) => readPayload(taskPayloadSchema, raw),
  readTaskPayload,
)

const supersedes = {
  newerId: UUID,
  olderId: UUID_2,
  newerName: 'Deck v2.pdf',
  olderName: 'Deck.pdf',
  documentKind: 'deck',
}

table(
  'supersedes payload',
  [
    ...shapeRows(supersedes),
    ['the same document twice', { ...supersedes, olderId: UUID }],
    [
      'the same document twice, plus an extra key',
      { ...supersedes, olderId: UUID, extra: 1 },
    ],
    [
      'the same document twice, with a blank name',
      { ...supersedes, olderId: UUID, newerName: '' },
    ],
    ['the same id, differently cased', { ...supersedes, olderId: UPPER_UUID }],
    ['a kind of other', { ...supersedes, documentKind: 'other' }],
    ['a blank older name', { ...supersedes, olderName: '' }],
    ['a padded older name', { ...supersedes, olderName: ' ' }],
    ...fieldRows(supersedes, 'newerId', UUIDS),
  ],
  (raw) => readPayload(supersedesPayloadSchema, raw),
  readSupersedesPayload,
)

const before = {
  ownershipPct: 2.5,
  fairValue: 100000,
  currency: 'USD',
  roundKind: 'seed',
  roundDate: '2025-01-01',
}

const roundEvent = {
  event: 'round',
  companyId: UUID,
  companyName: 'Acme',
  documentId: UUID_2,
  documentName: 'Cap table.xlsx',
  revisionId: 'rev-1',
  before,
  after: { ownershipPct: 2 },
  proposed: {
    date: '2026-01-01',
    kind: 'series_a',
    raised: 5_000_000,
    currency: 'USD',
    preMoney: 20_000_000,
    postMoney: 25_000_000,
    pricePerShare: 1.25,
    sharesOutstanding: 20_000_000,
  },
}

const markEvent = {
  ...roundEvent,
  event: 'mark',
  proposed: {
    holdingId: UUID,
    date: '2026-01-01',
    fairValue: 250000,
    currency: 'USD',
    basis: 'round_price',
  },
}

table(
  'ledger event payload',
  [
    ...shapeRows(roundEvent).map(([name, raw]): [string, unknown] => [
      `round: ${name}`,
      raw,
    ]),
    ...shapeRows(markEvent).map(([name, raw]): [string, unknown] => [
      `mark: ${name}`,
      raw,
    ]),
    [
      'a round with only its required proposal',
      { ...roundEvent, proposed: { date: '2026-01-01', kind: 'seed' } },
    ],
    [
      'a round proposal with a NaN',
      {
        ...roundEvent,
        proposed: { ...roundEvent.proposed, raised: Number.NaN },
      },
    ],
    [
      'a round proposal with Infinity',
      {
        ...roundEvent,
        proposed: {
          ...roundEvent.proposed,
          preMoney: Number.POSITIVE_INFINITY,
        },
      },
    ],
    [
      'a round proposal with a string amount',
      { ...roundEvent, proposed: { ...roundEvent.proposed, raised: '5' } },
    ],
    [
      'a round proposal with an extra key',
      { ...roundEvent, proposed: { ...roundEvent.proposed, extra: 1 } },
    ],
    [
      'a round proposal with a blank date',
      { ...roundEvent, proposed: { ...roundEvent.proposed, date: '' } },
    ],
    [
      'a round proposal with an undefined amount',
      {
        ...roundEvent,
        proposed: { ...roundEvent.proposed, raised: undefined },
      },
    ],
    [
      'a round carrying a mark proposal',
      { ...roundEvent, proposed: markEvent.proposed },
    ],
    [
      'a mark carrying a round proposal',
      { ...markEvent, proposed: roundEvent.proposed },
    ],
    [
      'a mark with an unknown basis',
      { ...markEvent, proposed: { ...markEvent.proposed, basis: 'guess' } },
    ],
    [
      'a mark with a blank currency',
      { ...markEvent, proposed: { ...markEvent.proposed, currency: '' } },
    ],
    [
      'a mark with a bad holding',
      { ...markEvent, proposed: { ...markEvent.proposed, holdingId: 'x' } },
    ],
    [
      'a mark with a negative zero value',
      { ...markEvent, proposed: { ...markEvent.proposed, fairValue: -0 } },
    ],
    ['an unknown event', { ...roundEvent, event: 'sale' }],
    ['a missing event', { ...roundEvent, event: undefined }],
    [
      'before all null',
      {
        ...roundEvent,
        before: {
          ownershipPct: null,
          fairValue: null,
          currency: null,
          roundKind: null,
          roundDate: null,
        },
      },
    ],
    [
      'before with a missing key',
      { ...roundEvent, before: { ...before, roundDate: undefined } },
    ],
    [
      'before with an extra key',
      { ...roundEvent, before: { ...before, extra: 1 } },
    ],
    ['before null', { ...roundEvent, before: null }],
    ['after null ownership', { ...roundEvent, after: { ownershipPct: null } }],
    ['after empty', { ...roundEvent, after: {} }],
    [
      'after with an extra key',
      { ...roundEvent, after: { ownershipPct: 1, fairValue: 2 } },
    ],
    ['after NaN', { ...roundEvent, after: { ownershipPct: Number.NaN } }],
    [
      'several things wrong at once',
      {
        ...roundEvent,
        companyName: '',
        before: { ...before, fairValue: 'x' },
        proposed: { ...roundEvent.proposed, date: 5 },
        extra: 1,
      },
    ],
  ],
  (raw) => readPayload(ledgerEventPayloadSchema, raw),
  readLedgerEventPayload,
)
