import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { JobPermanent } from '../run-job'
import { runSummarize, summarize, summarizeData } from './summarize'

/**
 * SPA-66, the wrapper's view. The program's own behaviour is
 * `lib/ai/summarize.test.ts`; this holds the job to the deck reader's
 * contract: every failure ends the job permanently with the program's
 * sentence as its reason, and pg-boss never retries a frontier call.
 */
describe('entity.summarize', () => {
  it('fails permanently with the failure’s sentence', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runSummarize({
          recordId: randomUUID(),
          documentId: null,
          userId: 'someone',
        }),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe('That record is gone')
  })

  it('never retries, and carries who pressed and what', () => {
    expect(summarize.retry?.limit).toBe(0)
    expect(summarizeData.safeParse({ recordId: randomUUID() }).success).toBe(
      false,
    )
    expect(
      summarizeData.safeParse({
        recordId: randomUUID(),
        documentId: null,
        userId: 'u',
      }).success,
    ).toBe(true)
  })
})
