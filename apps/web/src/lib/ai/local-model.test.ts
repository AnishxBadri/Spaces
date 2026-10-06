import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { workspace } from '@spaces/db/schema'
import { LOCAL_EMBEDDING_MODELS } from '@spaces/core/ai/local-model'
import { localModelDir } from '@spaces/core/writes/ai/local-model-files'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueued } from '#/test/queue-stub'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { pinEmbeddingProgram } from './embedding-pin'
import {
  startLocalModelDownloadProgram,
  startLocalModelTestProgram,
} from './local-model'
import {
  getEmbeddingSettingsProgram,
  testEmbeddingProgram,
} from './providers/embed/settings'

/**
 * The local model as web sees it (D50): files on disk are its key, its
 * download and Test are keyed worker jobs, and web never runs it. The
 * worker half — the jobs, the seam, the load count — is tested in
 * apps/worker; this is the settings side, with the queue stood in for.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const SPEC = LOCAL_EMBEDDING_MODELS[0]
const MODEL = SPEC.id

let dataDir = ''
const savedDataDir = process.env.DATA_DIR

async function copyByHand() {
  for (const file of SPEC.files) {
    const path = join(localModelDir(SPEC), ...file.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `copied ${file}`)
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'spaces-local-'))
  process.env.DATA_DIR = dataDir
  enqueued.length = 0
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings: {} })
    .onConflictDoUpdate({ target: workspace.id, set: { settings: {} } })
})

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = savedDataDir
  await rm(dataDir, { recursive: true, force: true })
})

describe('the local model in Settings → Embeddings', () => {
  it('is listed with no files, then found once a directory is copied by hand', async () => {
    const before = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(before.local).toEqual([
      {
        model: MODEL,
        present: false,
        dir: join(dataDir, 'models', 'Xenova', 'bge-base-en-v1.5'),
        approxMegabytes: SPEC.approxMegabytes,
        download: { state: 'idle' },
        test: { state: 'idle' },
        testedOk: false,
      },
    ])
    // No key row: the in-process model has no credential.
    expect(before.keys.map((k) => k.provider)).not.toContain('local')

    await copyByHand()
    const after = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(after.local[0]?.present).toBe(true)
  })

  it('refuses a pin until the files are on disk, then pins with no key', async () => {
    const refused = await Effect.runPromise(
      Effect.result(pinEmbeddingProgram({ provider: 'local', model: MODEL })),
    )
    expect(refused).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'PinRefused',
        message: 'Download the local model before pinning',
      },
    })

    await copyByHand()
    const pinned = await Effect.runPromise(
      pinEmbeddingProgram({ provider: 'local', model: MODEL }),
    )
    expect(pinned).toMatchObject({ provider: 'local', model: MODEL, dims: 768 })
  })

  it('queues the download and the Test as keyed worker jobs; a second press is refused', async () => {
    expect(
      await Effect.runPromise(startLocalModelDownloadProgram(MODEL)),
    ).toEqual({ status: 'queued' })
    expect(
      await Effect.runPromise(startLocalModelDownloadProgram(MODEL)),
    ).toEqual({ status: 'already-queued' })
    expect(await Effect.runPromise(startLocalModelTestProgram(MODEL))).toEqual({
      status: 'queued',
    })
    expect(enqueued).toEqual([
      {
        name: QUEUES.modelDownload,
        data: { model: MODEL },
        options: { singletonKey: `model.download:${MODEL}` },
      },
      {
        name: QUEUES.modelTest,
        data: { model: MODEL },
        options: { singletonKey: `model.test:${MODEL}` },
      },
    ])

    const view = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(view.local[0]?.download).toEqual({ state: 'queued' })
  })

  it('refuses a model the catalogue does not list', async () => {
    const r = await Effect.runPromise(
      Effect.result(startLocalModelDownloadProgram('gpt-embed-9000')),
    )
    expect(r._tag).toBe('Failure')
    expect(enqueued).toEqual([])
  })

  it('never runs the model in web: the request-response Test points at the worker job', async () => {
    const r = await Effect.runPromise(
      testEmbeddingProgram(FIXTURE_ACTOR.id, {
        provider: 'local',
        model: MODEL,
      }),
    )
    expect(r).toEqual({
      ok: false,
      status: null,
      message: 'The local model is tested in the worker — use its Test',
    })
  })
})
