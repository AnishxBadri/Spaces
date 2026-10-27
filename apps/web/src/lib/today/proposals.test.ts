import { describe, expect, it } from 'vitest'
import type {
  AskCardsRow,
  ColumnRunRow,
  DiscoveryRow,
  DuplicateCandidateRow,
  SuggestionField,
  SuggestionItem,
  SuggestionRow,
} from '#/lib/inbox/queue'
import type { InboxSide } from '#/lib/inbox/context'
import {
  acceptAllShortfall,
  flattenInbox,
  pairLine,
  proposalLine,
  proposerOf,
} from './proposals'
import type { LineContext, ProposalGroup, ProposalLeaf } from './proposals'

/**
 * Today's Review rows, pure: the queue flattened one row per proposal with
 * its groups over their children, and the sentence each kind says.
 */

const TODAY = '2026-10-28'
const DOC = '00000000-0000-4000-8000-0000000000d1'
const OLD = '00000000-0000-4000-8000-0000000000d2'
const SPACE = '00000000-0000-4000-8000-0000000000a1'
const HOLDING = '00000000-0000-4000-8000-0000000000b1'
const PERSON = '00000000-0000-4000-8000-0000000000c1'

const stage: SuggestionField = {
  slug: 'funding_stage',
  name: 'Funding stage',
  type: 'select',
  options: { options: [{ id: 'opt_a', label: 'Series A' }] },
  isSystem: false,
  value: 'opt_a',
  current: null,
  confidence: 0.8,
}

const item = (over: Partial<SuggestionItem> = {}): SuggestionItem => ({
  id: 's1',
  kind: 'attribute_patch',
  payload: {},
  rationale: null,
  citations: [],
  fields: [stage],
  origin: { via: 'app' },
  source: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  runId: null,
  ...over,
})

const record = {
  id: 'r1',
  name: 'Exponent',
  kind: 'company',
  objectSlug: null,
  objectSingular: null,
}

const card = (
  suggestions: Array<SuggestionItem>,
  page: SuggestionRow['page'] = null,
): SuggestionRow => ({
  kind: 'suggestion',
  id: 'r1',
  record,
  page,
  suggestions,
  latestAt: '2026-10-20T10:00:00.000Z',
})

const side = (id: string, name: string): InboxSide => ({
  id,
  name,
  kind: 'company',
  createdAt: '2026-10-01T00:00:00.000Z',
  objectSlug: 'company',
  objectSingular: 'Company',
  sourceClass: 'manual',
  sourceCapability: null,
  label: 'manual',
  domains: [],
  identityDomain: null,
  otherNames: [],
  mentionCount: 0,
  valueCount: 0,
  spaces: [],
})

const pair: DuplicateCandidateRow = {
  kind: 'duplicate_candidate',
  id: 'p1',
  score: 0.92,
  reason: { shared: 'domain' },
  latestAt: '2026-10-19T00:00:00.000Z',
  a: side('a1', 'Acme'),
  b: side('b1', 'Acme Inc'),
}

const at = (over: Partial<LineContext> = {}): LineContext => ({
  today: TODAY,
  record: null,
  filedIn: null,
  captured: false,
  ...over,
})

const ledgerPayload = {
  companyId: '00000000-0000-4000-8000-0000000000e1',
  companyName: 'Exponent',
  documentId: DOC,
  documentName: 'Cap table.xlsx',
  revisionId: 'rev-2',
  before: {
    ownershipPct: 12.4,
    fairValue: 1_200_000,
    currency: 'USD',
    roundKind: 'Series A',
    roundDate: '2026-04-01',
  },
  after: { ownershipPct: 9.8 },
  event: 'mark',
  proposed: {
    holdingId: HOLDING,
    date: '2026-10-03',
    fairValue: 1_400_000,
    currency: 'USD',
    basis: 'round_price',
  },
}

