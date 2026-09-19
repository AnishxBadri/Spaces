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
 * The slice of pg-boss a sender uses, which is all three methods of it. Named
 * as an interface so a test can hand `createSender` a client that records its
 * construction options, without the sender's own type widening to `unknown`.
 */
export interface QueueClient {
  on: (event: 'error', handler: (err: Error) => void) => unknown
  start: () => Promise<unknown>
  send: (name: string, data: Record<string, unknown>) => Promise<string | null>
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
  ) => Promise<string | null>
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
    async enqueue(queue, data) {
      try {
        return await (await connect()).send(queue, data)
      } catch (err) {
        console.error(`[queue] could not enqueue ${queue}`, err)
        return null
      }
    },
  }
}
