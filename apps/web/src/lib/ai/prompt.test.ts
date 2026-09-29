import { describe, expect, it } from 'vitest'
import type { ContextItem } from '@spaces/core/context/types'
import { renderBlock, renderPrompt } from './prompt'

/**
 * SPA-42. The prompt renderer is pure — this file imports nothing that
 * touches a database or a network — and it is what makes a model's output
 * citable: every ContextItem appears exactly once as `[ref] text`, and the
 * whole prompt fits `budgetChars`.
 */

const item = (ref: string, text: string): ContextItem => ({
  ref,
  kind: 'attribute',
  text,
  entityIds: [],
  at: null,
})

const ITEMS = [
  item('attr:e1:stage', 'Stage: Seed'),
  item('note:n1', 'Met the founders in Berlin; strong technical team.'),
  item('doc:d1#p2', 'Revenue grew 3x year over year.'),
]
const TASK = 'Classify the company stage.'

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1

describe('renderPrompt', () => {
  it('renders each item once as [ref] text, in the order given, then the task', () => {
    const prompt = renderPrompt({
      items: ITEMS,
      task: TASK,
      budgetChars: 10_000,
    })
    expect(prompt).toBe(
      [
        '[attr:e1:stage] Stage: Seed',
        '[note:n1] Met the founders in Berlin; strong technical team.',
        '[doc:d1#p2] Revenue grew 3x year over year.',
        TASK,
      ].join('\n\n'),
    )
    for (const i of ITEMS) expect(count(prompt, renderBlock(i))).toBe(1)
  })

  it('renders a repeated ref once', () => {
    const prompt = renderPrompt({
      items: [...ITEMS, item('note:n1', 'A second copy of the same note.')],
      task: TASK,
      budgetChars: 10_000,
    })
    expect(count(prompt, '[note:n1]')).toBe(1)
    expect(prompt).not.toContain('A second copy')
  })

  it('respects budgetChars at every size, task included', () => {
    const full = renderPrompt({ items: ITEMS, task: TASK, budgetChars: 10_000 })
    for (let budget = 0; budget <= full.length + 5; budget++) {
      const prompt = renderPrompt({
        items: ITEMS,
        task: TASK,
        budgetChars: budget,
      })
      expect(prompt.length).toBeLessThanOrEqual(budget)
      // No ref appears twice, whatever the cut.
      for (const i of ITEMS)
        expect(count(prompt, `[${i.ref}]`)).toBeLessThanOrEqual(1)
      // The task survives any budget that can hold it.
      if (budget >= TASK.length) expect(prompt.endsWith(TASK)).toBe(true)
    }
  })

  it('drops the lowest-ranked context first and cuts the overflowing block with an ellipsis', () => {
    const first = renderBlock(ITEMS[0])
    const budget = first.length + 2 + 20 + 2 + TASK.length
    const prompt = renderPrompt({
      items: ITEMS,
      task: TASK,
      budgetChars: budget,
    })
    expect(prompt.length).toBe(budget)
    expect(prompt.startsWith(`${first}\n\n[note:n1] `)).toBe(true)
    expect(prompt).toContain('…')
    expect(prompt).not.toContain('[doc:d1#p2]')
    expect(prompt.endsWith(TASK)).toBe(true)
  })

  it('is deterministic, and with no items is the task alone', () => {
    const a = renderPrompt({ items: ITEMS, task: TASK, budgetChars: 90 })
    const b = renderPrompt({ items: ITEMS, task: TASK, budgetChars: 90 })
    expect(a).toBe(b)
    expect(renderPrompt({ items: [], task: TASK, budgetChars: 1000 })).toBe(
      TASK,
    )
  })
})
