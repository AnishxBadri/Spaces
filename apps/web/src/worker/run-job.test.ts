import { Clock, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JobWithMetadata } from 'pg-boss'
import {
  JobContext,
  JobPermanent,
  JobRateLimited,
  JobRetryable,
  runJob,
} from './run-job'
import type { JobDef, JobHost, JobOutcome, JobRunLedger } from './run-job'

/**
 * The wrapper's own tests. No Postgres: `runJob` settles through a JobHost,
 * so a fake host is the whole pg-boss surface it touches. That is the point —
 * hostability contract 2 says an uncaught throw past the wrapper kills the
 * container, and a claim like that has to be testable without a database.
 *
 * The `job_run` ledger is the second seam and is stubbed out the same way: a
 * `begin` that returns null is a ledger that is not there, which `runJob`
 * already has to survive. The rows themselves are asserted against a real
 * database in `run-job.ledger.test.ts`.
 */

const noLedger: JobRunLedger = {
  begin: async () => null,
  end: async () => undefined,
}

type Settlement =
  | { call: 'complete'; queue: string; jobId: string; output: JobOutcome }
  | { call: 'fail'; queue: string; jobId: string; output: JobOutcome }
  | { call: 'failTerminal'; queue: string; jobId: string; output: JobOutcome }
  | { call: 'send'; queue: string; data: object; startAfter: Date }

function fakeHost(): { host: JobHost; calls: Array<Settlement> } {
  const calls: Array<Settlement> = []
  return {
    calls,
    host: {
      complete: async (queue, jobId, output) => {
        calls.push({ call: 'complete', queue, jobId, output })
      },
      fail: async (queue, jobId, output) => {
        calls.push({ call: 'fail', queue, jobId, output })
      },
      failTerminal: async (queue, jobId, output) => {
        calls.push({ call: 'failTerminal', queue, jobId, output })
      },
      send: async (queue, data, startAfter) => {
        calls.push({ call: 'send', queue, data, startAfter })
      },
    },
  }
}

const epoch = new Date(0)

function fakeJob(
  id: string,
  data: object,
  retry?: { count: number; limit: number },
): JobWithMetadata<object> {
  return {
    id,
    name: 'test.queue',
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: retry?.limit ?? 2,
    retryCount: retry?.count ?? 0,
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

const schema = z.object({ n: z.number() })
type Data = z.infer<typeof schema>

function def(run: JobDef<Data>['run']): JobDef<Data> {
  return { name: 'test.queue', schema, run }
}

const nothing = Layer.empty

let errors: Array<unknown>
let warnings: Array<unknown>

beforeEach(() => {
  errors = []
  warnings = []
  vi.spyOn(console, 'error').mockImplementation((...args: Array<unknown>) => {
    errors.push(args.join(' '))
  })
  vi.spyOn(console, 'warn').mockImplementation((...args: Array<unknown>) => {
    warnings.push(args.join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runJob — batch resolution', () => {
  it('resolves each job in the batch and never rejects', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def((data) =>
        data.n === 2
          ? Effect.fail(new JobPermanent({ reason: 'middle one' }))
          : Effect.void,
      ),
      { host, layer: nothing, ledger: noLedger },
    )

    await expect(
      handler([
        fakeJob('a', { n: 1 }),
        fakeJob('b', { n: 2 }),
        fakeJob('c', { n: 3 }),
      ]),
    ).resolves.toBeUndefined()

    expect(
      calls.map((c) =>
        c.call === 'send' ? [c.call, c.queue] : [c.call, c.jobId],
      ),
    ).toEqual([
      ['complete', 'a'],
      ['failTerminal', 'b'],
      ['complete', 'c'],
    ])
  })
})

describe('runJob — schema', () => {
  it('fails data that does not match permanently, and logs the issue path', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def(() => Effect.die('the handler must never run')),
      { host, layer: nothing, ledger: noLedger },
    )

    await handler([fakeJob('bad', { n: 'twelve' })])

    expect(calls).toHaveLength(1)
    const settled = calls[0]
    expect(settled.call).toBe('failTerminal')
    if (settled.call !== 'failTerminal') throw new Error('unreachable')
    expect(settled.output.kind).toBe('invalid-data')
    expect(settled.output.reason).toContain('n: ')
    expect(errors.join('\n')).toContain('test.queue bad')
    expect(errors.join('\n')).toContain('n: ')
  })
})

describe('runJob — typed outcomes', () => {
  it('leaves JobRetryable to the queue by calling fail, not failTerminal', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def(() =>
        Effect.fail(new JobRetryable({ reason: 'blob not there yet' })),
      ),
      { host, layer: nothing, ledger: noLedger },
    )

    await handler([fakeJob('r', { n: 1 })])

    expect(calls).toEqual([
      {
        call: 'fail',
        queue: 'test.queue',
        jobId: 'r',
        output: {
          kind: 'retryable',
          queue: 'test.queue',
          attempt: 1,
          reason: 'blob not there yet',
        },
      },
    ])
  })

  it('re-sends a rate-limited job with startAfter and completes it', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def(() =>
        Effect.fail(
          new JobRateLimited({
            reason: 'Apollo said 429',
            retryAfterMs: 60_000,
          }),
        ),
      ),
      { host, layer: nothing, ledger: noLedger },
    )

    const before = Date.now()
    await handler([fakeJob('t', { n: 7 })])

    expect(calls.map((c) => c.call)).toEqual(['send', 'complete'])
    const sent = calls[0]
    if (sent.call !== 'send') throw new Error('unreachable')
    expect(sent.data).toEqual({ n: 7 })
    expect(sent.startAfter.getTime()).toBeGreaterThanOrEqual(before + 60_000)
    // Completed, not failed: a throttle must not burn the retry budget.
    const done = calls[1]
    if (done.call !== 'complete') throw new Error('unreachable')
    expect(done.output.kind).toBe('rate-limited')
  })

  it('fails a JobPermanent immediately, with no retry', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def(() => Effect.fail(new JobPermanent({ reason: 'unsupported mime' }))),
      { host, layer: nothing, ledger: noLedger },
    )

    await handler([fakeJob('p', { n: 1 }, { count: 0, limit: 5 })])

    expect(calls.map((c) => c.call)).toEqual(['failTerminal'])
  })
})

