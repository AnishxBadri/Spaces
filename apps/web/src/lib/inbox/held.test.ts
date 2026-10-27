import { describe, expect, it } from 'vitest'
import { heldOutcome } from '#/lib/ask/cards'
import type { AskCardView } from '#/lib/ask/cards'
import {
  NOTHING_HELD,
  hasOpenItems,
  heldBeaconSchema,
  heldView,
  isAlreadyDecided,
  isHeld,
  alreadyDecidedMessage,
  withoutHeld,
} from './held'
import type { InboxRow, SuggestionItem, SuggestionRow } from './queue'

/**
 * What a held decision hides: its suggestion, pair or card, or — for a
 * column accept — its field on every patch that proposes it.
 */

const field = (slug: string) => ({
  slug,
  name: slug,
  type: 'text',
  options: null,
  isSystem: false,
  value: 'x',
  current: null,
  confidence: null,
})

const item = (
  id: string,
  over: Partial<Pick<SuggestionItem, 'kind' | 'fields' | 'runId'>> = {},
): SuggestionItem => ({
  id,
  kind: 'attribute_patch',
  payload: {},
  rationale: null,
  citations: [],
  fields: [field('location')],
  origin: { via: 'app' },
  source: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  runId: null,
  ...over,
})

const card = (
  id: string,
  suggestions: Array<SuggestionItem>,
): SuggestionRow => ({
  kind: 'suggestion',
  id,
  record: {
    id,
    name: 'Exponent',
    kind: 'company',
    objectSlug: null,
    objectSingular: null,
  },
  page: null,
  suggestions,
  latestAt: '2026-10-20T10:00:00.000Z',
})

describe('withoutHeld', () => {
  it('passes the queue through when nothing is held', () => {
    const rows: Array<InboxRow> = [card('r1', [item('s1')])]
    expect(withoutHeld(rows, NOTHING_HELD)).toEqual(rows)
  })

  it('drops a held suggestion, and its card once nothing is left', () => {
    const rows: Array<InboxRow> = [
      card('r1', [item('s1'), item('s2')]),
      card('r2', [item('s3')]),
    ]
    const view = heldView([
      { verb: 'accept', id: 's1' },
      { verb: 'dismiss', id: 's3' },
    ])
    expect(withoutHeld(rows, view)).toEqual([card('r1', [item('s2')])])
  })

  it('a column accept hides its field everywhere, and a patch with nothing left', () => {
    const two = item('s1', { fields: [field('location'), field('stage')] })
    const rows: Array<InboxRow> = [card('r1', [two, item('s2')])]
    const view = heldView([
      { verb: 'accept-column', attributeSlug: 'location', runId: null },
    ])
    expect(withoutHeld(rows, view)).toEqual([
      card('r1', [{ ...two, fields: [field('stage')] }]),
    ])
  })

  it("a run's Accept all hides only that run's fields", () => {
    const rows: Array<InboxRow> = [
      {
        kind: 'column_run',
        id: 'run1',
        run: {
          id: 'run1',
          task: 'Column run · HQ',
          status: 'done',
          rowsRun: 2,
          error: null,
          startedAt: '2026-10-20T10:00:00.000Z',
        },
        attributeSlug: 'location',
        cards: [card('r1', [item('s1', { runId: 'run1' })])],
        latestAt: '2026-10-20T10:00:00.000Z',
      },
      card('r2', [item('s2', { runId: 'run2' })]),
    ]
    const view = heldView([
      { verb: 'accept-column', attributeSlug: 'location', runId: 'run1' },
    ])
    expect(withoutHeld(rows, view)).toEqual([rows[1]])
  })

  it('keeps an emptied discovery group mounted, but not counted', () => {
    const rows: Array<InboxRow> = [
      {
        kind: 'discovery',
        id: 'space1',
        space: { id: 'space1', name: 'Proptech', path: 'Proptech' },
        via: [],
        suggestions: [item('s1', { kind: 'add_record', fields: null })],
        latestAt: '2026-10-20T10:00:00.000Z',
      },
    ]
    const kept = withoutHeld(rows, heldView([{ verb: 'accept', id: 's1' }]))
    expect(kept).toHaveLength(1)
    expect(kept.filter(hasOpenItems)).toEqual([])
  })

  it('holds a pair and an Ask card by id', () => {
    const view = heldView([
      { verb: 'dismiss-duplicate', candidateId: 'pair1' },
      { verb: 'skip-card', suggestionId: 'card1' },
    ])
    expect(isHeld(view, 'pair1')).toBe(true)
    expect(isHeld(view, 'card1')).toBe(true)
    expect(isHeld(view, 'other')).toBe(false)
  })
})

describe('an Ask card during its hold', () => {
  const open: AskCardView = {
    id: 'card1',
    kind: 'task',
    record: { id: 'r1', name: 'Exponent', href: null },
    summary: 'Call the founder',
    rationale: '',
    evidence: [],
    outcome: 'open',
    moved: false,
  }
  it('reads as its outcome, and a decided card as it stands', () => {
    expect(heldOutcome(open, 'apply-card').outcome).toBe('applied')
    expect(heldOutcome(open, 'skip-card').outcome).toBe('skipped')
    const applied: AskCardView = { ...open, outcome: 'applied' }
    expect(heldOutcome(applied, 'skip-card')).toBe(applied)
  })
})

describe('the shared spellings', () => {
  it('tells a decision made elsewhere from a refusal', () => {
    expect(isAlreadyDecided(new Error(alreadyDecidedMessage('rejected')))).toBe(
      true,
    )
    expect(isAlreadyDecided(new Error('Could not apply this suggestion'))).toBe(
      false,
    )
  })

  it('the beacon body is a list of decisions, nothing else', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(
      heldBeaconSchema.safeParse({ decisions: [{ verb: 'accept', id }] })
        .success,
    ).toBe(true)
    expect(
      heldBeaconSchema.safeParse({ decisions: [{ verb: 'merge', id }] })
        .success,
    ).toBe(false)
    expect(heldBeaconSchema.safeParse({ decisions: [] }).success).toBe(false)
  })
})
