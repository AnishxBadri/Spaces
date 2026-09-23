import { Layer } from 'effect'
import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { requireEnv } from '#/lib/server/env'
import { QUEUES } from '@spaces/core/queue/names'
import { startHeartbeat, workerIdentity } from './heartbeat'
import { pgBossHost, runJob } from './run-job'
import { ExtractionStore, extractDocument } from './jobs/extract-document'
import { clipDocument } from './jobs/clip-document'
import { dedupeSweep } from './jobs/dedupe-sweep'
import { sweepOrphanBlobs } from './jobs/sweep-orphan-blobs'
import { readDeck } from './jobs/read-deck'
import { embedDocument } from './jobs/embed-document'
import { embedSource } from './jobs/embed-source'
import { embedBackfill, embedBackfillRetry } from './jobs/embed-backfill'

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

  // The deck reader's queue is `exclusive` (SPA-90): with `singletonKey` set
  // to the document id, pg-boss refuses a second job for a deck while one is
  // queued or active. Created before the loop below, whose plain create would
  // otherwise make it `standard` first; a queue's policy is fixed at create.
  await boss
    .createQueue(QUEUES.readDeck, { policy: 'exclusive' })
    .catch(() => {})
  // Notes and embeddable attributes → chunks (SPA-132): `document.embed`'s
  // replace-stamp-embed for the sources that are not documents. One block,
  // before the plain create loop below, because the queue must be born
  // `stately` — one queued and one active per `singletonKey` — so a burst of
  // note autosaves is one queued job that reads the latest body when it runs.
  await boss
    .createQueue(QUEUES.embedSource, { policy: 'stately' })
    .catch(() => {})
  if (embedSource.retry)
    await boss.updateQueue(QUEUES.embedSource, {
      retryLimit: embedSource.retry.limit,
      retryDelay: embedSource.retry.delaySeconds,
      retryBackoff: embedSource.retry.backoff,
    })
  await boss.work(
    QUEUES.embedSource,
    { batchSize: 1, includeMetadata: true },
    runJob(embedSource, { host, layer: Layer.empty }),
  )
  // The corpus backfill (SPA-136): `exclusive` with one fixed singletonKey,
  // so one run is queued, active or paused for the AI cap at a time — and it
  // is created here, before the loop below, for the same reason as the deck
  // reader's. A run can take hours, so the 15-minute default expiry is
  // replaced by a heartbeat: pg-boss refreshes it while the handler runs and
  // retries the job within a minute of a dead worker, and the resumed run
  // skips every chunk already on the pin. Batch of one; no Layer — its I/O
  // is `db` and `embed()`.
  await boss
    .createQueue(QUEUES.embedBackfill, {
      policy: 'exclusive',
      expireInSeconds: 24 * 60 * 60,
      heartbeatSeconds: 60,
      retryLimit: embedBackfillRetry.limit,
      retryDelay: embedBackfillRetry.delaySeconds,
      retryBackoff: embedBackfillRetry.backoff,
    })
    .catch(() => {})
  await boss.work(
    QUEUES.embedBackfill,
    { batchSize: 1, includeMetadata: true },
    runJob(embedBackfill, { host, layer: Layer.empty }),
  )
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue).catch(() => {}) // idempotent across boots
  }

  // JobDef.retry is the queue's policy, not the wrapper's: JobRetryable just
  // fails the job and lets pg-boss count. updateQueue is how it reaches a
  // queue row that createQueue already created on an earlier boot.
  for (const def of [extractDocument, embedDocument, clipDocument, readDeck]) {
    const retry = def.retry
    if (retry) {
      await boss.updateQueue(def.name, {
        retryLimit: retry.limit,
        retryDelay: retry.delaySeconds,
        retryBackoff: retry.backoff,
      })
    }
  }

  // Extraction is the CPU-bound one: a whole batch on one tick would block
  // this process the way inline extraction would block the web one.
  // includeMetadata is what gives JobContext its attempt / isFinalAttempt.
  await boss.work(
    QUEUES.extractDocument,
    { batchSize: 1, includeMetadata: true },
    runJob(extractDocument, { host, layer: ExtractionStore.layer }),
  )
  // Chunking + embedding (SPA-121), enqueued by extraction once the text is
  // stored. Runs with or without an embedding pin — no pin writes chunks
  // with null vectors for the lexical lane. Batch of one: a document's
  // embed calls are one provider's latency, and two in series on one tick
  // would be two. No Layer — its I/O is `db` and `embed()`.
  await boss.work(
    QUEUES.embedDocument,
    { batchSize: 1, includeMetadata: true },
    runJob(embedDocument, { host, layer: Layer.empty }),
  )
  // The URL clip (SPA-117). `clipUrlProgram` wrote the row and returned
  // before any network call; this is the half that actually goes out and
  // fetches, which is why it is on the worker at all — a page that takes
  // thirty seconds must not be thirty seconds of somebody's request. Batch of
  // one, because a batch of pages fetched on one tick is a batch of timeouts
  // sharing a process; includeMetadata is what `runJob` reads
  // retryCount/retryLimit from, and the job carries no Layer — its I/O is
  // `db` and one guarded `fetch`.
  await boss.work(
    QUEUES.clipDocument,
    { batchSize: 1, includeMetadata: true },
    runJob(clipDocument, { host, layer: Layer.empty }),
  )
  // The nightly sweep (SPA-81), second tenant of the wrapper and the queue
  // the 03:30 schedule below has been firing into a stub since it was
  // registered. One statement per run, so the default batch of one is right;
  // includeMetadata is what `runJob` reads retryCount/retryLimit from, and
  // the job itself carries no Layer — its whole I/O is that statement.
  await boss.work(
    QUEUES.dedupeSweep,
    { includeMetadata: true },
    runJob(dedupeSweep, { host, layer: Layer.empty }),
  )
  await boss.work(QUEUES.enrichEntity, stub('entity.enrich'))
  // The deck reader (SPA-90). A model call per filed record, so a batch of
  // one: two decks on one tick would be two providers' latency in series.
  await boss.work(
    QUEUES.readDeck,
    { batchSize: 1, includeMetadata: true },
    runJob(readDeck, { host, layer: Layer.empty }),
  )
  // The orphan-blob sweep (SPA-54), registered exactly as the dedupe sweep
  // above: one statement's worth of work per candidate, so the default batch
  // of one is right, and includeMetadata is what `runJob` reads
  // retryCount/retryLimit from. No Layer — its I/O is `db` and `storage()`.
  await boss.work(
    QUEUES.sweepOrphanBlobs,
    { includeMetadata: true },
    runJob(sweepOrphanBlobs, { host, layer: Layer.empty }),
  )

  // Nightly dedupe sweep at 03:30.
  await boss.schedule(QUEUES.dedupeSweep, '30 3 * * *', undefined, {
    tz: 'Etc/UTC',
  })

  // And the orphan-blob sweep at 04:10 — after the dedupe sweep rather than
  // beside it, so the two nightly scans never contend for the same tick on a
  // single-worker self-host.
  await boss.schedule(QUEUES.sweepOrphanBlobs, '10 4 * * *', undefined, {
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
