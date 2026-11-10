import { describe, expect, it } from 'vitest'
import type { ContextItem } from '@spaces/core/context/types'
import { buildRequest, renderBlock, renderPrompt } from './prompt'
import type { BuiltRequest } from './prompt'

/**
 * The prompt renderer is pure — this file imports nothing that
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

describe('buildRequest', () => {
  const INSTRUCTIONS = 'Classify the company stage. Cite the [ref] you read.'
  const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } }

  /** The text of the last message's first part. */
  const lastText = (r: BuiltRequest): string => {
    const m = r.messages.at(-1)
    if (m === undefined || typeof m.content === 'string')
      throw new Error('no parts')
    const part = m.content.at(0)
    if (part?.type !== 'text') throw new Error('no text part')
    return part.text
  }

  const call = (subject: string, cache = true) =>
    buildRequest({
      instructions: INSTRUCTIONS,
      items: ITEMS,
      subject,
      budgetChars: 10_000,
      cache,
    })

  it('sends a system part and a user part, never one string', () => {
    const r = call('The company is "Acme".')
    expect(r.instructions).toEqual({
      role: 'system',
      content: INSTRUCTIONS,
      providerOptions: MARK,
    })
    expect(r.messages).toHaveLength(1)
    expect(r.messages.at(0)?.role).toBe('user')
    expect(lastText(r)).not.toContain(INSTRUCTIONS)
  })

  it('gives two calls of one lane a byte-identical system part and user prefix up to the subject', () => {
    const a = call('The company is "Acme".')
    const b = call('The company is "Globex Corporation", founded in Berlin.')
    expect(JSON.stringify(a.instructions)).toBe(JSON.stringify(b.instructions))
    const prefix = ITEMS.map(renderBlock).join('\n\n') + '\n\n'
    expect(lastText(a).startsWith(prefix)).toBe(true)
    expect(lastText(b).startsWith(prefix)).toBe(true)
    expect(lastText(a).slice(prefix.length)).toBe('The company is "Acme".')
  })

  it('marks only the system part, and nothing on a provider that reads no markers', () => {
    expect(JSON.stringify(call('x').messages)).not.toContain('cacheControl')
    const plain = call('x', false)
    expect(plain.instructions).toEqual({
      role: 'system',
      content: INSTRUCTIONS,
    })
    expect(JSON.stringify(plain)).not.toContain('cacheControl')
  })

  it('sends a conversation as real messages, the last two marked and the earlier ones not', () => {
    const r = buildRequest({
      instructions: INSTRUCTIONS,
      items: [],
      subject: 'And who led it?',
      budgetChars: 10_000,
      cache: true,
      conversation: [
        { role: 'user', text: 'Which stage is Acme at?' },
        { role: 'assistant', text: 'Seed [attr:e1:stage].' },
        { role: 'user', text: 'When did it raise?' },
        { role: 'assistant', text: 'In Q4 [note:n1].' },
      ],
    })
    expect(r.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(r.messages.map((m) => m.providerOptions)).toEqual([
      undefined,
      undefined,
      undefined,
      MARK,
      MARK,
    ])
    expect(lastText(r)).toBe('And who led it?')

    const unmarked = buildRequest({
      instructions: INSTRUCTIONS,
      items: [],
      subject: 'And who led it?',
      budgetChars: 10_000,
      cache: false,
      conversation: [{ role: 'user', text: 'Which stage is Acme at?' }],
    })
    expect(unmarked.messages).toHaveLength(2)
    expect(JSON.stringify(unmarked)).not.toContain('cacheControl')
  })

  it('keeps file parts after the text of the user part', () => {
    const data = new Uint8Array([1, 2, 3])
    const r = buildRequest({
      instructions: INSTRUCTIONS,
      items: [],
      subject: 'Pages 1–2 of "deck.pdf".',
      budgetChars: 10_000,
      cache: true,
      files: [{ mediaType: 'application/pdf', data, name: 'deck.pdf' }],
    })
    const user = r.messages.at(0)
    if (user?.role !== 'user' || typeof user.content === 'string')
      throw new Error('no user parts')
    expect(user.content).toEqual([
      { type: 'text', text: 'Pages 1–2 of "deck.pdf".' },
      {
        type: 'file',
        data,
        mediaType: 'application/pdf',
        filename: 'deck.pdf',
      },
    ])
  })

  it('cuts the context to the budget, never the system part or the subject', () => {
    const subject = 'The company is "Acme".'
    const budget = INSTRUCTIONS.length + subject.length + 40
    const r = buildRequest({
      instructions: INSTRUCTIONS,
      items: ITEMS,
      subject,
      budgetChars: budget,
      cache: false,
    })
    expect(r.instructions.content).toBe(INSTRUCTIONS)
    const text = lastText(r)
    expect(text.endsWith(subject)).toBe(true)
    expect(text).toContain('[attr:e1:stage] Stage: Seed')
    expect(text).not.toContain('[doc:d1#p2]')
    expect(INSTRUCTIONS.length + text.length).toBeLessThanOrEqual(budget)

    // A budget the system part alone overruns still sends it whole.
    const tight = buildRequest({
      instructions: INSTRUCTIONS,
      items: ITEMS,
      subject,
      budgetChars: 10,
      cache: false,
    })
    expect(tight.instructions.content).toBe(INSTRUCTIONS)
    expect(lastText(tight)).not.toContain('[attr:e1:stage]')
  })

  it('renders the context alone when the lane has no subject', () => {
    expect(lastText(call(''))).toBe(ITEMS.map(renderBlock).join('\n\n'))
  })
})
