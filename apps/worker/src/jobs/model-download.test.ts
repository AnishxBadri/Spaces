import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import { jobRun, workspace } from '@spaces/db/schema'
import { LOCAL_EMBEDDING_MODELS } from '@spaces/core/ai/local-model'
import {
  localModelDir,
  localModelPresent,
} from '@spaces/core/writes/ai/local-model-files'
import { QUEUES } from '@spaces/core/queue/names'
import {
  pinEmbeddingProgram,
  setSensitiveSlotProgram,
} from '#web/lib/ai/embedding-pin'
import { saveEmbeddingKeyProgram } from '#web/lib/ai/providers/embed/settings'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { JobContext, runJob } from '../run-job'
import type { JobFailure, JobHost, JobOutcome } from '../run-job'
import { makeLocalModelHost } from '../local-model/host'
import { copyModelByHand, fakeLoader } from '../local-model/testing'
import { modelDownload, runModelDownload } from './model-download'
import { modelTest, runModelTest } from './model-test'

/**
 * model.download and model.test (D50) against a fake loader and a scratch
 * DATA_DIR: nothing leaves the box, and the model's files are the fake's.
 * The download's progress is read from its `job_run` row mid-run, as the
 * settings section reads it.
 */
vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const SPEC = LOCAL_EMBEDDING_MODELS[0]
const MODEL = SPEC.id

let dataDir = ''
const savedDataDir = process.env.DATA_DIR

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'spaces-download-'))
  process.env.DATA_DIR = dataDir
})

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  await rm(dataDir, { recursive: true, force: true })
})

/** Runs a job body with a JobContext whose progress lines are recorded. */
function withContext(
  effect: Effect.Effect<string, JobFailure, JobContext>,
  lines: Array<string>,
) {
  return Effect.runPromise(
    Effect.result(
      Effect.provideService(
        effect,
        JobContext,
        JobContext.of({
          queue: 'test',
          jobId: randomUUID(),
          attempt: 1,
          isFinalAttempt: true,
          progress: (line) => Effect.sync(() => void lines.push(line)),
        }),
      ),
    ),
  )
}

describe('model.download', () => {
  it('downloads the files into <dataDir>/models with progress, and a second click fetches nothing', async () => {
    const fake = fakeLoader()
    const host = makeLocalModelHost({ load: fake.load })
    const lines: Array<string> = []

    const first = await withContext(
      runModelDownload(host, { model: MODEL }),
      lines,
    )
    expect(first).toMatchObject({ _tag: 'Success' })
    if (first._tag === 'Success')
      expect(first.success).toBe(
        `${MODEL} · downloaded to ${localModelDir(SPEC)}`,
      )
    expect(localModelDir(SPEC).startsWith(join(dataDir, 'models'))).toBe(true)
    expect(await localModelPresent(SPEC)).toBe(true)
    expect(lines.at(0)).toMatch(/^downloading · \d+ of \d+ MB$/)

    const second = await withContext(
      runModelDownload(host, { model: MODEL }),
      lines,
    )
    if (second._tag === 'Success')
      expect(second.success).toMatch(/nothing to download$/)
    expect(fake.counts.loads).toBe(1)
    await Effect.runPromise(host.dispose())
  })

  it('a dropped download is retryable, and the retry fetches only the files still missing', async () => {
    const fake = fakeLoader({ failFirstDownloadAfter: 2 })
    const host = makeLocalModelHost({ load: fake.load })

    const dropped = await withContext(
      runModelDownload(host, { model: MODEL }),
      [],
    )
    expect(dropped).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'JobRetryable' },
    })
    expect(await localModelPresent(SPEC)).toBe(false)

    const resumed = await withContext(
      runModelDownload(host, { model: MODEL }),
      [],
    )
    expect(resumed).toMatchObject({ _tag: 'Success' })
    expect(await localModelPresent(SPEC)).toBe(true)
    // Each file was written once: the retry kept the two finished before.
    expect(fake.counts.written).toEqual([...SPEC.files])
    await Effect.runPromise(host.dispose())
  })

  it('finds a model directory copied by hand and downloads nothing', async () => {
    await copyModelByHand(SPEC)
    const fake = fakeLoader()
    const host = makeLocalModelHost({ load: fake.load })

    const r = await withContext(runModelDownload(host, { model: MODEL }), [])

    expect(r).toMatchObject({ _tag: 'Success' })
    if (r._tag === 'Success') expect(r.success).toMatch(/on disk at .*nothing/)
    expect(fake.counts.loads).toBe(0)
  })

  it('writes its progress to the running job_run row, then closes it with its summary', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached: () => void = () => undefined
    const atGate = new Promise<void>((resolve) => {
      reached = resolve
    })
    const fake = fakeLoader({
      midDownload: async () => {
        reached()
        await gate
      },
    })
    const host = makeLocalModelHost({ load: fake.load })
    const settled: Array<JobOutcome> = []
    const note = async (_q: string, _id: string, o: JobOutcome) => {
      settled.push(o)
    }
    const jobHost: JobHost = {
      complete: note,
      fail: note,
      failTerminal: note,
      send: async () => undefined,
    }
    const handler = runJob(modelDownload(host), {
      host: jobHost,
      layer: Layer.empty,
    })
    const running = handler([fakeJob({ model: MODEL })])

    await atGate
    // The first report lands at 0 bytes; give its write a moment.
    let summary: string | null = null
    for (let i = 0; i < 50 && summary === null; i += 1) {
      const row = (
        await db
          .select({ status: jobRun.status, summary: jobRun.summary })
          .from(jobRun)
          .where(eq(jobRun.queue, QUEUES.modelDownload))
          .orderBy(desc(jobRun.startedAt))
          .limit(1)
      ).at(0)
      if (row?.status === 'running') summary = row.summary
      if (summary === null) await new Promise((r) => setTimeout(r, 20))
    }
    expect(summary).toMatch(/^downloading · 0 of \d+ MB$/)

    release()
    await running
    const closed = (
      await db
        .select({ status: jobRun.status, summary: jobRun.summary })
        .from(jobRun)
        .where(eq(jobRun.queue, QUEUES.modelDownload))
    ).at(0)
    expect(closed).toEqual({
      status: 'succeeded',
      summary: `${MODEL} · downloaded to ${localModelDir(SPEC)}`,
    })
    expect(settled.map((o) => o.kind)).toEqual(['completed'])
    await Effect.runPromise(host.dispose())
  })
})

