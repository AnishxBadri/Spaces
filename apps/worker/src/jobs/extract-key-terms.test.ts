import { randomUUID } from 'node:crypto'
import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeJobData } from '../job-data'
import { JobPermanent } from '../run-job'
import {
  extractKeyTerms,
  extractKeyTermsData,
  runExtractKeyTerms,
} from './extract-key-terms'

/**
 * The wrapper's view. The program's own behaviour is apps/web's key-terms
 * suite; this holds the job to the deck reader's
 * contract: every failure ends the job permanently with the program's
 * sentence as its reason, and pg-boss never retries a model call.
 */
describe('document.key-terms', () => {
  it('fails permanently with the failure’s sentence', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runExtractKeyTerms({ documentId: randomUUID(), userId: 'someone' }),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe('That document is gone')
  })

  it('never retries, and carries who pressed and what', () => {
    expect(extractKeyTerms.retry?.limit).toBe(0)
    expect(
      Result.isSuccess(
        decodeJobData(extractKeyTermsData, { documentId: randomUUID() }),
      ),
    ).toBe(false)
    expect(
      Result.isSuccess(
        decodeJobData(extractKeyTermsData, {
          documentId: randomUUID(),
          userId: 'u',
        }),
      ),
    ).toBe(true)
  })
})
