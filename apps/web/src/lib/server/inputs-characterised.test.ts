import type * as Start from '@tanstack/react-start'
import { describe, expect, it, vi } from 'vitest'
import { REFUSED, verdict } from '#/test/server-fn-validators'

vi.mock('@tanstack/react-start', async (actual) =>
  (await import('#/test/server-fn-validators')).capturingStart(
    await actual<typeof Start>(),
  ),
)

/**
 * The server fns' input boundaries at their edges, through each fn's own
 * validator: what the handler receives, or `REFUSED`. Every row was held
 * against the zod shapes before they were Effect schemas, so a row that
 * moves is a caller who sees a different answer.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const ID2 = '7f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'

const modules = {
  archive: () => import('./archive'),
  bindings: () => import('./bindings'),
  connections: () => import('./connections'),
  documentPreview: () => import('./document-preview'),
  enrichment: () => import('./enrichment'),
  follow: () => import('./follow'),
  identity: () => import('./identity'),
  integrations: () => import('./integrations'),
  keyTerms: () => import('./key-terms'),
  mailbox: () => import('./mailbox'),
  meetings: () => import('./meetings'),
  objects: () => import('./objects'),
  pictures: () => import('./pictures'),
  plugins: () => import('./plugins'),
  readDeck: () => import('./read-deck'),
  sensitivity: () => import('./sensitivity'),
  spaces: () => import('./spaces'),
  storage: () => import('./storage'),
  suggestions: () => import('./suggestions'),
  summarize: () => import('./summarize'),
  timeline: () => import('./timeline'),
  tokens: () => import('./tokens'),
  versions: () => import('./versions'),
  vision: () => import('./vision'),
}

type Row = readonly [fn: string, label: string, input: unknown, out: unknown]

const table = (name: keyof typeof modules, rows: ReadonlyArray<Row>) =>
  describe(name, () => {
    it.each(rows)('%s: %s', async (fn, _, value, out) => {
      const mod: object = await modules[name]()
      expect(await verdict(Reflect.get(mod, fn), value)).toEqual(out)
    })
  })

const form = (fields: Record<string, string | File>) => {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}
const picture = new File([new Uint8Array([1, 2, 3])], 'face.png', {
  type: 'image/png',
})

table('archive', [
  ['getRecordArchive', 'an id', { id: ID }, { id: ID }],
  ['getRecordArchive', 'a bad id', { id: 'x' }, REFUSED],
  ['archiveRecord', 'a stray key', { id: ID, role: 'admin' }, { id: ID }],
  ['restoreRecord', 'nothing', undefined, REFUSED],
  [
    'restoreRecord',
    'an upper-case id',
    { id: ID.toUpperCase() },
    { id: ID.toUpperCase() },
  ],
  [
    'restoreRecord',
    'the nil id',
    { id: '00000000-0000-0000-0000-000000000000' },
    { id: '00000000-0000-0000-0000-000000000000' },
  ],
  [
    'restoreRecord',
    'a version-0 id',
    { id: '0b6ad7a2-6a3e-0c4f-9a43-5d1f1d8b6c11' },
    REFUSED,
  ],
])

table('bindings', [
  [
    'linkDriveFolder',
    'a padded url',
    {
      folder: { url: '  https://drive.google.com/drive/folders/abc  ' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/companies/acme',
    },
    {
      folder: { url: 'https://drive.google.com/drive/folders/abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/companies/acme',
    },
  ],
  [
    'linkDriveFolder',
    'a folder id',
    {
      folder: { id: 'abc_DEF-123' },
      attachTo: ID,
      options: {
        mapSubfolders: false,
        retain: 'text',
        direction: 'both',
        sensitivity: 'sensitive',
      },
      returnTo: '/',
    },
    {
      folder: { id: 'abc_DEF-123' },
      attachTo: ID,
      options: {
        mapSubfolders: false,
        retain: 'text',
        direction: 'both',
        sensitivity: 'sensitive',
      },
      returnTo: '/',
    },
  ],
  [
    'linkDriveFolder',
    'a bad url beside a good id',
    {
      folder: { url: 'not a url', id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
    {
      folder: { id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
  ],
  [
    'linkDriveFolder',
    'a good url beside a good id',
    {
      folder: { url: 'https://x.example', id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
    {
      folder: { url: 'https://x.example' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
  ],
  [
    'linkDriveFolder',
    'a url with no scheme',
    {
      folder: { url: 'drive.google.com/x' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
    REFUSED,
  ],
  [
    'linkDriveFolder',
    'a folder id with a space',
    {
      folder: { id: 'a b' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
    REFUSED,
  ],
  [
    'linkDriveFolder',
    'a protocol-relative return',
    {
      folder: { id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: '//evil.example',
    },
    REFUSED,
  ],
  [
    'linkDriveFolder',
    'an absolute return',
    {
      folder: { id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'pull',
        sensitivity: 'inherit',
      },
      returnTo: 'https://evil.example/',
    },
    REFUSED,
  ],
  [
    'linkDriveFolder',
    'a bad direction',
    {
      folder: { id: 'abc' },
      attachTo: ID,
      options: {
        mapSubfolders: true,
        retain: 'full',
        direction: 'sideways',
        sensitivity: 'inherit',
      },
      returnTo: '/',
    },
    REFUSED,
  ],
  [
    'linkFolderStatus',
    'ten ids',
    { bindIds: Array.from({ length: 10 }, () => ID) },
    { bindIds: Array.from({ length: 10 }, () => ID) },
  ],
  [
    'linkFolderStatus',
    'eleven ids',
    { bindIds: Array.from({ length: 11 }, () => ID) },
    REFUSED,
  ],
  ['listRecordBindings', 'an id', { entityId: ID }, { entityId: ID }],
  ['unlinkDriveFolder', 'a bad id', { bindingId: 'x' }, REFUSED],
  [
    'setBindingRetain',
    'text',
    { bindingId: ID, retain: 'text' },
    { bindingId: ID, retain: 'text' },
  ],
  [
    'setBindingRetain',
    'a bad retain',
    { bindingId: ID, retain: 'some' },
    REFUSED,
  ],
  ['getAccountBindings', 'an id', { connectionId: ID }, { connectionId: ID }],
  [
    'rebindFolder',
    'a commit',
    { bindingId: ID, connectionId: ID2, commit: true },
    { bindingId: ID, connectionId: ID2, commit: true },
  ],
  ['rebindFolder', 'no commit', { bindingId: ID, connectionId: ID2 }, REFUSED],
  ['rebindStatus', 'none', { checkIds: [] }, { checkIds: [] }],
])

table('connections', [
  ['getProviderPage', 'google', { provider: 'google' }, { provider: 'google' }],
  ['getProviderPage', 'an unknown provider', { provider: 'dropbox' }, REFUSED],
  [
    'setProviderChoice',
    'an audience',
    { provider: 'google', audience: 'workspace' },
    { provider: 'google', audience: 'workspace' },
  ],
  [
    'setProviderChoice',
    'a consent',
    { provider: 'google', consent: 'external' },
    { provider: 'google', consent: 'external' },
  ],
  [
    'setProviderChoice',
    'neither',
    { provider: 'google' },
    { provider: 'google' },
  ],
  [
    'setProviderChoice',
    'box',
    { provider: 'box', audience: 'workspace' },
    REFUSED,
  ],
  [
    'setProviderChoice',
    'a bad audience',
    { provider: 'google', audience: 'team' },
    REFUSED,
  ],
  [
    'setProviderApp',
    'padded fields',
    { provider: 'box', clientId: '  abc.apps  ', clientSecret: '  s3cret ' },
    { provider: 'box', clientId: 'abc.apps', clientSecret: 's3cret' },
  ],
  [
    'setProviderApp',
    'a blank secret keeps the stored one',
    { provider: 'google', clientId: 'abc', clientSecret: '   ' },
    { provider: 'google', clientId: 'abc', clientSecret: '' },
  ],
  [
    'setProviderApp',
    'a blank client id',
    { provider: 'google', clientId: '  ', clientSecret: '' },
    REFUSED,
  ],
  [
    'setProviderApp',
    'a long client id',
    { provider: 'google', clientId: 'a'.repeat(513), clientSecret: '' },
    REFUSED,
  ],
  [
    'setProviderApp',
    'no secret',
    { provider: 'google', clientId: 'abc' },
    REFUSED,
  ],
  ['disconnectConnection', 'an id', { connectionId: ID }, { connectionId: ID }],
  ['getMailboxSync', 'a bad id', { connectionId: 'x' }, REFUSED],
  [
    'saveMailboxSync',
    'padded entries',
    {
      connectionId: ID,
      shareBodies: true,
      excludeSenders: [' noreply@x.example '],
      excludeLabels: [' Promotions'],
    },
    {
      connectionId: ID,
      shareBodies: true,
      excludeSenders: ['noreply@x.example'],
      excludeLabels: ['Promotions'],
    },
  ],
  [
    'saveMailboxSync',
    'a blank entry',
    {
      connectionId: ID,
      shareBodies: false,
      excludeSenders: ['  '],
      excludeLabels: [],
    },
    REFUSED,
  ],
  [
    'saveMailboxSync',
    'too many labels',
    {
      connectionId: ID,
      shareBodies: false,
      excludeSenders: [],
      excludeLabels: Array.from({ length: 201 }, () => 'a'),
    },
    REFUSED,
  ],
  [
    'connectRecorderKey',
    'a padded key',
    { provider: 'granola', key: '  gr_123 ' },
    { provider: 'granola', key: 'gr_123' },
  ],
  [
    'connectRecorderKey',
    'a blank key',
    { provider: 'granola', key: ' ' },
    REFUSED,
  ],
  [
    'connectRecorderKey',
    'an unknown provider',
    { provider: 'otter', key: 'k' },
    REFUSED,
  ],
  [
    'saveRecorderSettings',
    'padded folders',
    {
      connectionId: ID,
      folderIds: [' f1 '],
      typedNotes: true,
      transcript: false,
    },
    {
      connectionId: ID,
      folderIds: ['f1'],
      typedNotes: true,
      transcript: false,
    },
  ],
  [
    'saveRecorderSettings',
    'a blank folder',
    { connectionId: ID, folderIds: [''], typedNotes: true, transcript: false },
    REFUSED,
  ],
])

table('documentPreview', [
  ['getDocumentPreview', 'an id', { id: ID }, { id: ID }],
  ['getDocumentDetails', 'a number', { id: 7 }, REFUSED],
  [
    'getDocumentBytes',
    'a poll',
    { id: ID, poll: false },
    { id: ID, poll: false },
  ],
  ['getDocumentBytes', 'a string poll', { id: ID, poll: 'false' }, REFUSED],
])

table('enrichment', [
  ['saveEnrichmentOrder', 'ids', { ids: [ID, ID2] }, { ids: [ID, ID2] }],
  [
    'saveEnrichmentOrder',
    'fifty-one ids',
    { ids: Array.from({ length: 51 }, () => ID) },
    REFUSED,
  ],
  [
    'saveEnrichmentAuto',
    'scopes',
    { scopes: ['deal', 'meeting'], spaces: [ID] },
    { scopes: ['deal', 'meeting'], spaces: [ID] },
  ],
  [
    'saveEnrichmentAuto',
    'a bad scope',
    { scopes: ['company'], spaces: [] },
    REFUSED,
  ],
  [
    'saveEnrichmentAuto',
    'four scopes',
    { scopes: ['deal', 'deal', 'deal', 'deal'], spaces: [] },
    REFUSED,
  ],
  ['saveEnrichmentReuse', 'zero days', { days: 0 }, { days: 0 }],
  ['saveEnrichmentReuse', 'ten years', { days: 3650 }, { days: 3650 }],
  ['saveEnrichmentReuse', 'over ten years', { days: 3651 }, REFUSED],
  ['saveEnrichmentReuse', 'a fraction', { days: 1.5 }, REFUSED],
  ['saveEnrichmentReuse', 'a negative', { days: -1 }, REFUSED],
  ['saveEnrichmentReuse', 'a string', { days: '5' }, REFUSED],
  ['saveEnrichmentReuse', 'NaN', { days: Number.NaN }, REFUSED],
  [
    'getRecordEnrichment',
    'a person',
    { entityId: ID, kind: 'person' },
    { entityId: ID, kind: 'person' },
  ],
  ['getRecordEnrichment', 'a deal', { entityId: ID, kind: 'deal' }, REFUSED],
])

table('follow', [
  [
    'followDocument',
    'both ids',
    { documentId: ID, recordId: ID2 },
    { documentId: ID, recordId: ID2 },
  ],
  ['followDocument', 'no record', { documentId: ID }, REFUSED],
  ['unfollowDocument', 'an id', { documentId: ID }, { documentId: ID }],
  ['listDocumentRevisions', 'a bad id', { documentId: '' }, REFUSED],
])

table('identity', [
  [
    'findByIdentity',
    'a padded domain',
    { key: 'domain', value: '  acme.com ' },
    { key: 'domain', value: 'acme.com' },
  ],
  ['findByIdentity', 'a blank value', { key: 'email', value: '   ' }, REFUSED],
  ['findByIdentity', 'a phone', { key: 'phone', value: '1' }, REFUSED],
  [
    'findByIdentity',
    '255 after the trim',
    { key: 'linkedin', value: ` ${'a'.repeat(255)} ` },
    { key: 'linkedin', value: 'a'.repeat(255) },
  ],
  [
    'findByIdentity',
    '256',
    { key: 'linkedin', value: 'a'.repeat(256) },
    REFUSED,
  ],
])

table('integrations', [
  ['getIntegration', 'an id', { id: ID }, { id: ID }],
  ['getIntegrationRuns', 'a bad id', { id: 'x' }, REFUSED],
  [
    'setIntegrationEnabled',
    'on',
    { id: ID, enabled: true },
    { id: ID, enabled: true },
  ],
  ['resetIntegration', 'an id', { id: ID }, { id: ID }],
  [
    'saveIntegrationSettings',
    'strings and flags',
    { id: ID, values: { a: 'x', b: true } },
    { id: ID, values: { a: 'x', b: true } },
  ],
  [
    'saveIntegrationSettings',
    'no values',
    { id: ID, values: {} },
    { id: ID, values: {} },
  ],
  [
    'saveIntegrationSettings',
    'a number',
    { id: ID, values: { a: 1 } },
    REFUSED,
  ],
  [
    'saveIntegrationSettings',
    'a null',
    { id: ID, values: { a: null } },
    REFUSED,
  ],
  ['saveIntegrationSettings', 'a list', { id: ID, values: ['x'] }, REFUSED],
  [
    'saveIntegrationSettings',
    'a date',
    { id: ID, values: new Date(0) },
    REFUSED,
  ],
  [
    'saveIntegrationSettings',
    'a map',
    { id: ID, values: new Map([['a', 'x']]) },
    REFUSED,
  ],
  [
    'saveIntegrationSettings',
    'a __proto__ key',
    { id: ID, values: JSON.parse('{"__proto__":"x","a":"y"}') },
    { id: ID, values: { a: 'y' } },
  ],
  [
    'saveIntegrationSettings',
    'no prototype',
    { id: ID, values: Object.assign(Object.create(null), { a: 'x' }) },
    { id: ID, values: { a: 'x' } },
  ],
  [
    'saveIntegrationAutoEnrich',
    'scopes',
    { id: ID, scopes: ['space'], spaces: [ID2] },
    { id: ID, scopes: ['space'], spaces: [ID2] },
  ],
  [
    'saveIntegrationAutoEnrich',
    'a bad space',
    { id: ID, scopes: [], spaces: ['x'] },
    REFUSED,
  ],
  [
    'saveIntegrationSecret',
    'a key',
    { id: ID, slot: 'credential', secret: ' sk-1 ' },
    { id: ID, slot: 'credential', secret: ' sk-1 ' },
  ],
  [
    'saveIntegrationSecret',
    'an empty key',
    { id: ID, slot: 'webhook', secret: '' },
    REFUSED,
  ],
  [
    'saveIntegrationSecret',
    'a bad slot',
    { id: ID, slot: 'token', secret: 'x' },
    REFUSED,
  ],
  [
    'installIntegration',
    'a plugin',
    { pluginId: 'gmail' },
    { pluginId: 'gmail' },
  ],
  ['installIntegration', 'an empty plugin', { pluginId: '' }, REFUSED],
  [
    'installIntegration',
    'a long plugin',
    { pluginId: 'a'.repeat(65) },
    REFUSED,
  ],
  ['updateIntegration', 'an id', { id: ID }, { id: ID }],
  [
    'uninstallIntegration',
    'drop',
    { id: ID, dropData: false },
    { id: ID, dropData: false },
  ],
  ['uninstallIntegration', 'no drop', { id: ID }, REFUSED],
  [
    'removeIntegrationSecret',
    'a slot',
    { id: ID, slot: 'webhook' },
    { id: ID, slot: 'webhook' },
  ],
])

table('keyTerms', [
  ['extractKeyTerms', 'an id', { documentId: ID }, { documentId: ID }],
  ['keyTermsStatus', 'none', { documentIds: [] }, { documentIds: [] }],
  [
    'keyTermsStatus',
    'two hundred and one',
    { documentIds: Array.from({ length: 201 }, () => ID) },
    REFUSED,
  ],
])

const mailbox = {
  address: '  Partner@Fund.Example ',
  host: ' imap.fastmail.com ',
  port: 993,
  useTls: true,
  folder: ' INBOX ',
  cadenceMinutes: 5,
}
const saved = {
  address: 'partner@fund.example',
  host: 'imap.fastmail.com',
  port: 993,
  useTls: true,
  folder: 'INBOX',
  cadenceMinutes: 5,
}

table('mailbox', [
  ['saveMailbox', 'padded fields, no password', mailbox, saved],
  [
    'saveMailbox',
    'a password',
    { ...mailbox, password: ' pw ' },
    { ...saved, password: ' pw ' },
  ],
  ['saveMailbox', 'an empty password', { ...mailbox, password: '' }, REFUSED],
  ['testMailbox', 'not an address', { ...mailbox, address: 'anish' }, REFUSED],
  [
    'testMailbox',
    'a dotted local part',
    { ...mailbox, address: 'a..b@x.example' },
    REFUSED,
  ],
  [
    'testMailbox',
    'a host with a slash',
    { ...mailbox, host: 'imap/x' },
    REFUSED,
  ],
  ['testMailbox', 'a blank host', { ...mailbox, host: '  ' }, REFUSED],
  ['testMailbox', 'port zero', { ...mailbox, port: 0 }, REFUSED],
  ['testMailbox', 'port 65536', { ...mailbox, port: 65536 }, REFUSED],
  ['testMailbox', 'a fractional port', { ...mailbox, port: 993.5 }, REFUSED],
  [
    'testMailbox',
    'an hourly cadence',
    { ...mailbox, cadenceMinutes: 60 },
    { ...saved, cadenceMinutes: 60 },
  ],
  [
    'testMailbox',
    'a slower cadence',
    { ...mailbox, cadenceMinutes: 61 },
    REFUSED,
  ],
  ['testMailbox', 'no folder', { ...mailbox, folder: '' }, REFUSED],
])

table('meetings', [
  [
    'listDayMeetings',
    'instants',
    { from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00.000Z' },
    { from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00.000Z' },
  ],
  [
    'listDayMeetings',
    'minutes only',
    { from: '2026-11-19T10:00Z', to: '2026-11-19T11:00Z' },
    { from: '2026-11-19T10:00Z', to: '2026-11-19T11:00Z' },
  ],
  [
    'listDayMeetings',
    'an offset',
    { from: '2026-11-19T10:00:00+01:00', to: '2026-11-19T11:00:00Z' },
    REFUSED,
  ],
  [
    'listDayMeetings',
    'a local time',
    { from: '2026-11-19T10:00:00', to: '2026-11-19T11:00:00Z' },
    REFUSED,
  ],
  [
    'listDayMeetings',
    'a day',
    { from: '2026-11-19', to: '2026-11-19T11:00:00Z' },
    REFUSED,
  ],
  [
    'listDayMeetings',
    'no such day',
    { from: '2026-02-30T10:00:00Z', to: '2026-11-19T11:00:00Z' },
    REFUSED,
  ],
  [
    'listDayMeetings',
    'a leap day',
    { from: '2028-02-29T10:00:00Z', to: '2028-03-01T00:00:00Z' },
    { from: '2028-02-29T10:00:00Z', to: '2028-03-01T00:00:00Z' },
  ],
  [
    'listDayMeetings',
    'hour 24',
    { from: '2026-11-19T24:00:00Z', to: '2026-11-19T11:00:00Z' },
    REFUSED,
  ],
  [
    'listMeetings',
    'instants',
    { now: '2026-11-19T09:30:15.5Z', until: '2026-12-19T00:00:00Z' },
    { now: '2026-11-19T09:30:15.5Z', until: '2026-12-19T00:00:00Z' },
  ],
  ['getMeeting', 'an id', { id: ID }, { id: ID }],
  [
    'pinMeetingRecord',
    'ids',
    { interactionId: ID, entityId: ID2 },
    { interactionId: ID, entityId: ID2 },
  ],
  ['prepMeeting', 'a bad id', { interactionId: 'x' }, REFUSED],
  [
    'savePrepAsNote',
    'padded markdown',
    { interactionId: ID, markdown: '\n# Brief\n ' },
    { interactionId: ID, markdown: '# Brief' },
  ],
  [
    'savePrepAsNote',
    'blank markdown',
    { interactionId: ID, markdown: ' \n ' },
    REFUSED,
  ],
])

table('objects', [
  ['listObjects', 'nothing', undefined, undefined],
  ['listObjects', 'an empty object', {}, {}],
  [
    'listObjects',
    'archived',
    { includeArchived: true },
    { includeArchived: true },
  ],
  ['listObjects', 'null', null, REFUSED],
  ['getObject', 'a slug', { slug: 'funds' }, { slug: 'funds' }],
  ['getObject', 'an empty slug', { slug: '' }, REFUSED],
  [
    'createObject',
    'padded names',
    {
      singular: ' Fund ',
      plural: ' Funds ',
      icon: 'landmark',
      identityKeys: ['domain'],
    },
    {
      singular: 'Fund',
      plural: 'Funds',
      icon: 'landmark',
      identityKeys: ['domain'],
    },
  ],
  [
    'createObject',
    'names alone',
    { singular: 'Fund', plural: 'Funds' },
    { singular: 'Fund', plural: 'Funds' },
  ],
  [
    'createObject',
    'a blank plural',
    { singular: 'Fund', plural: '  ' },
    REFUSED,
  ],
  [
    'createObject',
    'five keys',
    {
      singular: 'Fund',
      plural: 'Funds',
      identityKeys: ['a', 'b', 'c', 'd', 'e'],
    },
    REFUSED,
  ],
  [
    'createObject',
    'a null icon',
    { singular: 'Fund', plural: 'Funds', icon: null },
    REFUSED,
  ],
  ['updateObject', 'an id alone', { id: ID }, { id: ID }],
  [
    'updateObject',
    'a null icon',
    { id: ID, icon: null },
    { id: ID, icon: null },
  ],
  [
    'updateObject',
    'a padded singular',
    { id: ID, singular: ' Fund ', archived: true },
    { id: ID, singular: 'Fund', archived: true },
  ],
  ['updateObject', 'a blank singular', { id: ID, singular: ' ' }, REFUSED],
  ['getObjectRecord', 'an id', { id: ID }, { id: ID }],
  [
    'createObjectRecord',
    'a padded name',
    { objectId: ID, name: '  Sequoia ' },
    { objectId: ID, name: 'Sequoia' },
  ],
  [
    'createObjectRecord',
    'values',
    {
      objectId: ID,
      name: 'Sequoia',
      values: { aum: 1, tags: ['a'], at: null },
    },
    {
      objectId: ID,
      name: 'Sequoia',
      values: { aum: 1, tags: ['a'], at: null },
    },
  ],
  [
    'createObjectRecord',
    'a list of values',
    { objectId: ID, name: 'Sequoia', values: [1] },
    REFUSED,
  ],
  [
    'createObjectRecord',
    'a date for values',
    { objectId: ID, name: 'Sequoia', values: new Date(0) },
    REFUSED,
  ],
  [
    'createObjectRecord',
    'a __proto__ value',
    {
      objectId: ID,
      name: 'Sequoia',
      values: JSON.parse('{"__proto__":{"x":1},"a":2}'),
    },
    { objectId: ID, name: 'Sequoia', values: { a: 2 } },
  ],
  ['createObjectRecord', 'a blank name', { objectId: ID, name: ' ' }, REFUSED],
])

table('pictures', [
  [
    'setRecordPicture',
    'a picture',
    form({ entityId: ID, file: picture }),
    { entityId: ID, file: picture },
  ],
  [
    'setRecordPicture',
    'a bad id',
    form({ entityId: 'x', file: picture }),
    REFUSED,
  ],
  ['setRecordPicture', 'no id', form({ file: picture }), REFUSED],
  ['setRecordPicture', 'no file', form({ entityId: ID }), REFUSED],
  ['clearRecordPicture', 'an id', { entityId: ID }, { entityId: ID }],
  ['clearRecordPicture', 'a bad id', { entityId: 'x' }, REFUSED],
])

table('plugins', [
  ['listRecordActions', 'a deal', { kind: 'deal' }, { kind: 'deal' }],
  ['listRecordActions', 'a space', { kind: 'space' }, REFUSED],
  [
    'fireRecordAction',
    'an action',
    { integrationId: ID, actionId: 'enrich', entityId: ID2 },
    { integrationId: ID, actionId: 'enrich', entityId: ID2 },
  ],
  [
    'fireRecordAction',
    'no action',
    { integrationId: ID, actionId: '', entityId: ID2 },
    REFUSED,
  ],
])

table('readDeck', [
  ['readDeck', 'an id', { documentId: ID }, { documentId: ID }],
  [
    'readDeckAndSummarize',
    'ids',
    { documentId: ID, recordId: ID2 },
    { documentId: ID, recordId: ID2 },
  ],
  ['readDeckStatus', 'a bad id', { documentIds: ['x'] }, REFUSED],
])

table('sensitivity', [
  ['getEntitySensitivity', 'an id', { entityId: ID }, { entityId: ID }],
  [
    'setEntitySensitive',
    'on',
    { entityId: ID, sensitive: true },
    { entityId: ID, sensitive: true },
  ],
  ['setEntitySensitive', 'no flag', { entityId: ID }, REFUSED],
])

table('spaces', [
  ['getSpace', 'an id', { id: ID }, { id: ID }],
  ['createSpace', 'a padded name', { name: '  Climate ' }, { name: 'Climate' }],
  [
    'createSpace',
    'a parent',
    { name: 'Grid', parentId: ID },
    { name: 'Grid', parentId: ID },
  ],
  ['createSpace', 'a null parent', { name: 'Grid', parentId: null }, REFUSED],
  ['createSpace', 'a blank name', { name: '  ' }, REFUSED],
  ['createSpace', 'a long name', { name: 'a'.repeat(121) }, REFUSED],
  [
    'renameSpace',
    'a padded name',
    { id: ID, name: ' Grid ' },
    { id: ID, name: 'Grid' },
  ],
  [
    'setSpaceCriteria',
    'padded criteria',
    { id: ID, criteria: '  B2B  ' },
    { id: ID, criteria: '  B2B  ' },
  ],
  [
    'setSpaceCriteria',
    'blank criteria',
    { id: ID, criteria: '' },
    { id: ID, criteria: '' },
  ],
  [
    'setSpaceCriteria',
    'long criteria',
    { id: ID, criteria: 'a'.repeat(1001) },
    REFUSED,
  ],
  ['archiveSpace', 'an id', { id: ID }, { id: ID }],
  ['restoreSpace', 'a bad id', { id: 'x' }, REFUSED],
  [
    'moveSpace',
    'to the top',
    { id: ID, parentId: null },
    { id: ID, parentId: null },
  ],
  [
    'moveSpace',
    'under a parent',
    { id: ID, parentId: ID2 },
    { id: ID, parentId: ID2 },
  ],
  ['moveSpace', 'no parent key', { id: ID }, REFUSED],
  ['runWatchNow', 'an id', { watchId: ID }, { watchId: ID }],
  ['getSpaceWatching', 'an id', { spaceId: ID }, { spaceId: ID }],
  [
    'addSpaceWatch',
    'a watch',
    {
      spaceId: ID,
      integrationId: ID2,
      values: { query: 'grid', strict: false },
      cadenceMinutes: 60,
    },
    {
      spaceId: ID,
      integrationId: ID2,
      values: { query: 'grid', strict: false },
      cadenceMinutes: 60,
    },
  ],
  [
    'addSpaceWatch',
    'a manual watch',
    { spaceId: ID, integrationId: ID2, values: {}, cadenceMinutes: null },
    { spaceId: ID, integrationId: ID2, values: {}, cadenceMinutes: null },
  ],
  [
    'addSpaceWatch',
    'a zero cadence',
    { spaceId: ID, integrationId: ID2, values: {}, cadenceMinutes: 0 },
    REFUSED,
  ],
  [
    'addSpaceWatch',
    'a fractional cadence',
    { spaceId: ID, integrationId: ID2, values: {}, cadenceMinutes: 1.5 },
    REFUSED,
  ],
  [
    'addSpaceWatch',
    'a numeric value',
    { spaceId: ID, integrationId: ID2, values: { n: 3 }, cadenceMinutes: null },
    REFUSED,
  ],
  [
    'addSpaceWatch',
    'a list for values',
    { spaceId: ID, integrationId: ID2, values: [], cadenceMinutes: null },
    REFUSED,
  ],
  [
    'addSpaceWatch',
    'a __proto__ value',
    {
      spaceId: ID,
      integrationId: ID2,
      values: JSON.parse('{"__proto__":"x","q":"y"}'),
      cadenceMinutes: null,
    },
    {
      spaceId: ID,
      integrationId: ID2,
      values: { q: 'y' },
      cadenceMinutes: null,
    },
  ],
  [
    'moveIntoSubspace',
    'one record',
    { fromSpaceId: ID, toSpaceId: ID2, entityIds: [ID] },
    { fromSpaceId: ID, toSpaceId: ID2, entityIds: [ID] },
  ],
  [
    'moveIntoSubspace',
    'no records',
    { fromSpaceId: ID, toSpaceId: ID2, entityIds: [] },
    REFUSED,
  ],
  [
    'moveIntoSubspace',
    'too many records',
    {
      fromSpaceId: ID,
      toSpaceId: ID2,
      entityIds: Array.from({ length: 501 }, () => ID),
    },
    REFUSED,
  ],
])

table('storage', [
  [
    'attachFromLink',
    'a padded url',
    { url: ' https://docs.google.com/d/1 ', attachTo: ID, returnTo: '/files' },
    { url: 'https://docs.google.com/d/1', attachTo: ID, returnTo: '/files' },
  ],
  [
    'attachFromLink',
    'a mailto link',
    { url: 'mailto:a@b.example', attachTo: ID, returnTo: '/files' },
    { url: 'mailto:a@b.example', attachTo: ID, returnTo: '/files' },
  ],
  [
    'attachFromLink',
    'not a url',
    { url: 'docs', attachTo: ID, returnTo: '/files' },
    REFUSED,
  ],
  [
    'attachFromLink',
    'a long url',
    {
      url: `https://x.example/${'a'.repeat(2000)}`,
      attachTo: ID,
      returnTo: '/files',
    },
    REFUSED,
  ],
  [
    'attachFromLink',
    'a long return path',
    { url: 'https://x.example', attachTo: ID, returnTo: `/${'a'.repeat(500)}` },
    REFUSED,
  ],
  [
    'attachFromPicker',
    'one file',
    {
      provider: 'google',
      attachTo: ID,
      files: [{ id: 'f_1-a', name: ' Deck.pdf ' }],
      returnTo: '/',
    },
    {
      provider: 'google',
      attachTo: ID,
      files: [{ id: 'f_1-a', name: ' Deck.pdf ' }],
      returnTo: '/',
    },
  ],
  [
    'attachFromPicker',
    'no files',
    { provider: 'google', attachTo: ID, files: [], returnTo: '/' },
    REFUSED,
  ],
  [
    'attachFromPicker',
    'a bad file id',
    {
      provider: 'google',
      attachTo: ID,
      files: [{ id: 'f/1', name: 'x' }],
      returnTo: '/',
    },
    REFUSED,
  ],
  [
    'attachFromPicker',
    'fifty-one files',
    {
      provider: 'google',
      attachTo: ID,
      files: Array.from({ length: 51 }, () => ({ id: 'f', name: 'x' })),
      returnTo: '/',
    },
    REFUSED,
  ],
  [
    'pickerReadiness',
    'google',
    { provider: 'google', returnTo: '/files' },
    { provider: 'google', returnTo: '/files' },
  ],
  ['pickerReadiness', 'box', { provider: 'box', returnTo: '/files' }, REFUSED],
  [
    'mintPickerToken',
    'no mode',
    { provider: 'google', returnTo: '/' },
    { provider: 'google', returnTo: '/', mode: 'files' },
  ],
  [
    'mintPickerToken',
    'an undefined mode',
    { provider: 'google', returnTo: '/', mode: undefined },
    { provider: 'google', returnTo: '/', mode: 'files' },
  ],
  [
    'mintPickerToken',
    'folders',
    { provider: 'google', returnTo: '/', mode: 'folders' },
    { provider: 'google', returnTo: '/', mode: 'folders' },
  ],
  [
    'mintPickerToken',
    'a null mode',
    { provider: 'google', returnTo: '/', mode: null },
    REFUSED,
  ],
  [
    'mintPickerToken',
    'a bad mode',
    { provider: 'google', returnTo: '/', mode: 'drives' },
    REFUSED,
  ],
  ['linkFetchStatus', 'ids', { fetchIds: [ID] }, { fetchIds: [ID] }],
  [
    'linkFetchStatus',
    'fifty-one ids',
    { fetchIds: Array.from({ length: 51 }, () => ID) },
    REFUSED,
  ],
])

table('suggestions', [
  ['listOpenSuggestionTitles', 'an id', { entityId: ID }, { entityId: ID }],
  ['acceptSuggestion', 'an id', { id: ID }, { id: ID }],
  ['acceptSuggestionsForRecord', 'a bad id', { entityId: 'x' }, REFUSED],
  [
    'acceptSuggestionColumn',
    'a slug',
    { attributeSlug: 'stage' },
    { attributeSlug: 'stage' },
  ],
  [
    'acceptSuggestionColumn',
    'a run',
    { attributeSlug: 'stage', runId: ID },
    { attributeSlug: 'stage', runId: ID },
  ],
  ['acceptSuggestionColumn', 'an empty slug', { attributeSlug: '' }, REFUSED],
  [
    'acceptSuggestionColumn',
    'a null run',
    { attributeSlug: 'stage', runId: null },
    REFUSED,
  ],
  ['rejectSuggestion', 'an id', { id: ID }, { id: ID }],
])

table('summarize', [
  [
    'summarize',
    'the record',
    { recordId: ID, documentId: null },
    { recordId: ID, documentId: null },
  ],
  [
    'summarize',
    'a document',
    { recordId: ID, documentId: ID2 },
    { recordId: ID, documentId: ID2 },
  ],
  ['summarize', 'no document key', { recordId: ID }, REFUSED],
  [
    'summarizeStatus',
    'sources',
    { recordId: ID, sourceIds: [ID2] },
    { recordId: ID, sourceIds: [ID2] },
  ],
  [
    'summarizeStatus',
    'too many sources',
    { recordId: ID, sourceIds: Array.from({ length: 201 }, () => ID) },
    REFUSED,
  ],
])

table('timeline', [
  ['getRecordTimeline', 'an id', { entityId: ID }, { entityId: ID }],
  ['getRecordTimeline', 'a bad id', { entityId: 'x' }, REFUSED],
])

table('tokens', [
  [
    'createApiToken',
    'a token',
    { name: 'Zapier', scopes: ['records:read'] },
    { name: 'Zapier', scopes: ['records:read'] },
  ],
  [
    'createApiToken',
    'no name, no scopes',
    { name: '', scopes: [] },
    { name: '', scopes: [] },
  ],
  ['createApiToken', 'a bad scope', { name: 'x', scopes: ['admin'] }, REFUSED],
  [
    'createApiToken',
    'four scopes',
    {
      name: 'x',
      scopes: ['records:read', 'records:read', 'records:read', 'records:read'],
    },
    REFUSED,
  ],
  [
    'createApiToken',
    'a long name',
    { name: 'a'.repeat(201), scopes: [] },
    REFUSED,
  ],
  ['revokeApiToken', 'an id', { id: ID }, { id: ID }],
])

table('versions', [
  [
    'markNewerVersion',
    'ids',
    { newerId: ID, olderId: ID2 },
    { newerId: ID, olderId: ID2 },
  ],
  ['markNewerVersion', 'one id', { newerId: ID }, REFUSED],
  ['saveNoteAsNewVersion', 'an id', { id: ID }, { id: ID }],
])

table('vision', [
  ['readWithVision', 'an id', { documentId: ID }, { documentId: ID }],
  ['visionStatus', 'ids', { documentIds: [ID] }, { documentIds: [ID] }],
  ['visionStatus', 'not a list', { documentIds: ID }, REFUSED],
])
