import { describe, expect, it } from 'vitest'
import {
  ASK_CARD_CATALOGUE,
  isCalendarDate,
  outcomeWord,
  renderableCard,
} from './cards'
import type { AskCardView } from './cards'

/** The card catalogue and the renderer's refusal. */

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
  by: null,
  moved: null,
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

  it('prints a decided card as a sentence-case state word, an undecided one as none', () => {
    const today = '2026-10-28'
    expect(outcomeWord(card({ outcome: 'open' }), today)).toBeNull()
    expect(outcomeWord(card({ outcome: 'applied', by: 'you' }), today)).toBe(
      'Applied · in Tasks',
    )
    expect(
      outcomeWord(
        card({ kind: 'move_stage', outcome: 'applied', by: 'you' }),
        today,
      ),
    ).toBe('Applied · by you, in History')
    expect(outcomeWord(card({ outcome: 'skipped' }), today)).toBe('Skipped')
    expect(
      outcomeWord(card({ kind: 'move_stage', outcome: 'conflict' }), today),
    ).toBe('Not applied · already at that stage')
    expect(
      outcomeWord(
        card({
          kind: 'move_stage',
          outcome: 'conflict',
          moved: { by: 'Priya', at: '2026-10-13T09:00:00.000Z' },
        }),
        today,
      ),
    ).toBe('Not applied · Priya moved it on 13 Oct')
    expect(
      outcomeWord(
        card({ kind: 'file_into_space', outcome: 'conflict' }),
        today,
      ),
    ).toBe('Not applied · already filed')
  })

  it('takes a due date only when it names a real day', () => {
    expect(isCalendarDate('2026-10-20')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
  })
})
