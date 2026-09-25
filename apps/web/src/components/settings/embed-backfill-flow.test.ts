import { describe, expect, it, vi } from 'vitest'
import {
  EMBEDDING_MODELS,
  EMBEDDING_PROVIDER_INFO,
  backfillCostLabel,
  backfillEstimateLine,
  backfillProgressLine,
  pricingOf,
  sensitiveEstimateLine,
} from '#/lib/ai/providers/embed/ids'
import type { BackfillEstimate } from '#/lib/ai/providers/embed/ids'
import { backfillRunOf } from '#/lib/ai/embed-backfill'
import { backfillConfirmOptions, confirmThenStart } from './embed-backfill-flow'

/**
 * SPA-136. The backfill asks before it embeds: the estimate is on the sheet
 * before anything runs, a cancel makes no call, and a local provider reads
 * "free" rather than a dollar figure. Pure — no DOM, no provider.
 */

const ESTIMATE: BackfillEstimate = {
  chunks: 4200,
  tokens: 2_520_000,
  cost: '~$0.05',
}

describe('the confirm', () => {
  it('carries the estimate before anything is started', () => {
    const options = backfillConfirmOptions(ESTIMATE, 'text-embedding-3-small')
    expect(options.title).toBe('Backfill 4,200 chunks?')
    expect(options.rows).toEqual([
      { name: 'Chunks', meta: '4,200' },
      { name: 'Tokens, estimated', meta: '~2,520,000' },
      { name: 'Cost, at list price', meta: '~$0.05' },
    ])
    expect(options.action).toBe('Backfill')
  })

  it('puts the sensitive chunks a local slot will take on the sheet, priced free (SPA-83)', () => {
    const sensitive: BackfillEstimate = {
      chunks: 12,
      tokens: 3_000,
      cost: 'free — local model',
    }
    const options = backfillConfirmOptions(ESTIMATE, 'text-embedding-3-small', {
      estimate: sensitive,
      model: 'nomic-embed-text',
    })
    expect(options.title).toBe('Backfill 4,212 chunks?')
    expect(options.body).toContain(
      'every sensitive chunk not yet on nomic-embed-text, which never leaves your box',
    )
    expect(options.rows).toEqual([
      { name: 'Chunks', meta: '4,200' },
      { name: 'Tokens, estimated', meta: '~2,520,000' },
      { name: 'Cost, at list price', meta: '~$0.05' },
      { name: 'Sensitive chunks, local', meta: '12' },
      { name: 'Sensitive cost', meta: 'free — local model' },
    ])
    expect(sensitiveEstimateLine(sensitive)).toBe(
      '12 sensitive chunks · ~3,000 tokens · free — local model',
    )
  })

  it('makes no call when cancelled', async () => {
    const start = vi.fn(async () => ({ status: 'queued' as const }))
    const shown: Array<unknown> = []
    const answer = await confirmThenStart(
      async (o) => {
        shown.push(o)
        return false
      },
      backfillConfirmOptions(ESTIMATE, 'text-embedding-3-small'),
      start,
    )
    expect(answer).toBeNull()
    expect(shown).toHaveLength(1)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts exactly once on a yes', async () => {
    const start = vi.fn(async () => ({ status: 'queued' as const }))
    const answer = await confirmThenStart(
      async () => true,
      backfillConfirmOptions(ESTIMATE, 'text-embedding-3-small'),
      start,
    )
    expect(answer).toEqual({ status: 'queued' })
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('the cost', () => {
  it('reads "free — local model" for a local provider, whatever its rate', () => {
    expect(
      backfillCostLabel(50_000_000, { local: true, usdPerMillionTokens: 0 }),
    ).toBe('free — local model')
    expect(
      backfillCostLabel(50_000_000, { local: true, usdPerMillionTokens: 0.13 }),
    ).toBe('free — local model')
  })

  it("multiplies tokens by a cloud model's list price, and says a sub-cent figure as one", () => {
    const small = EMBEDDING_MODELS.find(
      (m) => m.id === 'text-embedding-3-small',
    )
    if (!small) throw new Error('3-small is not in the catalogue')
    const pricing = pricingOf('openai', small)
    expect(pricing).toEqual({ local: false, usdPerMillionTokens: 0.02 })
    expect(backfillCostLabel(2_500_000, pricing)).toBe('~$0.05')
    expect(backfillCostLabel(1_000, pricing)).toBe('under $0.01')
    expect(backfillCostLabel(0, pricing)).toBe('$0.00')
    expect(
      backfillCostLabel(1_000_000_000, {
        local: false,
        usdPerMillionTokens: 0.13,
      }),
    ).toBe('~$130.00')
  })

  it('prices every cloud catalogue row, and reads every local one free by its flag', () => {
    for (const m of EMBEDDING_MODELS)
      if (EMBEDDING_PROVIDER_INFO[m.provider].local)
        expect(backfillCostLabel(1_000_000, pricingOf(m.provider, m))).toBe(
          'free — local model',
        )
      else expect(m.usdPerMillionTokens).toBeGreaterThan(0)
  })

  it('spells the estimate and the progress in one line each', () => {
    expect(backfillEstimateLine(ESTIMATE)).toBe(
      '4,200 chunks · ~2,520,000 tokens · ~$0.05',
    )
    expect(backfillProgressLine(96, 150)).toBe('embedded 96 of 150')
  })
})

describe('the run state', () => {
  const at = (iso: string) => new Date(iso)
  const now = at('2026-09-23T15:00:00.000Z')

  it('reads a run re-sent for the reset as paused, with the reason it stopped', () => {
    expect(
      backfillRunOf(
        [
          {
            state: 'completed',
            output: { kind: 'rate-limited', reason: 'cap reached' },
            createdOn: at('2026-09-23T14:00:00.000Z'),
          },
          {
            state: 'created',
            output: null,
            createdOn: at('2026-09-23T14:30:00.000Z'),
            startAfter: at('2026-09-24T00:01:00.000Z'),
          },
        ],
        now,
      ),
    ).toEqual({
      state: 'paused',
      resumesAt: '2026-09-24T00:01:00.000Z',
      reason: 'cap reached',
    })
  })

  it('reads active as running, due-now as queued, and a failure with its reason', () => {
    expect(
      backfillRunOf([{ state: 'active', output: null, createdOn: now }], now),
    ).toEqual({ state: 'running' })
    expect(
      backfillRunOf(
        [{ state: 'created', output: null, createdOn: now, startAfter: now }],
        now,
      ),
    ).toEqual({ state: 'queued' })
    expect(
      backfillRunOf(
        [
          {
            state: 'cancelled',
            output: { reason: 'No OpenAI embedding key is saved' },
            createdOn: now,
          },
        ],
        now,
      ),
    ).toEqual({ state: 'failed', reason: 'No OpenAI embedding key is saved' })
    expect(backfillRunOf([], now)).toEqual({ state: 'idle' })
  })
})
