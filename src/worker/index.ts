import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { QUEUES } from './queues'
import { extractDocument } from './jobs/extract-document'

/**
 * The worker process. Second process in the app container (or run locally
 * with `pnpm worker`). pg-boss keeps its state in Postgres — no Redis.
 *
 * Handlers are stubs until their features land; registering the queues now
 * pins the seam so web-side code can enqueue from day one.
 */

async function main() {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: 'pgboss',
  })

  boss.on('error', (err: Error) => console.error('[worker] pg-boss error', err))

  await boss.start()
  console.log('[worker] pg-boss started')

  const stub = (label: string) => async (jobs: Array<Job>) => {
    for (const job of jobs) console.log(`[worker] ${label} (stub)`, job.id)
  }

  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue).catch(() => {}) // idempotent across boots
  }

  // Extraction is the CPU-bound one: a whole batch on one tick would block
  // this process the way inline extraction would block the web one.
  await boss.work(
    QUEUES.extractDocument,
    { batchSize: 1 },
    async (jobs: Array<Job>) => {
      for (const job of jobs) await extractDocument(job.data)
    },
  )
  await boss.work(QUEUES.embedDocument, stub('document.embed'))
  await boss.work(QUEUES.dedupeSweep, stub('entity.dedupe-sweep'))
  await boss.work(QUEUES.enrichEntity, stub('entity.enrich'))

  // Nightly dedupe sweep at 03:30.
  await boss.schedule(QUEUES.dedupeSweep, '30 3 * * *', undefined, {
    tz: 'Etc/UTC',
  })

  const shutdown = async () => {
    console.log('[worker] shutting down')
    await boss.stop({ graceful: true, timeout: 15000 })
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('[worker] fatal', err)
  process.exit(1)
})