describe('runJob — defects', () => {
  it('catches a plain throw, logs it with the queue name, and fails permanently', async () => {
    const { host, calls } = fakeHost()
    const handler = runJob(
      def(() =>
        Effect.sync(() => {
          throw new Error('handler exploded')
        }),
      ),
      { host, layer: nothing, ledger: noLedger },
    )

    // Resolving rather than rejecting is the assertion: a rejecting batch
    // handler fails the whole batch, and a throw past the wrapper is a
    // container death (hostability contract 2).
    await expect(handler([fakeJob('d', { n: 1 })])).resolves.toBeUndefined()

    expect(calls.map((c) => c.call)).toEqual(['failTerminal'])
    const settled = calls[0]
    if (settled.call !== 'failTerminal') throw new Error('unreachable')
    expect(settled.output.kind).toBe('defect')
    expect(settled.output.reason).toBe('handler exploded')
    expect(errors.join('\n')).toContain('test.queue d: defect on attempt 1')
  })
})

describe('runJob — JobContext', () => {
  it('provides attempt and isFinalAttempt from what pg-boss already retried', async () => {
    const seen: Array<{ attempt: number; isFinalAttempt: boolean }> = []
    const { host } = fakeHost()
    const handler = runJob(
      def(() =>
        Effect.gen(function* () {
          const ctx = yield* JobContext
          seen.push({
            attempt: ctx.attempt,
            isFinalAttempt: ctx.isFinalAttempt,
          })
        }),
      ),
      { host, layer: nothing, ledger: noLedger },
    )

    await handler([
      fakeJob('first', { n: 1 }, { count: 0, limit: 2 }),
      fakeJob('retried', { n: 1 }, { count: 1, limit: 2 }),
      fakeJob('last', { n: 1 }, { count: 2, limit: 2 }),
    ])

    expect(seen).toEqual([
      { attempt: 1, isFinalAttempt: false },
      { attempt: 2, isFinalAttempt: false },
      { attempt: 3, isFinalAttempt: true },
    ])
  })
})

describe('runJob — timeout', () => {
  it('interrupts a handler that outlives def.timeout and retries the job', async () => {
    const clock = await Effect.runPromise(Effect.scoped(TestClock.make()))
    const { host, calls } = fakeHost()
    let finished = false

    const slow: JobDef<Data> = {
      name: 'test.queue',
      schema,
      timeout: '30 seconds',
      run: () =>
        Effect.gen(function* () {
          yield* Effect.sleep('10 minutes')
          finished = true
        }),
    }

    const handler = runJob(slow, {
      host,
      layer: Layer.succeed(Clock.Clock, clock),
      ledger: noLedger,
    })

    const promise = handler([fakeJob('slow', { n: 1 })])

    // No real sleeping: hand the loop back so the timeout registers its sleep
    // on the test clock, then move the clock past it. 10 x 5s clears the 30s
    // timeout with room to spare, and adjusting a settled clock is a no-op.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      await Effect.runPromise(clock.adjust('5 seconds'))
    }
    await promise

    expect(finished).toBe(false)
    expect(calls.map((c) => c.call)).toEqual(['fail'])
    const settlement = calls[0]
    if (settlement.call !== 'fail') throw new Error('unreachable')
    expect(settlement.output.kind).toBe('retryable')
    expect(settlement.output.reason).toContain('timeout')
  })
})

describe('runJob — a host that itself fails', () => {
  it('logs and returns rather than rejecting the batch', async () => {
    const exploding: JobHost = {
      complete: () => Promise.reject(new Error('postgres went away')),
      fail: () => Promise.reject(new Error('postgres went away')),
      failTerminal: () => Promise.reject(new Error('postgres went away')),
      send: () => Promise.reject(new Error('postgres went away')),
    }
    const handler = runJob(
      def(() => Effect.void),
      {
        host: exploding,
        layer: nothing,
        ledger: noLedger,
      },
    )

    await expect(handler([fakeJob('h', { n: 1 })])).resolves.toBeUndefined()
    expect(errors.join('\n')).toContain('could not resolve the job')
    expect(warnings).toEqual([])
  })
})
