import { Effect } from 'effect'
import { count } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { askThread, askTurn } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import type * as RunModule from '#/lib/ai/run'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

vi.mock('#/lib/ai/run', async (original) => {
  const real = await original<typeof RunModule>()
  return {
    ...real,
    openRunProgram: () =>
      Effect.fail(new real.RunWriteFailed({ cause: 'the run log is down' })),
  }
})

const { askEvents } = await import('./turn')

/** A turn whose run cannot be recorded writes nothing. (D70) */
describe('beginning a turn', () => {
  it('leaves no thread and no answerless question when the ai_run insert fails', async () => {
    const events = askEvents({
      userId: FIXTURE_ACTOR.id,
      threadId: null,
      question: 'anything',
      scope: [],
    })
    await expect(events.next()).rejects.toBeDefined()
    expect(await db.select({ n: count() }).from(askThread)).toEqual([{ n: 0 }])
    expect(await db.select({ n: count() }).from(askTurn)).toEqual([{ n: 0 }])
  })
})
