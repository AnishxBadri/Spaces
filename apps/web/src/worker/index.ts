import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { requireEnv } from '#/lib/server/env'
import { QUEUES } from '@spaces/core/queue/names'
import { startHeartbeat, workerIdentity } from './heartbeat'
import { pgBossHost, runJob } from './run-job'
import { ExtractionStore, extractDocument } from './jobs/extract-document'

/**
 * The worker process. Second process in the app container (or run locally
 * with `pnpm worker`). pg-boss keeps its state in Postgres — no Redis.
 *
 * Handlers are stubs until their features land; registering the queues now
 * pins the seam so web-side code can enqueue from day one. Real jobs go
 * through `runJob` (./run-job.ts) — one wrapper, typed outcomes, and a
 * promise that never rejects, because a rejecting batch handler fails the
 * whole batch and an uncaught throw past it is a container death.
 */

async function main() {
  const boss = new PgBoss({
    connectionString: requireEnv('DATABASE_URL'),
    schema: 'pgboss',
  })

  boss.on('error', (err: Error) => console.error('[worker] pg-boss error', err))

  await boss.start()
  console.log('[worker] pg-boss started')

  const host = pgBossHost(boss)

  const stub = (label: string) => async (jobs: Array<Job>) => {
    for (const job of jobs) console.log(`[worker] ${label} (stub)`, job.id)
  }

  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue).catch(() => {}) // idempotent across boots
  }

  // JobDef.retry is the queue's policy, not the wrapper's: JobRetryable just
  // fails the job and lets pg-boss count. updateQueue is how it reaches a
  // queue row that createQueue already created on an earlier boot.
  const retry = extractDocument.retry
  if (retry) {
    await boss.updateQueue(extractDocument.name, {
      retryLimit: retry.limit,
      retryDelay: retry.delaySeconds,
      retryBackoff: retry.backoff,
    })
  }

  // Extraction is the CPU-bound one: a whole batch on one tick would block
  // this process the way inline extraction would block the web one.
  // includeMetadata is what gives JobContext its attempt / isFinalAttempt.
  await boss.work(
    QUEUES.extractDocument,
    { batchSize: 1, includeMetadata: true },
    runJob(extractDocument, { host, layer: ExtractionStore.layer }),
  )
  await boss.work(QUEUES.embedDocument, stub('document.embed'))
  await boss.work(QUEUES.dedupeSweep, stub('entity.dedupe-sweep'))
  await boss.work(QUEUES.enrichEntity, stub('entity.enrich'))

  // Nightly dedupe sweep at 03:30.
  await boss.schedule(QUEUES.dedupeSweep, '30 3 * * *', undefined, {
    tz: 'Etc/UTC',
  })

  // The heartbeat (SPA-57). Last, so the row only appears once this process
  // is actually working queues — a row written before `boss.work` would claim
  // a worker that is not one yet.
  const identity = workerIdentity()
  const heartbeat = startHeartbeat(identity)
  await heartbeat.booted
  console.log(
    `[worker] heartbeat: role '${identity.role}' instance '${identity.instance}' pid ${String(identity.pid)}`,
  )

  const shutdown = async () => {
    console.log('[worker] shutting down')
    // Stop beating, but leave the row: staleness is the signal, so a graceful
    // stop still tells the operator when this worker last beat.
    heartbeat.stop()
    await boss.stop({ graceful: true, timeout: 15000 })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err) => {
  console.error('[worker] fatal', err)
  process.exit(1)
})
