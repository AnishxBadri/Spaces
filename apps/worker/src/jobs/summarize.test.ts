import { randomUUID } from 'node:crypto'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData } from '../job-data'
import { JobPermanent } from '../run-job'
import { runSummarize, summarize, summarizeData } from './summarize'

/**
 * The wrapper's view. The program's own behaviour is apps/web's summarize
 * suite; this holds the job to the deck reader's
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
    expect(
      Result.isSuccess(
        decodeJobData(summarizeData, { recordId: randomUUID() }),
      ),
    ).toBe(false)
    expect(
      Result.isSuccess(
        decodeJobData(summarizeData, {
          recordId: randomUUID(),
          documentId: null,
          userId: 'u',
        }),
      ),
    ).toBe(true)
  })
})
