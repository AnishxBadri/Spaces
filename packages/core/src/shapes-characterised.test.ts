import { Result, SchemaParser } from 'effect'
import type { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { readRefileDocumentPayload } from './documents/refile'
import { enrichmentRunData } from './enrichment/auto'
import { enrichmentSettingsOf } from './enrichment/settings'
import { websiteOutput } from './enrichment/website'
import { fileJobData } from './import/dialect'
import { autoEnrichScopeOf } from './plugins/auto-enrich'
import { creditDefaults, creditPolicy } from './plugins/credit'
import { lockSchema } from './plugins/lock'
import { watchRunData } from './queue/watch'
import { entitySearchInput } from './search/entity-search-input'
import { surfaceKey } from './views/target'

/**
 * Core's pure shapes at their edges: what each accepts, what it hands on,
 * and what it refuses. Every row was held against the zod shapes before
 * they were Effect schemas, so a row that moves is a caller who sees a
 * different answer.
 */

const REFUSED = 'REFUSED'

/** The schema's output for `input`, or `REFUSED`. */
const decoded = (schema: Schema.Decoder<unknown>, input: unknown): unknown => {
  const r = SchemaParser.decodeUnknownResult(schema)(input)
  return Result.isSuccess(r) ? r.success : REFUSED
}

/** `fn` called with an input a bundle or a row could send, typed or not. */
const call = (fn: (input: never) => unknown, input: unknown): unknown =>
  Reflect.apply(fn, undefined, [input])

type Row = readonly [label: string, input: unknown, out: unknown]

const table = (name: string, run: (input: unknown) => unknown) =>
  function rows(list: ReadonlyArray<Row>) {
    describe(name, () => {
      it.each(list)('%s', (_, input, out) => {
        expect(run(input)).toEqual(out)
      })
    })
  }

const U = 'a3bb189e-8bf9-4888-9912-ace4e6543002'
const U2 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const U3 = '01890a5d-ac96-774b-bcce-b302099a8057'
const SHA = 'a'.repeat(64)

const refile = {
  documentId: U,
  fromEntityId: U2,
  toEntityId: U3,
  sourcePath: 'Deals/Acme',
  documentName: 'deck.pdf',
  fromName: 'Acme',
  toName: 'Acme Holdings',
}

table('readRefileDocumentPayload', (input) => readRefileDocumentPayload(input))(
  [
    ['a full payload', refile, refile],
    [
      'an empty source path',
      { ...refile, sourcePath: '' },
      { ...refile, sourcePath: '' },
    ],
    [
      'upper-case ids',
      { ...refile, documentId: U.toUpperCase() },
      { ...refile, documentId: U.toUpperCase() },
    ],
    ['a stray key', { ...refile, note: 'x' }, null],
    ['the same record twice', { ...refile, toEntityId: U2 }, null],
    ['an empty document name', { ...refile, documentName: '' }, null],
    ['an empty from name', { ...refile, fromName: '' }, null],
    ['a bad id', { ...refile, documentId: 'x' }, null],
    [
      'the max uuid upper-case',
      { ...refile, documentId: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' },
      null,
    ],
    ['a missing source path', { ...refile, sourcePath: undefined }, null],
    ['a number for a name', { ...refile, toName: 7 }, null],
    ['null', null, null],
    ['a string', 'refile', null],
    ['a list', [refile], null],
  ],
)

table('enrichmentRunData', (input) => decoded(enrichmentRunData, input))([
  [
    'the Enrich button',
    { entityId: U, reason: 'Enrich' },
    { entityId: U, reason: 'Enrich' },
  ],
  [
    'a stray key',
    { entityId: U, reason: 'x', extra: 1 },
    { entityId: U, reason: 'x' },
  ],
  ['an empty reason', { entityId: U, reason: '' }, REFUSED],
  [
    'a 100-character reason',
    { entityId: U, reason: 'r'.repeat(100) },
    { entityId: U, reason: 'r'.repeat(100) },
  ],
  ['a 101-character reason', { entityId: U, reason: 'r'.repeat(101) }, REFUSED],
  ['no reason', { entityId: U }, REFUSED],
  ['a bad entity id', { entityId: 'x', reason: 'x' }, REFUSED],
  [
    'an upper-case entity id',
    { entityId: U.toUpperCase(), reason: 'x' },
    { entityId: U.toUpperCase(), reason: 'x' },
  ],
  [
    'one source',
    { entityId: U, reason: 'x', sources: [U2] },
    { entityId: U, reason: 'x', sources: [U2] },
  ],
  ['no sources', { entityId: U, reason: 'x', sources: [] }, REFUSED],
  ['a bad source', { entityId: U, reason: 'x', sources: ['x'] }, REFUSED],
  [
    'sources undefined',
    { entityId: U, reason: 'x', sources: undefined },
    { entityId: U, reason: 'x' },
  ],
  ['sources null', { entityId: U, reason: 'x', sources: null }, REFUSED],
  [
    'a trigger',
    { entityId: U, reason: 'x', trigger: 'deal.linked' },
    { entityId: U, reason: 'x', trigger: 'deal.linked' },
  ],
  [
    'an unknown trigger',
    { entityId: U, reason: 'x', trigger: 'deal.won' },
    REFUSED,
  ],
  [
    'parked by a source',
    { entityId: U, reason: 'x', parkedBy: U2 },
    { entityId: U, reason: 'x', parkedBy: U2 },
  ],
  ['parked by a bad id', { entityId: U, reason: 'x', parkedBy: 'x' }, REFUSED],
  [
    'bulk',
    { entityId: U, reason: 'x', bulk: true },
    { entityId: U, reason: 'x', bulk: true },
  ],
  ['bulk false', { entityId: U, reason: 'x', bulk: false }, REFUSED],
  ['null', null, REFUSED],
  ['a list', [], REFUSED],
])

const noSettings = { sources: null, reuseDays: null, scopes: new Map() }

table('enrichmentSettingsOf', (input) =>
  enrichmentSettingsOf({ enrichment: input }),
)([
  ['nothing stored', undefined, noSettings],
  ['an empty object', {}, noSettings],
  ['a string', 'x', noSettings],
  ['a list', [], noSettings],
  ['null', null, noSettings],
  ['an order', { sources: [U, U2] }, { ...noSettings, sources: [U, U2] }],
  ['an empty order', { sources: [] }, { ...noSettings, sources: [] }],
  ['an order with a bad id', { sources: [U, 'x'] }, noSettings],
  ['an order that is a string', { sources: U }, noSettings],
  ['a reuse window', { reuseDays: 30 }, { ...noSettings, reuseDays: 30 }],
  ['a zero window', { reuseDays: 0 }, { ...noSettings, reuseDays: 0 }],
  ['ten years', { reuseDays: 3650 }, { ...noSettings, reuseDays: 3650 }],
  ['past ten years', { reuseDays: 3651 }, noSettings],
  ['a fraction', { reuseDays: 1.5 }, noSettings],
  ['a negative window', { reuseDays: -1 }, noSettings],
  ['a window as text', { reuseDays: '30' }, noSettings],
  ['a null window', { reuseDays: null }, noSettings],
  [
    'a bad order beside a good window',
    { sources: 'x', reuseDays: 7 },
    { ...noSettings, reuseDays: 7 },
  ],
  [
    'a scope',
    { scopes: { [U]: { scopes: ['space', 'deal'], spaces: [U2] } } },
    {
      ...noSettings,
      scopes: new Map([[U, { scopes: ['deal', 'space'], spaces: [U2] }]]),
    },
  ],
  [
    'a scope with unknown names and a bad space',
    { scopes: { [U]: { scopes: ['deal', 'bogus', 3], spaces: [U2, 'x'] } } },
    { ...noSettings, scopes: new Map([[U, { scopes: ['deal'], spaces: [] }]]) },
  ],
  [
    'an empty scope',
    { scopes: { [U]: {} } },
    { ...noSettings, scopes: new Map([[U, { scopes: [], spaces: [] }]]) },
  ],
  [
    'a scope whose list is a string',
    { scopes: { [U]: { scopes: 'deal', spaces: [U2] } } },
    { ...noSettings, scopes: new Map([[U, { scopes: [], spaces: [] }]]) },
  ],
  [
    'a scope that is a string, beside a good one',
    { scopes: { [U]: 'deal', [U2]: { scopes: ['meeting'] } } },
    {
      ...noSettings,
      scopes: new Map([
        [U, { scopes: [], spaces: [] }],
        [U2, { scopes: ['meeting'], spaces: [] }],
      ]),
    },
  ],
  [
    'a scope that is null',
    { scopes: { [U]: null } },
    { ...noSettings, scopes: new Map([[U, { scopes: [], spaces: [] }]]) },
  ],
  ['scopes as a list', { scopes: [{ scopes: ['deal'] }] }, noSettings],
  ['scopes as a string', { scopes: 'deal' }, noSettings],
  ['scopes as a date', { scopes: new Date(0) }, noSettings],
  [
    'scopes with a __proto__ key',
    JSON.parse(
      `{"scopes":{"__proto__":{"scopes":["deal"]},"${U}":{"scopes":["meeting"]}}}`,
    ),
    {
      ...noSettings,
      scopes: new Map([[U, { scopes: ['meeting'], spaces: [] }]]),
    },
  ],
])

table('autoEnrichScopeOf', (input) => call(autoEnrichScopeOf, input))([
  ['no keys', {}, { scopes: ['deal'], spaces: [] }],
  ['no scopes ticked', { autoEnrichScopes: [] }, { scopes: [], spaces: [] }],
  [
    'scopes as a string',
    { autoEnrichScopes: 'deal' },
    { scopes: ['deal'], spaces: [] },
  ],
  ['scopes null', { autoEnrichScopes: null }, { scopes: ['deal'], spaces: [] }],
  [
    'scopes out of order with strays',
    { autoEnrichScopes: ['meeting', 'deal', 3, 'bogus'] },
    { scopes: ['deal', 'meeting'], spaces: [] },
  ],
  [
    'spaces',
    { autoEnrichSpaces: [U, U2] },
    { scopes: ['deal'], spaces: [U, U2] },
  ],
  [
    'a bad space',
    { autoEnrichSpaces: [U, 'x'] },
    { scopes: ['deal'], spaces: [] },
  ],
  [
    'spaces as a string',
    { autoEnrichSpaces: U },
    { scopes: ['deal'], spaces: [] },
  ],
])

const defaults = { cacheDays: 90, dailyCreditCap: null }

table('creditPolicy', (input) =>
  call((c: never) => creditPolicy(c, defaults), input),
)([
  ['nothing set', {}, defaults],
  [
    'a window and a cap',
    { cacheDays: 30, dailyCreditCap: 100 },
    { cacheDays: 30, dailyCreditCap: 100 },
  ],
  [
    'zeroes',
    { cacheDays: 0, dailyCreditCap: 0 },
    { cacheDays: 0, dailyCreditCap: 0 },
  ],
  ['a fraction', { cacheDays: 1.5 }, { ...defaults, cacheDays: 1.5 }],
  ['a negative', { cacheDays: -1, dailyCreditCap: -5 }, defaults],
  ['text', { cacheDays: '30', dailyCreditCap: '5' }, defaults],
  ['null', { cacheDays: null, dailyCreditCap: null }, defaults],
  ['infinity', { cacheDays: Infinity, dailyCreditCap: -Infinity }, defaults],
  ['not a number', { cacheDays: NaN }, defaults],
])

table('creditDefaults', (settings) => call(creditDefaults, { settings }))([
  ['no properties', {}, defaults],
  [
    'both declared',
    {
      properties: {
        cacheDays: { type: 'number', default: 30 },
        dailyCreditCap: { type: 'number', default: 250 },
      },
    },
    { cacheDays: 30, dailyCreditCap: 250 },
  ],
  [
    'a property with no default beside a declared one',
    {
      properties: {
        cacheDays: { type: 'number', default: 30 },
        apiKey: { type: 'string' },
      },
    },
    defaults,
  ],
  [
    'a property that is not an object',
    { properties: { cacheDays: { default: 30 }, other: 'x' } },
    defaults,
  ],
  [
    'a default undefined',
    { properties: { cacheDays: { default: undefined } } },
    defaults,
  ],
  ['properties as a list', { properties: [] }, defaults],
  [
    'a bad default',
    {
      properties: {
        cacheDays: { default: 'x' },
        dailyCreditCap: { default: 5 },
      },
    },
    { cacheDays: 90, dailyCreditCap: 5 },
  ],
])

table('websiteOutput', (input) => decoded(websiteOutput, input))([
  [
    'every field',
    {
      description: 'd',
      location: 'l',
      linkedin: 'li',
      twitter: 't',
      crunchbase: 'c',
      blog: 'b',
      logo: 'o',
    },
    {
      description: 'd',
      location: 'l',
      linkedin: 'li',
      twitter: 't',
      crunchbase: 'c',
      blog: 'b',
      logo: 'o',
    },
  ],
  [
    'nothing',
    {},
    {
      description: '',
      location: '',
      linkedin: '',
      twitter: '',
      crunchbase: '',
      blog: '',
      logo: '',
    },
  ],
  [
    'wrong types and a stray',
    { description: 5, location: 'Paris', blog: null, logo: ['x'], extra: 'x' },
    {
      description: '',
      location: 'Paris',
      linkedin: '',
      twitter: '',
      crunchbase: '',
      blog: '',
      logo: '',
    },
  ],
  ['null', null, REFUSED],
  ['a string', 'x', REFUSED],
  ['a list', [], REFUSED],
])

const file = { blobSha: SHA, filename: 'deals.csv', mime: 'text/csv' }

table('fileJobData', (input) => decoded(fileJobData, input))([
  ['a dropped file', file, file],
  ['no type', { ...file, mime: null }, { ...file, mime: null }],
  ['a batch', { ...file, batchId: U }, { ...file, batchId: U }],
  ['a stray key', { ...file, extra: 1 }, file],
  ['a missing type', { blobSha: SHA, filename: 'x' }, REFUSED],
  ['an upper-case digest', { ...file, blobSha: 'A'.repeat(64) }, REFUSED],
  ['a short digest', { ...file, blobSha: 'a'.repeat(63) }, REFUSED],
  ['an empty name', { ...file, filename: '' }, REFUSED],
  ['a bad batch', { ...file, batchId: 'x' }, REFUSED],
  ['a numeric type', { ...file, mime: 1 }, REFUSED],
])

const entry = { version: '1.2.0', sha256: SHA }

table('lockSchema', (input) => decoded(lockSchema, input))([
  ['an empty lock', {}, { plugins: {} }],
  ['plugins undefined', { plugins: undefined }, { plugins: {} }],
  [
    'a pinned plugin',
    { core: '0.2.0', plugins: { echo: entry } },
    { core: '0.2.0', plugins: { echo: entry } },
  ],
  ['an empty core', { core: '', plugins: {} }, REFUSED],
  ['a stray top key', { plugins: {}, extra: 1 }, REFUSED],
  ['a stray entry key', { plugins: { echo: { ...entry, at: 'x' } } }, REFUSED],
  [
    'an upper-case digest',
    { plugins: { echo: { ...entry, sha256: 'A'.repeat(64) } } },
    REFUSED,
  ],
  [
    'an empty version',
    { plugins: { echo: { ...entry, version: '' } } },
    REFUSED,
  ],
  ['plugins null', { plugins: null }, REFUSED],
  ['plugins as a list', { plugins: [entry] }, REFUSED],
  ['plugins as a date', { plugins: new Date(0) }, REFUSED],
  [
    'a __proto__ plugin',
    JSON.parse(
      `{"plugins":{"__proto__":${JSON.stringify(entry)},"echo":${JSON.stringify(entry)}}}`,
    ),
    { plugins: { echo: entry } },
  ],
  ['null', null, REFUSED],
])

table('watchRunData', (input) => decoded(watchRunData, input))([
  ['a run', { watchId: U, spaceId: U2 }, { watchId: U, spaceId: U2 }],
  [
    'a stray key',
    { watchId: U, spaceId: U2, at: 1 },
    { watchId: U, spaceId: U2 },
  ],
  ['a bad space', { watchId: U, spaceId: 'x' }, REFUSED],
  ['no watch', { spaceId: U2 }, REFUSED],
  ['null', null, REFUSED],
])

table('entitySearchInput', (input) => decoded(entitySearchInput, input))([
  ['an empty query', { q: '' }, { q: '' }],
  ['120 characters', { q: 'q'.repeat(120) }, { q: 'q'.repeat(120) }],
  ['121 characters', { q: 'q'.repeat(121) }, REFUSED],
  [
    'kinds',
    { q: 'a', kinds: ['company', 'custom'] },
    { q: 'a', kinds: ['company', 'custom'] },
  ],
  ['no kinds', { q: 'a', kinds: [] }, { q: 'a', kinds: [] }],
  ['an unknown kind', { q: 'a', kinds: ['task'] }, REFUSED],
  ['an object', { q: 'a', objectId: U }, { q: 'a', objectId: U }],
  ['a bad object', { q: 'a', objectId: 'x' }, REFUSED],
  ['a stray key', { q: 'a', limit: 5 }, { q: 'a' }],
  ['no query', {}, REFUSED],
  ['a padded query', { q: '  a ' }, { q: '  a ' }],
])

table('surfaceKey', (input) => decoded(surfaceKey, input))([
  [
    'an object by kind',
    { surface: 'object', kind: 'deal' },
    { surface: 'object', kind: 'deal' },
  ],
  [
    'an object by id',
    { surface: 'object', objectId: U },
    { surface: 'object', objectId: U },
  ],
  ['an object by neither', { surface: 'object' }, REFUSED],
  [
    'an object by both',
    { surface: 'object', kind: 'deal', objectId: U },
    REFUSED,
  ],
  ['an unknown kind', { surface: 'object', kind: 'space' }, REFUSED],
  ['a bad id', { surface: 'object', objectId: 'x' }, REFUSED],
  [
    'a stray key',
    { surface: 'object', kind: 'company', viewId: U },
    { surface: 'object', kind: 'company' },
  ],
  ['documents', { surface: 'document' }, { surface: 'document' }],
  [
    'documents with a kind',
    { surface: 'document', kind: 'deal' },
    { surface: 'document' },
  ],
  ['an unknown surface', { surface: 'task' }, REFUSED],
  ['no surface', { kind: 'company' }, REFUSED],
  ['null', null, REFUSED],
])