describe('proposalLine', () => {
  const noteSource = {
    ref: `note:${DOC}`,
    entityId: DOC,
    label: 'Exponent weekly sync',
    missing: false,
  }
  it.each<[string, SuggestionItem, LineContext, string]>([
    ['attribute_patch', item(), at(), 'Funding stage → Series A'],
    [
      'supersedes',
      item({
        kind: 'supersedes',
        fields: null,
        payload: {
          newerId: DOC,
          olderId: OLD,
          newerName: 'Deck v2.pdf',
          olderName: 'Deck v1.pdf',
          documentKind: 'deck',
        },
      }),
      at({ record: 'Exponent' }),
      'Newer version of Deck v1.pdf · Exponent',
    ],
    [
      'space_tag',
      item({
        kind: 'space_tag',
        fields: null,
        payload: { spaceId: SPACE, label: 'Proptech / Property ops' },
      }),
      at(),
      'Belongs in Proptech / Property ops',
    ],
    [
      'document_kind',
      item({
        kind: 'document_kind',
        fields: null,
        payload: { kind: 'cap_table' },
      }),
      at({ record: 'Exponent' }),
      'Kind → Cap table · Exponent',
    ],
    [
      'note',
      item({
        kind: 'note',
        fields: null,
        payload: { title: 'Key terms', markdown: 'x', sourceId: DOC },
        citations: [noteSource],
      }),
      at(),
      'Note from Exponent weekly sync',
    ],
    [
      'ledger_event',
      item({ kind: 'ledger_event', fields: null, payload: ledgerPayload }),
      at(),
      'Mark at $1.4M · Series A price, 3 Oct',
    ],
    [
      'captured identity',
      item({
        kind: 'identity',
        fields: null,
        payload: { name: 'Priya Raman', role: 'CEO' },
      }),
      at({ captured: true }),
      'Captured page · matches Priya Raman',
    ],
    [
      'meeting task',
      item({
        kind: 'task',
        fields: null,
        payload: { title: 'Send the deck', due: null, entity_id: PERSON },
        citations: [noteSource],
      }),
      at(),
      'Task from Exponent weekly sync',
    ],
    [
      'option proposal',
      item({
        fields: [],
        rationale: 'Proposed new option "Climate" for Sector (sector).',
      }),
      at(),
      'New option "Climate" · for everyone',
    ],
    [
      'add_record child',
      item({
        kind: 'add_record',
        fields: null,
        rationale: 'Rental software for small landlords',
        payload: {
          spaceId: SPACE,
          domain: 'rentwise.com',
          name: 'Rentwise',
          evidence: [],
          aliases: [],
          subspaceHint: null,
        },
      }),
      at(),
      'rentwise.com · Rental software for small landlords',
    ],
    [
      'file_record child',
      item({
        kind: 'file_record',
        fields: null,
        payload: {
          spaceId: SPACE,
          domain: 'rentwise.com',
          name: 'Rentwise',
          evidence: [],
          entityId: PERSON,
        },
      }),
      at({ filedIn: 'Proptech / Rental software' }),
      'Filed in Proptech / Rental software',
    ],
  ])('%s', (_kind, proposal, context, line) => {
    expect(proposalLine(proposal, context)).toBe(line)
  })

  it('says a duplicate is possibly the same, by the key both carry', () => {
    expect(pairLine(pair)).toBe('Possibly the same · domain on both')
  })

  it("falls back to the kind's word when a payload does not read", () => {
    expect(proposalLine(item({ kind: 'space_tag', fields: null }), at())).toBe(
      'Space',
    )
  })
})

