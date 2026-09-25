import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { JobPermanent } from '../run-job'
import {
  extractKeyTerms,
  extractKeyTermsData,
  runExtractKeyTerms,
} from './extract-key-terms'

/**
 * SPA-91, the wrapper's view. The program's own behaviour is
 * `lib/ai/key-terms.test.ts`; this holds the job to the deck reader's
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
      extractKeyTermsData.safeParse({ documentId: randomUUID() }).success,
    ).toBe(false)
    expect(
      extractKeyTermsData.safeParse({ documentId: randomUUID(), userId: 'u' })
        .success,
    ).toBe(true)
  })
})
