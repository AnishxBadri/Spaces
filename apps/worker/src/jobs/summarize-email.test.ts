import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { QUEUES } from '@spaces/core/queue/names'
import {
  runSummarizeEmail,
  runSummarizeEmailBackfill,
  summarizeEmail,
  summarizeEmailBackfill,
  summarizeEmailData,
} from './summarize-email'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The wrapper's view of an email's summary job and its backfill (D67). The
 * programs' behaviour is `summarizeEmail`'s own suite in apps/web; this holds
 * the jobs to their queues and their outcomes.
 */
describe('interaction.summarize-email', () => {
  it('completes, writing nothing, for an email that is gone', async () => {
    await expect(
      Effect.runPromise(runSummarizeEmail({ interactionId: randomUUID() })),
    ).resolves.toBeUndefined()
  })

  it('names its queue, takes one interaction id, and retries a provider outage', () => {
    expect(summarizeEmail.name).toBe(QUEUES.summarizeEmail)
    expect(summarizeEmail.retry?.limit).toBe(2)
    expect(summarizeEmailData.safeParse({}).success).toBe(false)
    expect(
      summarizeEmailData.safeParse({ interactionId: randomUUID() }).success,
    ).toBe(true)
  })
})

describe('interaction.summarize-backfill', () => {
  it('completes over a mailbox with nothing to fill, and never retries', async () => {
    await expect(
      Effect.runPromise(runSummarizeEmailBackfill({})),
    ).resolves.toBeUndefined()
    expect(summarizeEmailBackfill.name).toBe(QUEUES.summarizeEmailBackfill)
    expect(summarizeEmailBackfill.retry?.limit).toBe(0)
  })
})
