import type * as Start from '@tanstack/react-start'
import { describe, expect, it, vi } from 'vitest'
import { REFUSED, verdict } from '#/test/server-fn-validators'

vi.mock('@tanstack/react-start', async (actual) =>
  (await import('#/test/server-fn-validators')).capturingStart(
    await actual<typeof Start>(),
  ),
)

/**
 * The AI settings, AI attribute, space-suggestion and Ask server fns at
 * their input edges, through each fn's own validator: what the handler
 * receives, or `REFUSED`. Every row was held against the zod shapes before
 * they were Effect schemas, so a row that moves is a caller who sees a
 * different answer.
 */

const ID = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const ID2 = '7f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'

const modules = {
  aiSettings: () => import('./ai-settings'),
  attributeAi: () => import('./attribute-ai'),
  suggestSpaces: () => import('./suggest-spaces'),
  ask: () => import('./ask'),
}

type Row = readonly [fn: string, label: string, input: unknown, out: unknown]

const table = (name: keyof typeof modules, rows: ReadonlyArray<Row>) =>
  describe(name, () => {
    it.each(rows)('%s: %s', async (fn, _, value, out) => {
      const mod: object = await modules[name]()
      expect(await verdict(Reflect.get(mod, fn), value)).toEqual(out)
    })
  })

