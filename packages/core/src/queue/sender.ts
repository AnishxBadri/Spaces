import { PgBoss } from 'pg-boss'
import type { ConstructorOptions } from 'pg-boss'
import type { QueueName } from './names'

/**
 * The sending half of the web→worker seam. A sender only ever *sends*: it
 * runs with maintenance, scheduling and migration off, so booting a web
 * process never competes with the worker over pg-boss housekeeping or races
 * it through a schema migration.
 *
 * It lives in @spaces/core so the app is not the only thing that can enqueue,
 * and it takes its connection string from the caller rather than reading it:
 * this package may not touch the environment (`src/purity.test.ts`), which
 * makes the adapter that does — `apps/web/src/lib/queue.ts` — the one place
 * DATABASE_URL is read for the queue.
 */

/**
 * The options every sender is constructed with. Exported so the three
 * housekeeping flags can be asserted rather than described: they are the
 * whole difference between a sender and the worker's own PgBoss instance.
 */
export function senderOptions(connectionString: string): ConstructorOptions {
  return {
    connectionString,
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    migrate: false,
  }
}

/**
 * What an enqueue may ask of pg-boss beyond the payload. `singletonKey` is
 * the only one so far (SPA-90): on a queue created with the `exclusive`
 * policy, a second job with the same key while one is queued or active is
 * not inserted and `send` answers `null`.
 */
export type EnqueueOptions = { singletonKey?: string }

/**
 * One job as a sender reads it back — the slice of pg-boss's
 * `JobWithMetadata` a status read needs. `output` is whatever the worker's
 * wrapper stored when it settled the job (`JobOutcome` in `run-job.ts`).
 */
export type QueuedJob = {
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'
  output: object | null
  createdOn: Date
  /**
   * When a queued job becomes eligible to run. pg-boss always answers it; a
   * test's fake may leave it out. SPA-136's backfill status reads it to tell
   * a run paused until the AI cap resets from one queued to run now.
   */
  startAfter?: Date
}

/**
 * The slice of pg-boss a sender uses. Named as an interface so a test can
 * hand `createSender` a client that records its construction options,
 * without the sender's own type widening to `unknown`.
 */
export interface QueueClient {
  on: (event: 'error', handler: (err: Error) => void) => unknown
  start: () => Promise<unknown>
  send: (
    name: string,
    data: Record<string, unknown>,
    options?: EnqueueOptions,
  ) => Promise<string | null>
  findJobs: (
    name: string,
    options: { key: string },
  ) => Promise<Array<QueuedJob>>
}

export type QueueClientFactory = (options: ConstructorOptions) => QueueClient

export type SenderConfig = {
  connectionString: string
  /** Defaults to a real PgBoss; the seam exists for the options assertion. */
  client?: QueueClientFactory
}

export type Sender = {
  /**
   * Enqueue, deliberately non-fatal to its caller: a resolved `null` when the
   * queue is unreachable, never a throw. A document row whose extraction never
   * got queued is a document you can still open and download; refusing the
   * upload because the worker is down is worse. The row keeps
   * extraction_status='pending' and can be re-queued.
   */
  enqueue: (
    queue: QueueName,
    data: Record<string, unknown>,
    options?: EnqueueOptions,
  ) => Promise<string | null>
  /**
   * The jobs on `queue` carrying `singletonKey = key`, any state; `null` when
   * the queue is unreachable — the same non-fatal answer `enqueue` gives.
   */
  jobsByKey: (queue: QueueName, key: string) => Promise<Array<QueuedJob> | null>
}

export function createSender(config: SenderConfig): Sender {
  const create: QueueClientFactory =
    config.client ?? ((options) => new PgBoss(options))

  let started: Promise<QueueClient> | null = null

  function connect(): Promise<QueueClient> {
    if (started) return started
    started = (async () => {
      const instance = create(senderOptions(config.connectionString))
      instance.on('error', (err: Error) =>
        console.error('[queue] pg-boss error', err),
      )
      await instance.start()
      return instance
    })().catch((err: unknown) => {
      // Don't cache a rejected promise — the next enqueue should retry the
      // connection rather than inherit a dead one forever.
      started = null
      throw err
    })
    return started
  }

  return {
    async enqueue(queue, data, options) {
      try {
        const client = await connect()
        return await (options === undefined
          ? client.send(queue, data)
          : client.send(queue, data, options))
      } catch (err) {
        console.error(`[queue] could not enqueue ${queue}`, err)
        return null
      }
    },
    async jobsByKey(queue, key) {
      try {
        return await (await connect()).findJobs(queue, { key })
      } catch (err) {
        console.error(`[queue] could not read ${queue}`, err)
        return null
      }
    },
  }
}
