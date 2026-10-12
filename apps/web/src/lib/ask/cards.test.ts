import { describe, expect, it } from 'vitest'
import {
  ASK_CARD_CATALOGUE,
  isCalendarDate,
  outcomeWord,
  renderableCard,
} from './cards'
import type { AskCardView } from './cards'

/** The card catalogue and the renderer's refusal. (D70) */

const card = (over: Partial<AskCardView>): AskCardView => ({
  id: 's',
  kind: 'task',
  record: { id: 'r', name: 'Acme', href: '/companies/r' },
  summary: 'Call Acme',
  rationale: 'Quiet for sixty days',
  evidence: [
    { ref: 'record:r', label: 'Acme', href: '/companies/r', entityId: 'r' },
  ],
  outcome: 'open',
  moved: false,
  ...over,
})

describe('action cards', () => {
  it('the catalogue holds the eight cards, the three with a writer available', () => {
    expect(ASK_CARD_CATALOGUE.map((e) => e.kind)).toEqual([
      'task',
      'move_stage',
      'file_into_space',
      'log_signal',
      'note',
      'draft_email',
      'add_record',
      'save_as_watch',
    ])
    expect(
      ASK_CARD_CATALOGUE.filter((e) => e.available).map((e) => e.kind),
    ).toEqual(['task', 'move_stage', 'file_into_space'])
  })

  it('refuses a card without evidence', () => {
    expect(renderableCard(card({ evidence: [] }))).toBeNull()
    expect(renderableCard(card({}))).not.toBeNull()
  })

  it('prints a decided card as a state word, an undecided one as none', () => {
    expect(outcomeWord(card({ outcome: 'open' }))).toBeNull()
    expect(outcomeWord(card({ outcome: 'applied' }))).toBe('applied')
    expect(outcomeWord(card({ outcome: 'skipped' }))).toBe('skipped')
    expect(outcomeWord(card({ kind: 'move_stage', outcome: 'conflict' }))).toBe(
      'not applied · already at that stage',
    )
    expect(
      outcomeWord(
        card({ kind: 'move_stage', outcome: 'conflict', moved: true }),
      ),
    ).toBe('conflict · stage moved since')
    expect(
      outcomeWord(card({ kind: 'file_into_space', outcome: 'conflict' })),
    ).toBe('not applied · already filed')
  })

  it('takes a due date only when it names a real day', () => {
    expect(isCalendarDate('2026-10-20')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
  })
})