table('aiSettings', [
  [
    'saveAiKey',
    'a key, trimmed, the rest defaulted',
    { provider: 'openai', key: '  sk-abc  ' },
    { provider: 'openai', key: 'sk-abc', baseUrl: '', headers: '' },
  ],
  [
    'saveAiKey',
    'no key at all',
    { provider: 'ollama' },
    { provider: 'ollama', baseUrl: '', headers: '' },
  ],
  [
    'saveAiKey',
    'an empty key',
    { provider: 'anthropic', key: '   ' },
    { provider: 'anthropic', key: '', baseUrl: '', headers: '' },
  ],
  [
    'saveAiKey',
    'a key of 4000 once trimmed',
    { provider: 'openai', key: ` ${'k'.repeat(4000)} ` },
    { provider: 'openai', key: 'k'.repeat(4000), baseUrl: '', headers: '' },
  ],
  [
    'saveAiKey',
    'a key of 4001',
    { provider: 'openai', key: 'k'.repeat(4001) },
    REFUSED,
  ],
  [
    'saveAiKey',
    'a base URL, trimmed',
    { provider: 'openai', baseUrl: '  https://gw.example/v1  ' },
    { provider: 'openai', baseUrl: 'https://gw.example/v1', headers: '' },
  ],
  [
    'saveAiKey',
    'an empty base URL',
    { provider: 'openai', baseUrl: '' },
    { provider: 'openai', baseUrl: '', headers: '' },
  ],
  [
    'saveAiKey',
    'a blank base URL',
    { provider: 'openai', baseUrl: '   ' },
    REFUSED,
  ],
  [
    'saveAiKey',
    'a base URL in another scheme',
    { provider: 'ollama', baseUrl: 'ftp://box:11434' },
    { provider: 'ollama', baseUrl: 'ftp://box:11434', headers: '' },
  ],
  [
    'saveAiKey',
    'a base URL that is not one',
    { provider: 'openai', baseUrl: 'gw.example' },
    REFUSED,
  ],
  [
    'saveAiKey',
    'a null base URL',
    { provider: 'openai', baseUrl: null },
    REFUSED,
  ],
  [
    'saveAiKey',
    'header lines, untrimmed',
    { provider: 'openai', headers: ' X-A: 1\nX-B: 2 ' },
    { provider: 'openai', baseUrl: '', headers: ' X-A: 1\nX-B: 2 ' },
  ],
  [
    'saveAiKey',
    'headers of 4001',
    { provider: 'openai', headers: 'h'.repeat(4001) },
    REFUSED,
  ],
  [
    'saveAiKey',
    'an unknown provider',
    { provider: 'mistral', key: 'x' },
    REFUSED,
  ],
  [
    'saveAiKey',
    'a stray key',
    { provider: 'openai', role: 'admin' },
    { provider: 'openai', baseUrl: '', headers: '' },
  ],
  [
    'testAiProvider',
    'a provider',
    { provider: 'google' },
    { provider: 'google' },
  ],
  ['testAiProvider', 'nothing', undefined, REFUSED],
  [
    'setAiRoute',
    'a route, model trimmed',
    {
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'openai',
      model: '  gpt-x  ',
    },
    {
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'openai',
      model: 'gpt-x',
    },
  ],
  [
    'setAiRoute',
    'a cleared route',
    { lane: 'vision', sensitivity: 'sensitive', provider: null },
    { lane: 'vision', sensitivity: 'sensitive', provider: null },
  ],
  [
    'setAiRoute',
    'a cleared route with a model, dropped',
    { lane: 'vision', sensitivity: 'sensitive', provider: null, model: 'm' },
    { lane: 'vision', sensitivity: 'sensitive', provider: null },
  ],
  [
    'setAiRoute',
    'a blank model',
    { lane: 'extract', sensitivity: 'normal', provider: 'openai', model: '  ' },
    REFUSED,
  ],
  [
    'setAiRoute',
    'a model of 201',
    {
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'openai',
      model: 'm'.repeat(201),
    },
    REFUSED,
  ],
  [
    'setAiRoute',
    'no model',
    { lane: 'extract', sensitivity: 'normal', provider: 'openai' },
    REFUSED,
  ],
  [
    'setAiRoute',
    'an unknown lane',
    { lane: 'chat', sensitivity: 'normal', provider: null },
    REFUSED,
  ],
  [
    'setAiRoute',
    'no provider',
    { lane: 'extract', sensitivity: 'normal' },
    REFUSED,
  ],
  ['isLaneRouted', 'a lane', { lane: 'embed' }, { lane: 'embed' }],
  ['isLaneRouted', 'an unknown lane', { lane: 'chat' }, REFUSED],
  [
    'setSensitivityDefault',
    'a sensitivity',
    { sensitivity: 'sensitive' },
    { sensitivity: 'sensitive' },
  ],
  [
    'setSensitivityDefault',
    'an unknown sensitivity',
    { sensitivity: 'secret' },
    REFUSED,
  ],
  [
    'setAiCaps',
    'two ceilings',
    { dailyTokens: 1000, perRunTokens: 1 },
    { dailyTokens: 1000, perRunTokens: 1 },
  ],
  [
    'setAiCaps',
    'no caps',
    { dailyTokens: null, perRunTokens: null },
    { dailyTokens: null, perRunTokens: null },
  ],
  [
    'setAiCaps',
    'the largest safe ceiling',
    { dailyTokens: Number.MAX_SAFE_INTEGER, perRunTokens: null },
    { dailyTokens: Number.MAX_SAFE_INTEGER, perRunTokens: null },
  ],
  [
    'setAiCaps',
    'a ceiling past the safe integers',
    { dailyTokens: 2 ** 53, perRunTokens: null },
    REFUSED,
  ],
  [
    'setAiCaps',
    'a zero ceiling',
    { dailyTokens: 0, perRunTokens: null },
    REFUSED,
  ],
  [
    'setAiCaps',
    'a negative ceiling',
    { dailyTokens: -5, perRunTokens: null },
    REFUSED,
  ],
  [
    'setAiCaps',
    'a fractional ceiling',
    { dailyTokens: 1.5, perRunTokens: null },
    REFUSED,
  ],
  [
    'setAiCaps',
    'a ceiling as text',
    { dailyTokens: '100', perRunTokens: null },
    REFUSED,
  ],
  ['setAiCaps', 'a missing ceiling', { dailyTokens: 100 }, REFUSED],
  ['getAiRun', 'a run', { runId: ID }, { runId: ID }],
  [
    'getAiRun',
    'an upper-case run',
    { runId: ID.toUpperCase() },
    { runId: ID.toUpperCase() },
  ],
  [
    'getAiRun',
    'the upper-case max id',
    { runId: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' },
    REFUSED,
  ],
  ['getAiRun', 'a bad run', { runId: 'run-1' }, REFUSED],
  [
    'saveEmbeddingKey',
    'a key, trimmed',
    { provider: 'voyage', key: '  pa-1  ' },
    { provider: 'voyage', key: 'pa-1' },
  ],
  [
    'saveEmbeddingKey',
    'a blank key',
    { provider: 'voyage', key: '   ' },
    REFUSED,
  ],
  [
    'saveEmbeddingKey',
    'ollama, which takes no key',
    { provider: 'ollama', key: 'k' },
    REFUSED,
  ],
  [
    'saveEmbeddingKey',
    'a key of 4001',
    { provider: 'openai', key: 'k'.repeat(4001) },
    REFUSED,
  ],
  [
    'testEmbedding',
    'a target, trimmed',
    { provider: 'ollama', model: ' nomic-embed-text ' },
    { provider: 'ollama', model: 'nomic-embed-text' },
  ],
  [
    'pinEmbedding',
    'a blank model',
    { provider: 'openai', model: '  ' },
    REFUSED,
  ],
  [
    'pinEmbedding',
    'a model of 200',
    { provider: 'openai', model: 'm'.repeat(200) },
    { provider: 'openai', model: 'm'.repeat(200) },
  ],
  [
    'setSensitiveSlot',
    'an unknown provider',
    { provider: 'anthropic', model: 'm' },
    REFUSED,
  ],
])

table('attributeAi', [
  [
    'runAttributeCell',
    'a cell',
    { entityId: ID, attributeId: ID2 },
    { entityId: ID, attributeId: ID2 },
  ],
  [
    'runAttributeCell',
    'a bad attribute',
    { entityId: ID, attributeId: 'x' },
    REFUSED,
  ],
  [
    'attributeCellStatus',
    'a stray key',
    { entityId: ID, attributeId: ID2, x: 1 },
    { entityId: ID, attributeId: ID2 },
  ],
  ['openCellProposals', 'no records', { entityIds: [] }, { entityIds: [] }],
  [
    'openCellProposals',
    '500 records',
    { entityIds: Array.from({ length: 500 }, () => ID) },
    { entityIds: Array.from({ length: 500 }, () => ID) },
  ],
  [
    'openCellProposals',
    '501 records',
    { entityIds: Array.from({ length: 501 }, () => ID) },
    REFUSED,
  ],
  ['aiWrittenCells', 'a bad id', { entityIds: [ID, 'x'] }, REFUSED],
  [
    'estimateColumnRun',
    'a column',
    { viewId: ID, attributeId: ID2 },
    { viewId: ID, attributeId: ID2 },
  ],
  ['runColumn', 'no view', { attributeId: ID2 }, REFUSED],
  [
    'addProposedOption',
    'a label, trimmed',
    { suggestionId: ID, label: '  Climate  ' },
    { suggestionId: ID, label: 'Climate' },
  ],
  [
    'addProposedOption',
    'a blank label',
    { suggestionId: ID, label: '   ' },
    REFUSED,
  ],
  [
    'addProposedOption',
    'a label of 60 once trimmed',
    { suggestionId: ID, label: ` ${'l'.repeat(60)} ` },
    { suggestionId: ID, label: 'l'.repeat(60) },
  ],
  [
    'addProposedOption',
    'a label of 61',
    { suggestionId: ID, label: 'l'.repeat(61) },
    REFUSED,
  ],
])

table('suggestSpaces', [
  ['suggestSpaces', 'a record', { entityId: ID }, { entityId: ID }],
  ['suggestSpaces', 'a bad record', { entityId: 'acme' }, REFUSED],
  [
    'suggestSpacesStatus',
    'a stray key',
    { entityId: ID, x: 1 },
    { entityId: ID },
  ],
])

const chip = { kind: 'record', id: ID, name: 'Acme', href: '/companies/acme' }

table('ask', [
  [
    'askQuestion',
    'a question, trimmed',
    { threadId: null, question: '  Who leads?  ', scope: [chip] },
    { threadId: null, question: 'Who leads?', scope: [chip] },
  ],
  [
    'askQuestion',
    'a web chip with no id or link',
    {
      threadId: ID,
      question: 'q',
      scope: [{ kind: 'web', id: null, name: 'Exa', href: null }],
    },
    {
      threadId: ID,
      question: 'q',
      scope: [{ kind: 'web', id: null, name: 'Exa', href: null }],
    },
  ],
  [
    'askQuestion',
    'a blank question',
    { threadId: null, question: '   ', scope: [] },
    REFUSED,
  ],
  [
    'askQuestion',
    'a question of 4001',
    { threadId: null, question: 'q'.repeat(4001), scope: [] },
    REFUSED,
  ],
  ['askQuestion', 'no thread key', { question: 'q', scope: [] }, REFUSED],
  [
    'askQuestion',
    'six chips',
    {
      threadId: null,
      question: 'q',
      scope: Array.from({ length: 6 }, () => chip),
    },
    REFUSED,
  ],
  [
    'askQuestion',
    'an unknown chip kind',
    { threadId: null, question: 'q', scope: [{ ...chip, kind: 'deal' }] },
    REFUSED,
  ],
  [
    'askQuestion',
    'a chip with an empty name',
    { threadId: null, question: 'q', scope: [{ ...chip, name: '' }] },
    REFUSED,
  ],
  [
    'askQuestion',
    'a chip with a long link',
    {
      threadId: null,
      question: 'q',
      scope: [{ ...chip, href: 'h'.repeat(501) }],
    },
    REFUSED,
  ],
  [
    'askQuestion',
    'a chip with a stray key',
    { threadId: null, question: 'q', scope: [{ ...chip, extra: 1 }] },
    { threadId: null, question: 'q', scope: [chip] },
  ],
  [
    'askQuestion',
    'a chip with no link key',
    {
      threadId: null,
      question: 'q',
      scope: [{ kind: 'space', id: ID, name: 'S' }],
    },
    REFUSED,
  ],
  ['getAskThread', 'a thread', { threadId: ID }, { threadId: ID }],
  ['getAskThread', 'a null thread', { threadId: null }, REFUSED],
  [
    'renameAskThread',
    'a title, trimmed',
    { threadId: ID, title: '  Diligence  ' },
    { threadId: ID, title: 'Diligence' },
  ],
  ['renameAskThread', 'a blank title', { threadId: ID, title: '  ' }, REFUSED],
  [
    'renameAskThread',
    'a title of 201',
    { threadId: ID, title: 't'.repeat(201) },
    REFUSED,
  ],
  ['getAskThreadCounts', 'a bad thread', { threadId: 'x' }, REFUSED],
  ['deleteAskThread', 'a thread', { threadId: ID }, { threadId: ID }],
  ['saveAskAnswerAsNote', 'a turn', { turnId: ID }, { turnId: ID }],
  ['saveAskAnswerAsNote', 'no turn', {}, REFUSED],
  ['previewAskRef', 'a ref', { ref: ' note:1 ' }, { ref: ' note:1 ' }],
  ['previewAskRef', 'an empty ref', { ref: '' }, REFUSED],
  ['previewAskRef', 'a ref of 301', { ref: 'r'.repeat(301) }, REFUSED],
  ['applyAskCard', 'a card', { suggestionId: ID }, { suggestionId: ID }],
  ['skipAskCard', 'a bad card', { suggestionId: '1' }, REFUSED],
  [
    'actOnFindRow',
    'an add',
    { turnId: ID, domain: 'acme.com', act: 'add' },
    { turnId: ID, domain: 'acme.com', act: 'add' },
  ],
  [
    'actOnFindRow',
    'a padded domain, kept',
    { turnId: ID, domain: ' acme.com ', act: 'file' },
    { turnId: ID, domain: ' acme.com ', act: 'file' },
  ],
  [
    'actOnFindRow',
    'an unknown act',
    { turnId: ID, domain: 'acme.com', act: 'merge' },
    REFUSED,
  ],
  [
    'actOnFindRow',
    'a domain of 254',
    { turnId: ID, domain: 'd'.repeat(254), act: 'dismiss' },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a watch on a space',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: { region: 'EU', fresh: true },
      cadenceMinutes: 60,
    },
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: { region: 'EU', fresh: true },
      cadenceMinutes: 60,
    },
  ],
  [
    'saveFindAsWatch',
    'a watch on a new space, trimmed, no cadence',
    {
      turnId: ID,
      callIndex: 3,
      space: { create: '  Hydrogen  ' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    {
      turnId: ID,
      callIndex: 3,
      space: { create: 'Hydrogen' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
  ],
  [
    'saveFindAsWatch',
    'a space that names both',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2, create: 'x' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
  ],
  [
    'saveFindAsWatch',
    'a space with a bad id and a name',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: 'x', create: 'Hydrogen' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    {
      turnId: ID,
      callIndex: 0,
      space: { create: 'Hydrogen' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
  ],
  [
    'saveFindAsWatch',
    'a blank new space',
    {
      turnId: ID,
      callIndex: 0,
      space: { create: '  ' },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a negative call index',
    {
      turnId: ID,
      callIndex: -1,
      space: { id: ID2 },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a fractional call index',
    {
      turnId: ID,
      callIndex: 1.5,
      space: { id: ID2 },
      integrationId: ID,
      values: {},
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a zero cadence',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: {},
      cadenceMinutes: 0,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a number among the values',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: { n: 1 },
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'values that are a list',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: [],
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'values that are a date',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: new Date(0),
      cadenceMinutes: null,
    },
    REFUSED,
  ],
  [
    'saveFindAsWatch',
    'a __proto__ value, dropped',
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: JSON.parse('{"__proto__": "x", "region": "EU"}'),
      cadenceMinutes: null,
    },
    {
      turnId: ID,
      callIndex: 0,
      space: { id: ID2 },
      integrationId: ID,
      values: { region: 'EU' },
      cadenceMinutes: null,
    },
  ],
])
