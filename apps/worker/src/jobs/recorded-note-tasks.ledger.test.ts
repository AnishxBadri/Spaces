import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import type { JobHost, JobOutcome } from '../run-job'

/**
 * A write-up is read for action items once: the row `runJob` writes for a
 * finished read is what a later close of the note window looks for, so the
 * two are proved together here, where the ledger has its writer.
 *
 * Everything is imported dynamically: `@spaces/db` builds its pool from
 * `process.env.DATABASE_URL` at import time, and `vitest.setup.ts` rewrites
 * that to this worker's database before the file runs.
 */

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const epoch = new Date(0)

function fakeJob(queue: string, data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}

function silentHost(): JobHost {
  const noop = async (_q: string, _id: string, _o: JobOutcome) => undefined
  return {
    complete: noop,
    fail: noop,
    failTerminal: noop,
    send: async () => undefined,
  }
}

describe("a write-up's action items", () => {
  it('are not queued again once a read of the note has finished, even one that found nothing', async () => {
    const { runJob } = await import('../run-job')
    const { recordedNoteTasks } = await import('./recorded-note-tasks')
    const { db } = await import('@spaces/db')
    const { interactionEntity } = await import('@spaces/db/schema')
    const { callTag, flent, founderCall } =
      await import('#web/test/recorded-note')
    const { enqueued } = await import('#web/test/queue-stub')
    const { writeUpInteractionProgram } =
      await import('#web/lib/interactions/write-up')
    const { writeUpClosedProgram } =
      await import('#web/lib/ai/write-up-action-items')
    const { FIXTURE_ACTOR } = await import('../../vitest.seed')

    const tag = callTag()
    const company = await flent(tag)
    const meeting = await founderCall(tag, new Date(Date.now() - 86_400_000))
    await db
      .insert(interactionEntity)
      .values({ interactionId: meeting, entityId: company })
    const { noteId } = await Effect.runPromise(
      writeUpInteractionProgram(FIXTURE_ACTOR.id, meeting),
    )

    // The job as it is declared, with a body that reads nothing: the run it
    // leaves is a finished read that found no action items.
    const handler = runJob(
      { ...recordedNoteTasks, run: () => Effect.void },
      { host: silentHost(), layer: Layer.empty },
    )
    await handler([
      fakeJob(recordedNoteTasks.name, { interactionId: meeting, noteId }),
    ])

    const before = enqueued.length
    expect(await Effect.runPromise(writeUpClosedProgram(noteId))).toEqual({
      queued: false,
    })
    expect(enqueued).toHaveLength(before)
  })
})
