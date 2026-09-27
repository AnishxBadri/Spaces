import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { JobPermanent } from '../run-job'
import { readDeck, readDeckData, runReadDeck } from './read-deck'

/**
 * SPA-90, the wrapper's view. The program's own behaviour is
 * `lib/ai/read-deck.test.ts`; this holds the job to its contract: every
 * failure ends the job permanently with the program's sentence as its
 * reason, and pg-boss is never asked to retry a model call.
 */
describe('document.read-deck', () => {
  it('fails permanently with the failure’s sentence', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(runReadDeck({ documentId: randomUUID(), userId: 'someone' })),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe('That document is gone')
  })

  it('fails a chained read permanently with the step’s sentence (SPA-100)', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runReadDeck({
          documentId: randomUUID(),
          userId: 'someone',
          summarizeOnto: randomUUID(),
        }),
      ),
    )
    expect(failure).toBeInstanceOf(JobPermanent)
    expect(failure.reason).toBe('That record is gone')
  })

  it('never retries, and carries who pressed', () => {
    expect(readDeck.retry?.limit).toBe(0)
    expect(readDeckData.safeParse({ documentId: randomUUID() }).success).toBe(
      false,
    )
    // Read deck and summarize: the same job, with the summary's record.
    expect(
      readDeckData.safeParse({
        documentId: randomUUID(),
        userId: 'someone',
        summarizeOnto: randomUUID(),
      }).success,
    ).toBe(true)
  })
})