describe('flattenInbox', () => {
  const ctx = { today: TODAY, filedIn: {} }
  const leaves = (rows: ReturnType<typeof flattenInbox>) =>
    rows.filter((r): r is ProposalLeaf => r.kind === 'leaf')
  const groups = (rows: ReturnType<typeof flattenInbox>) =>
    rows.filter((r): r is ProposalGroup => r.kind === 'group')

  it('gives one row per suggestion on a record card, decided there', () => {
    const rows = flattenInbox(
      [
        card([
          item({ id: 's1', source: 'Apollo' }),
          item({ id: 's2', kind: 'space_tag', fields: null }),
        ]),
      ],
      ctx,
    )
    expect(rows.map((r) => r.key)).toEqual(['suggestion:s1', 'suggestion:s2'])
    const [patch, tag] = leaves(rows)
    expect(patch.subject).toBe('Exponent')
    expect(patch.who).toBe('Via Apollo')
    expect(patch.primary).toBe('Accept')
    expect(patch.review).toEqual({ record: 'r1' })
    expect(tag.who).toBe('AI')
    expect(tag.primary).toBe('Add to space')
    expect(tag.dismiss).toBe('Dismiss')
  })

  it("heads a captured page's proposals Captured, filed on the person", () => {
    const [row] = leaves(
      flattenInbox(
        [
          card(
            [
              item({
                kind: 'identity',
                fields: null,
                payload: { name: 'Priya Raman' },
              }),
            ],
            { title: 'Priya Raman — LinkedIn', url: null },
          ),
        ],
        ctx,
      ),
    )
    expect(row.who).toBe('Captured')
    expect(row.primary).toBe('File on Priya Raman')
  })

  it('gives a registry proposal Add option', () => {
    const [row] = leaves(
      flattenInbox(
        [
          card([
            item({
              fields: [],
              rationale: 'Proposed new option "Climate" for Sector (sector).',
            }),
          ]),
        ],
        ctx,
      ),
    )
    expect(row.primary).toBe('Add option')
    expect(row.target.kind === 'suggestion' && row.target.accepted).toBe(
      '"Climate" added to Sector',
    )
  })

  it('gives a pair one row: Compare, or Not the same', () => {
    const [row] = leaves(flattenInbox([pair], ctx))
    expect(row.key).toBe('pair:p1')
    expect(row.subject).toBe('Acme ⇄ Acme Inc')
    expect(row.primary).toBe('Compare')
    expect(row.dismiss).toBe('Not the same')
    expect(row.review).toEqual({ record: 'a1', lane: 'duplicates' })
  })

  it("groups a watch's space over a row per company", () => {
    const discovery: DiscoveryRow = {
      kind: 'discovery',
      id: SPACE,
      space: {
        id: SPACE,
        name: 'Property ops',
        path: 'Proptech / Property ops',
      },
      via: ['Exa'],
      suggestions: [
        item({
          id: 'd1',
          kind: 'add_record',
          fields: null,
          source: 'Exa',
          payload: {
            spaceId: SPACE,
            domain: 'rentwise.com',
            name: 'Rentwise',
            evidence: [],
            aliases: [],
            subspaceHint: null,
          },
        }),
      ],
      latestAt: '2026-10-20T10:00:00.000Z',
    }
    const [group] = groups(flattenInbox([discovery], ctx))
    expect(group.subject).toBe('Proptech / Property ops')
    expect(group.line).toBe('1 to add')
    expect(group.who).toBe('Via Exa')
    expect(group.of).toEqual({ kind: 'discovery', spaceId: SPACE })
    const [child] = group.children
    expect(child.subject).toBe('Rentwise')
    expect(child.primary).toBe('Add and file')
    expect(child.target.kind === 'suggestion' && child.target.dismissed).toBe(
      'Rentwise dismissed from Property ops',
    )
  })

  it("groups a column run under its author, with Accept all's count", () => {
    const run: ColumnRunRow = {
      kind: 'column_run',
      id: 'run1',
      run: {
        id: 'run1',
        task: 'Column run · Funding stage',
        status: 'done',
        error: null,
        rowsRun: 2,
        startedAt: '2026-10-20T10:00:00.000Z',
        author: 'Anika Rao',
      },
      attributeSlug: 'funding_stage',
      cards: [card([item({ id: 'c1', runId: 'run1' })])],
      latestAt: '2026-10-20T10:00:00.000Z',
    }
    const [group] = groups(flattenInbox([run], ctx))
    expect(group.subject).toBe('Funding stage')
    expect(group.who).toBe('Anika Rao')
    expect(group.of).toEqual({
      kind: 'column_run',
      runId: 'run1',
      title: 'Funding stage',
      attributeSlug: 'funding_stage',
      taken: 1,
    })
    expect(group.children.map((c) => c.who)).toEqual(['Column run'])
  })

  it('groups an Ask thread Via Ask', () => {
    const ask: AskCardsRow = {
      kind: 'ask_cards',
      id: 'th1',
      title: 'Who leads Exponent?',
      cards: [card([item({ id: 'k1' })])],
      latestAt: '2026-10-20T10:00:00.000Z',
    }
    const [group] = groups(flattenInbox([ask], ctx))
    expect(group.subject).toBe('Who leads Exponent?')
    expect(group.line).toBe('1 card')
    expect(group.who).toBe('Via Ask')
    expect(group.of).toEqual({ kind: 'ask_cards', threadId: 'th1' })
  })

  it('drops a group with nothing left in it', () => {
    const empty: DiscoveryRow = {
      kind: 'discovery',
      id: SPACE,
      space: { id: SPACE, name: 'Property ops', path: 'Property ops' },
      via: [],
      suggestions: [],
      latestAt: '2026-10-20T10:00:00.000Z',
    }
    expect(flattenInbox([empty], ctx)).toEqual([])
  })
})

describe('the who lane and a short Accept all', () => {
  it('names the proposer', () => {
    expect(proposerOf(item({ source: 'Apollo' }), null)).toBe('Via Apollo')
    expect(proposerOf(item(), null)).toBe('AI')
    expect(proposerOf(item(), { title: 'Page', url: null })).toBe('Captured')
  })

  it('says how many were refused, only when some were', () => {
    expect(acceptAllShortfall([{ ok: true }, { ok: true }])).toBeNull()
    expect(
      acceptAllShortfall([
        ...Array.from({ length: 7 }, () => ({ ok: true })),
        { ok: false },
        { ok: false },
      ]),
    ).toBe('7 accepted · 2 refused, the values changed')
  })
})
