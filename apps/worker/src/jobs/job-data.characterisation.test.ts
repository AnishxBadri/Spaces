import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData } from '../job-data'
import type { JobSchema } from '../job-data'
import { attributeColumnRunData } from './attribute-column-run'
import { attributeRunData } from './attribute-run'
import { bindStorageFolderData } from './bind-storage-folder'
import { classifyDocumentData } from './classify-document'
import { clipDocumentData } from './clip-document'
import { dedupeSweepData } from './dedupe-sweep'
import { embedBackfillData } from './embed-backfill'
import { embedDocumentData } from './embed-document'
import { embedSourceData } from './embed-source'
import { exportDocumentData } from './export-document'
import { exportWorkspaceData } from './export-workspace'
import { extractDocumentData } from './extract-document'
import { extractKeyTermsData } from './extract-key-terms'
import { feedFetchData, feedImagesData, feedLogoData, feedPoll } from './feeds'
import { fetchStorageFileData } from './fetch-storage-file'
import { importCommitData } from './import-commit'
import { ledgerEventData } from './ledger-event'
import { pollMailboxData } from './poll-mailbox'
import { pollStorageChangesData } from './poll-storage-changes'
import { pruneIngressData } from './prune-ingress'
import { readDeckData } from './read-deck'
import { rebindStorageFolderData } from './rebind-storage-folder'
import { recordedNoteTasksData } from './recorded-note-tasks'
import { restampSensitivityData } from './restamp-sensitivity'
import { restoreBytesData } from './restore-bytes'
import { rollInteractionStatsData } from './roll-interaction-stats'
import { suggestSpacesData } from './suggest-spaces'
import { summarizeData } from './summarize'
import {
  summarizeEmailBackfillData,
  summarizeEmailData,
} from './summarize-email'
import { sweepOrphanBlobsData } from './sweep-orphan-blobs'
import { syncStorageBindingData } from './sync-storage-binding'
import { visionDocumentData } from './vision-document'

