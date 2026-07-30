import { PgBoss } from 'pg-boss'
import type { QueueName } from '#/worker/queues'

/**
 * The web side of the web→worker seam. The web process only ever *sends*:
 * a sender instance runs with maintenance, scheduling and migration off, so
 * booting the app never competes with the worker over pg-boss housekeeping
 * or races it through a schema migration.
 *
 * Enqueue failure is deliberately non-fatal to its caller. A document row
 * whose extraction never got queued is a document you can still open and
 * download; refusing the upload because the worker is down is worse. The
 * row keeps extraction_status='pending' and can be re-queued.
 */

let sender: Promise<PgBoss> | null = null

function boss(): Promise<PgBoss> {
  if (sender) return sender
  sender = (async () => {
    const instance = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      migrate: false,
    })
    instance.on('error', (err: Error) =>
      console.error('[queue] pg-boss error', err),
    )
    await instance.start()
    return instance
  })().catch((err) => {
    // Don't cache a rejected promise — the next enqueue should retry the
    // connection rather than inherit a dead one forever.
    sender = null
    throw err
  })
  return sender
}

export async function enqueue(
  queue: QueueName,
  data: Record<string, unknown>,
): Promise<string | null> {
  try {
    return await (await boss()).send(queue, data)
  } catch (err) {
    console.error(`[queue] could not enqueue ${queue}`, err)
    return null
  }
}