describe('model.test', () => {
  it('embeds one word in the worker: 768 wide, and the first run says it loaded the model', async () => {
    await copyModelByHand(SPEC)
    const fake = fakeLoader({ requireFiles: true })
    const host = makeLocalModelHost({ load: fake.load })
    const lines: Array<string> = []

    const first = await withContext(runModelTest(host, { model: MODEL }), lines)
    const second = await withContext(runModelTest(host, { model: MODEL }), [])

    expect(lines).toEqual(['the first run loads the model — a few seconds'])
    expect(first._tag === 'Success' && first.success).toMatch(
      new RegExp(
        `^${MODEL} · 768 dims · \\[.*, …\\] · \\d+ ms · loaded the model$`,
      ),
    )
    expect(second._tag === 'Success' && second.success).not.toMatch(/loaded/)
    expect(fake.counts.loads).toBe(1)
    await Effect.runPromise(host.dispose())
  })

  it('a green Test through the wrapper is what the sensitive slot is offered on', async () => {
    await copyModelByHand(SPEC)
    await db
      .insert(workspace)
      .values({ id: 1, name: 'Fund', settings: {} })
      .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
    await Effect.runPromise(
      saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, {
        provider: 'openai',
        key: 'sk-test-local-slot',
      }),
    )
    await Effect.runPromise(
      pinEmbeddingProgram({
        provider: 'openai',
        model: 'text-embedding-3-small',
      }),
    )
    const slot = { provider: 'local' as const, model: MODEL }

    const untested = await Effect.runPromise(
      Effect.result(setSensitiveSlotProgram(slot)),
    )
    expect(untested).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SlotRefused' },
    })

    const host = makeLocalModelHost({
      load: fakeLoader({ requireFiles: true }).load,
    })
    const noop = async () => undefined
    await runJob(modelTest(host), {
      host: { complete: noop, fail: noop, failTerminal: noop, send: noop },
      layer: Layer.empty,
    })([fakeJob({ model: MODEL }, QUEUES.modelTest)])

    const set = await Effect.runPromise(setSensitiveSlotProgram(slot))
    expect(set).toMatchObject({ provider: 'local', model: MODEL, dims: 768 })
    await Effect.runPromise(host.dispose())
  })

  it('refuses before the model is downloaded', async () => {
    const host = makeLocalModelHost({ load: fakeLoader().load })
    const r = await withContext(runModelTest(host, { model: MODEL }), [])
    expect(r).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'JobPermanent' },
    })
  })
})

const epoch = new Date(0)

function fakeJob(
  data: object,
  queue: string = QUEUES.modelDownload,
): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 3,
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
    policy: 'exclusive',
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