/**
 * What every job payload schema accepts and refuses, and what it hands the
 * job when it accepts. Every row is a literal expectation: a row that fails
 * is a payload some queue already sends that a job would now treat
 * differently, so change the row only with the sender.
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

/** The id shapes, run once against a one-id payload. */
const uuidRows: ReadonlyArray<Row> = [
  ['a v4 uuid', { documentId: U }, { documentId: U }],
  [
    'upper case',
    { documentId: 'A3BB189E-8BF9-4888-9912-ACE4E6543002' },
    { documentId: 'A3BB189E-8BF9-4888-9912-ACE4E6543002' },
  ],
  [
    'a v7 uuid',
    { documentId: '01890a5d-ac96-774b-bcce-b302099a8057' },
    { documentId: '01890a5d-ac96-774b-bcce-b302099a8057' },
  ],
  [
    'the nil uuid',
    { documentId: '00000000-0000-0000-0000-000000000000' },
    { documentId: '00000000-0000-0000-0000-000000000000' },
  ],
  [
    'the max uuid',
    { documentId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { documentId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
  ],
  [
    'the max uuid upper case',
    { documentId: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' },
    REFUSED,
  ],
  [
    'version 0',
    { documentId: 'a3bb189e-8bf9-0888-9912-ace4e6543002' },
    REFUSED,
  ],
  [
    'version 9',
    { documentId: 'a3bb189e-8bf9-9888-9912-ace4e6543002' },
    REFUSED,
  ],
  [
    'the wrong variant',
    { documentId: 'a3bb189e-8bf9-4888-7912-ace4e6543002' },
    REFUSED,
  ],
  ['no dashes', { documentId: 'a3bb189e8bf948889912ace4e6543002' }, REFUSED],
  ['braces', { documentId: `{${U}}` }, REFUSED],
  ['padded', { documentId: ` ${U}` }, REFUSED],
  ['a number', { documentId: 7 }, REFUSED],
  ['null', { documentId: null }, REFUSED],
  ['missing', {}, REFUSED],
  ['an extra key is dropped', { documentId: U, extra: 1 }, { documentId: U }],
  ['null payload', null, REFUSED],
  ['undefined payload', undefined, REFUSED],
  ['an array payload', [], REFUSED],
  ['a string payload', 'x', REFUSED],
]

/** A payload of one id: accepted, stripped, and refused the usual ways. */
const oneId = (key: string): ReadonlyArray<Row> => [
  ['the id', { [key]: U }, { [key]: U }],
  ['an extra key is dropped', { [key]: U, other: U2 }, { [key]: U }],
  ['not a uuid', { [key]: 'x' }, REFUSED],
  ['missing', {}, REFUSED],
  ['null payload', null, REFUSED],
]

/** A payload of a document and the user it runs for. */
const documentAndUser = (key: string): ReadonlyArray<Row> => [
  ['both', { [key]: U, userId: 'u' }, { [key]: U, userId: 'u' }],
  [
    'a blank-looking user is a user',
    { [key]: U, userId: ' ' },
    { [key]: U, userId: ' ' },
  ],
  ['an empty user', { [key]: U, userId: '' }, REFUSED],
  ['no user', { [key]: U }, REFUSED],
  ['a numeric user', { [key]: U, userId: 1 }, REFUSED],
  ['not a uuid', { [key]: 'x', userId: 'u' }, REFUSED],
]

/** The scheduled shapes: pg-boss stores `null` for a payload-less schedule. */
const scheduledRows: ReadonlyArray<Row> = [
  ['null', null, {}],
  ['undefined', undefined, {}],
  ['empty', {}, {}],
  ['an extra key is dropped', { x: 1 }, {}],
  ['an array', [], REFUSED],
  ['a string', 'x', REFUSED],
  ['a number', 0, REFUSED],
  ['false', false, REFUSED],
]

/** An object with no keys: anything object-shaped, never null. */
const emptyRows: ReadonlyArray<Row> = [
  ['empty', {}, {}],
  ['an extra key is dropped', { x: 1 }, {}],
  ['null', null, REFUSED],
  ['undefined', undefined, REFUSED],
  ['an array', [], REFUSED],
  ['a string', 'x', REFUSED],
]

const BIG_INT = 2 ** 53 + 2

const table: ReadonlyArray<
  readonly [name: string, schema: Decodes, rows: ReadonlyArray<Row>]
> = [
  ['uuid', embedDocumentData, uuidRows],
  [
    'attributeColumnRunData',
    attributeColumnRunData,
    [
      [
        'all three',
        { viewId: U, attributeId: U2, userId: 'u' },
        { viewId: U, attributeId: U2, userId: 'u' },
      ],
      ['an empty user', { viewId: U, attributeId: U2, userId: '' }, REFUSED],
      ['no view', { attributeId: U2, userId: 'u' }, REFUSED],
    ],
  ],
  [
    'attributeRunData',
    attributeRunData,
    [
      [
        'all three',
        { entityId: U, attributeId: U2, userId: 'u', x: 1 },
        { entityId: U, attributeId: U2, userId: 'u' },
      ],
      ['an empty user', { entityId: U, attributeId: U2, userId: '' }, REFUSED],
      [
        'a bad attribute',
        { entityId: U, attributeId: 'a', userId: 'u' },
        REFUSED,
      ],
    ],
  ],
  [
    'bindStorageFolderData',
    bindStorageFolderData,
    [
      [
        'by url',
        {
          connectionId: U,
          folder: { url: 'https://drive.example/folders/1' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        {
          connectionId: U,
          folder: { url: 'https://drive.example/folders/1' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
      ],
      [
        'by id',
        {
          connectionId: U,
          folder: { id: 'f1' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: false,
            retain: 'text',
            direction: 'both',
            sensitivity: 'sensitive',
          },
        },
        {
          connectionId: U,
          folder: { id: 'f1' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: false,
            retain: 'text',
            direction: 'both',
            sensitivity: 'sensitive',
          },
        },
      ],
      [
        'a padded url is trimmed',
        {
          connectionId: U,
          folder: { url: '  https://drive.example/f  ' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'push',
            sensitivity: 'inherit',
          },
        },
        {
          connectionId: U,
          folder: { url: 'https://drive.example/f' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'push',
            sensitivity: 'inherit',
          },
        },
      ],
      [
        'a bad url falls through to the id',
        {
          connectionId: U,
          folder: { url: 'not a url', id: 'f2' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        {
          connectionId: U,
          folder: { id: 'f2' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
      ],
      [
        'both is the url',
        {
          connectionId: U,
          folder: { url: 'https://a.example', id: 'f2' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        {
          connectionId: U,
          folder: { url: 'https://a.example' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
      ],
      [
        'any scheme new URL parses',
        {
          connectionId: U,
          folder: { url: 'mailto:a@b.example' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        {
          connectionId: U,
          folder: { url: 'mailto:a@b.example' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
      ],
      [
        'a bad url alone',
        {
          connectionId: U,
          folder: { url: 'not a url' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        REFUSED,
      ],
      [
        'an empty id',
        {
          connectionId: U,
          folder: { id: '' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        REFUSED,
      ],
      [
        'an id of 201 characters',
        {
          connectionId: U,
          folder: { id: 'f'.repeat(201) },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        REFUSED,
      ],
      [
        'an unknown retain',
        {
          connectionId: U,
          folder: { id: 'f1' },
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'none',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        REFUSED,
      ],
      [
        'no options',
        {
          connectionId: U,
          folder: { id: 'f1' },
          targetEntityId: U2,
          actorUserId: 'u',
        },
        REFUSED,
      ],
      [
        'an empty folder',
        {
          connectionId: U,
          folder: {},
          targetEntityId: U2,
          actorUserId: 'u',
          options: {
            mapSubfolders: true,
            retain: 'full',
            direction: 'pull',
            sensitivity: 'inherit',
          },
        },
        REFUSED,
      ],
    ],
  ],
  ['classifyDocumentData', classifyDocumentData, oneId('documentId')],
  ['clipDocumentData', clipDocumentData, oneId('documentId')],
  [
    'dedupeSweepData',
    dedupeSweepData,
    [
      ...scheduledRows,
      ['an object', { objectId: U }, { objectId: U }],
      [
        'an explicit undefined',
        { objectId: undefined },
        { objectId: undefined },
      ],
      ['a bad object', { objectId: 'x' }, REFUSED],
      ['a null object', { objectId: null }, REFUSED],
    ],
  ],
  ['embedBackfillData', embedBackfillData, emptyRows],
  ['embedDocumentData', embedDocumentData, oneId('documentId')],
  [
    'embedSourceData',
    embedSourceData,
    [
      [
        'a note',
        { entityId: U, sourceKind: 'note', sourceKey: '' },
        { entityId: U, sourceKind: 'note', sourceKey: '' },
      ],
      [
        'an attribute',
        { entityId: U, sourceKind: 'attribute', sourceKey: 'stage', x: 1 },
        { entityId: U, sourceKind: 'attribute', sourceKey: 'stage' },
      ],
      [
        'a note with a key',
        { entityId: U, sourceKind: 'note', sourceKey: 'x' },
        REFUSED,
      ],
      [
        'an attribute without a key',
        { entityId: U, sourceKind: 'attribute', sourceKey: '' },
        REFUSED,
      ],
      [
        'an unknown kind',
        { entityId: U, sourceKind: 'file', sourceKey: '' },
        REFUSED,
      ],
      ['no kind', { entityId: U, sourceKey: '' }, REFUSED],
      [
        'a bad entity',
        { entityId: 'x', sourceKind: 'note', sourceKey: '' },
        REFUSED,
      ],
    ],
  ],
  ['exportDocumentData', exportDocumentData, oneId('documentId')],
  [
    'exportWorkspaceData',
    exportWorkspaceData,
    [
      ['a requester', { requestedBy: 'u' }, { requestedBy: 'u' }],
      ['an empty requester', { requestedBy: '' }, REFUSED],
      ['none', {}, REFUSED],
    ],
  ],
  ['extractDocumentData', extractDocumentData, oneId('documentId')],
  ['extractKeyTermsData', extractKeyTermsData, documentAndUser('documentId')],
  ['feed.poll', feedPoll.schema, scheduledRows],
  ['feedFetchData', feedFetchData, oneId('feedId')],
  [
    'feedImagesData',
    feedImagesData,
    [
      ['none', { itemIds: [] }, { itemIds: [] }],
      ['two', { itemIds: [U, U2] }, { itemIds: [U, U2] }],
      [
        'fifty',
        { itemIds: Array.from({ length: 50 }, () => U) },
        { itemIds: Array.from({ length: 50 }, () => U) },
      ],
      ['fifty-one', { itemIds: Array.from({ length: 51 }, () => U) }, REFUSED],
      ['a bad id', { itemIds: [U, 'x'] }, REFUSED],
      ['not a list', { itemIds: U }, REFUSED],
      ['missing', {}, REFUSED],
    ],
  ],
  ['feedLogoData', feedLogoData, oneId('feedId')],
  [
    'fetchStorageFileData',
    fetchStorageFileData,
    [
      [
        'all four',
        {
          url: 'https://drive.example/file/d/1',
          connectionId: U,
          attachTo: U2,
          actorUserId: 'u',
        },
        {
          url: 'https://drive.example/file/d/1',
          connectionId: U,
          attachTo: U2,
          actorUserId: 'u',
        },
      ],
      [
        'a padded url is trimmed',
        {
          url: ' https://a.example/x ',
          connectionId: U,
          attachTo: U2,
          actorUserId: 'u',
        },
        {
          url: 'https://a.example/x',
          connectionId: U,
          attachTo: U2,
          actorUserId: 'u',
        },
      ],
      [
        'a relative url',
        { url: '/file/1', connectionId: U, attachTo: U2, actorUserId: 'u' },
        REFUSED,
      ],
      [
        'an empty url',
        { url: '', connectionId: U, attachTo: U2, actorUserId: 'u' },
        REFUSED,
      ],
      [
        'no actor',
        { url: 'https://a.example', connectionId: U, attachTo: U2 },
        REFUSED,
      ],
    ],
  ],
  [
    'importCommitData',
    importCommitData,
    [
      [
        'the batch',
        { batchId: U, userId: 'u', onlyFailed: false },
        { batchId: U, userId: 'u', onlyFailed: false },
      ],
      [
        'a string flag',
        { batchId: U, userId: 'u', onlyFailed: 'true' },
        REFUSED,
      ],
      ['no flag', { batchId: U, userId: 'u' }, REFUSED],
    ],
  ],
  [
    'ledgerEventData',
    ledgerEventData,
    [
      [
        'both',
        { documentId: U, revisionId: 'r1' },
        { documentId: U, revisionId: 'r1' },
      ],
      ['an empty revision', { documentId: U, revisionId: '' }, REFUSED],
    ],
  ],
  [
    'pollMailboxData',
    pollMailboxData,
    [
      ...scheduledRows,
      [
        'both ids',
        { mailboxId: U, integrationId: U2 },
        { mailboxId: U, integrationId: U2 },
      ],
      ['a mailbox', { mailboxId: U }, { mailboxId: U }],
      ['a bad integration', { integrationId: 'x' }, REFUSED],
    ],
  ],
  ['pollStorageChangesData', pollStorageChangesData, scheduledRows],
  [
    'pruneIngressData',
    pruneIngressData,
    [
      ...scheduledRows,
      ['zero days', { retentionDays: 0 }, { retentionDays: 0 }],
      ['thirty days', { retentionDays: 30 }, { retentionDays: 30 }],
      ['a fraction', { retentionDays: 1.5 }, REFUSED],
      ['negative', { retentionDays: -1 }, REFUSED],
      ['a numeric string', { retentionDays: '3' }, REFUSED],
      ['past the safe integers', { retentionDays: BIG_INT }, REFUSED],
      ['NaN', { retentionDays: Number.NaN }, REFUSED],
      ['infinite', { retentionDays: Number.POSITIVE_INFINITY }, REFUSED],
    ],
  ],
  [
    'readDeckData',
    readDeckData,
    [
      ...documentAndUser('documentId'),
      [
        'onto a record',
        { documentId: U, userId: 'u', summarizeOnto: U2 },
        { documentId: U, userId: 'u', summarizeOnto: U2 },
      ],
      [
        'captured',
        { documentId: U, userId: 'u', capture: { objectId: U2, x: 1 } },
        { documentId: U, userId: 'u', capture: { objectId: U2 } },
      ],
      [
        'a bad capture',
        { documentId: U, userId: 'u', capture: { objectId: 'x' } },
        REFUSED,
      ],
      [
        'a null onto',
        { documentId: U, userId: 'u', summarizeOnto: null },
        REFUSED,
      ],
    ],
  ],
  [
    'rebindStorageFolderData',
    rebindStorageFolderData,
    [
      [
        'all four',
        { bindingId: U, connectionId: U2, actorUserId: 'u', commit: true },
        { bindingId: U, connectionId: U2, actorUserId: 'u', commit: true },
      ],
      [
        'no commit',
        { bindingId: U, connectionId: U2, actorUserId: 'u' },
        REFUSED,
      ],
    ],
  ],
  [
    'recordedNoteTasksData',
    recordedNoteTasksData,
    [
      [
        'all four',
        { interactionId: U, noteId: U2, integrationId: U, receiptId: U2 },
        { interactionId: U, noteId: U2, integrationId: U, receiptId: U2 },
      ],
      [
        'a bad receipt',
        { interactionId: U, noteId: U2, integrationId: U, receiptId: 'r' },
        REFUSED,
      ],
    ],
  ],
  [
    'restampSensitivityData',
    restampSensitivityData,
    [
      ['an entity', { entityId: U }, { entityId: U }],
      ['all', { all: true }, { all: true }],
      ['the first that fits wins', { entityId: U, all: true }, { entityId: U }],
      ['a bad entity with all', { entityId: 'x', all: true }, { all: true }],
      ['all false', { all: false }, REFUSED],
      ['a bad entity', { entityId: 'x' }, REFUSED],
      ['empty', {}, REFUSED],
      ['null', null, REFUSED],
    ],
  ],
  ['restoreBytesData', restoreBytesData, oneId('documentId')],
  ['rollInteractionStatsData', rollInteractionStatsData, scheduledRows],
  ['suggestSpacesData', suggestSpacesData, documentAndUser('entityId')],
  [
    'summarizeData',
    summarizeData,
    [
      [
        'a document',
        { recordId: U, documentId: U2, userId: 'u' },
        { recordId: U, documentId: U2, userId: 'u' },
      ],
      [
        'no document',
        { recordId: U, documentId: null, userId: 'u' },
        { recordId: U, documentId: null, userId: 'u' },
      ],
      ['a missing document', { recordId: U, userId: 'u' }, REFUSED],
      ['an empty user', { recordId: U, documentId: null, userId: '' }, REFUSED],
    ],
  ],
  ['summarizeEmailData', summarizeEmailData, oneId('interactionId')],
  ['summarizeEmailBackfillData', summarizeEmailBackfillData, emptyRows],
  [
    'sweepOrphanBlobsData',
    sweepOrphanBlobsData,
    [
      ...scheduledRows,
      ['no grace', { graceMs: 0 }, { graceMs: 0 }],
      ['a minute', { graceMs: 60_000 }, { graceMs: 60_000 }],
      ['negative', { graceMs: -1 }, REFUSED],
      ['a fraction', { graceMs: 0.5 }, REFUSED],
      ['past the safe integers', { graceMs: BIG_INT }, REFUSED],
    ],
  ],
  ['syncStorageBindingData', syncStorageBindingData, oneId('bindingId')],
  ['visionDocumentData', visionDocumentData, documentAndUser('documentId')],
]

describe.each(table)('%s', (_name, schema, rows) => {
  it.each(rows)('%s', (_label, input, expected) => {
    expect(decode(schema, input)).toStrictEqual(expected)
  })
})
