import { createHash } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { runJob } from '../run-job'
import type { JobHost, JobOutcome, JobRunLedger } from '../run-job'
import {
  BlobUnreadable,
  ExtractionStore,
  StoreUnavailable,
  extractDocument,
} from './extract-document'
import type { DocumentForExtraction } from './extract-document'

/**
 * The retryable-versus-terminal mapping, asserted. No Postgres and no blob
 * store: the job's Layer is the seam, so a fake ExtractionStore is the whole
 * of its I/O, and the `job_run` ledger is stubbed out the same way (its rows
 * are asserted against a real database in `../run-job.ledger.test.ts`). The reason strings are quoted verbatim here on purpose — they
 * are what the operator reads on the document row, and the port onto runJob
 * must not have changed a byte of them.
 */

type Settlement =
  | {
      call: 'complete' | 'fail' | 'failTerminal'
      jobId: string
      output: JobOutcome
    }
  | { call: 'send' }

function fakeHost(): { host: JobHost; calls: Array<Settlement> } {
  const calls: Array<Settlement> = []
  return {
    calls,
    host: {
      complete: async (_q, jobId, output) => {
        calls.push({ call: 'complete', jobId, output })
      },
      fail: async (_q, jobId, output) => {
        calls.push({ call: 'fail', jobId, output })
      },
      failTerminal: async (_q, jobId, output) => {
        calls.push({ call: 'failTerminal', jobId, output })
      },
      send: async () => {
        calls.push({ call: 'send' })
      },
    },
  }
}

type Write =
  | { op: 'extracted'; documentId: string; text: string }
  | {
      op: 'failed'
      documentId: string
      status: 'unsupported' | 'failed'
      reason: string
    }

function fakeStore(options: {
  row: DocumentForExtraction | null
  bytes?: Uint8Array
  blobError?: string
  readError?: string
}): { layer: Layer.Layer<ExtractionStore>; writes: Array<Write> } {
  const writes: Array<Write> = []
  const layer = Layer.succeed(
    ExtractionStore,
    ExtractionStore.of({
      read: () =>
        options.readError === undefined
          ? Effect.succeed(options.row)
          : Effect.fail(
              new StoreUnavailable({
                operation: 'read',
                message: options.readError,
              }),
            ),
      bytes: (blobSha) =>
        options.blobError === undefined
          ? Effect.succeed(options.bytes ?? new Uint8Array())
          : Effect.fail(
              new BlobUnreadable({ blobSha, message: options.blobError }),
            ),
      markExtracted: (documentId, text) =>
        Effect.sync(() => {
          writes.push({ op: 'extracted', documentId, text })
        }),
      markFailed: (documentId, status, reason) =>
        Effect.sync(() => {
          writes.push({ op: 'failed', documentId, status, reason })
        }),
    }),
  )
  return { layer, writes }
}

const noLedger: JobRunLedger = {
  begin: async () => null,
  end: async () => undefined,
}

const documentId = '11111111-1111-4111-8111-111111111111'
const epoch = new Date(0)

function fakeJob(retry: {
  count: number
  limit: number
}): JobWithMetadata<object> {
  return {
    id: 'job-1',
    name: extractDocument.name,
    data: { documentId },
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: retry.limit,
    retryCount: retry.count,
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

const bytes = new TextEncoder().encode('Series A term sheet. 20% discount.\n')
const sha = createHash('sha256').update(bytes).digest('hex')

async function run(
  store: ReturnType<typeof fakeStore>,
  retry: { count: number; limit: number } = { count: 0, limit: 2 },
) {
  const { host, calls } = fakeHost()
  await runJob(extractDocument, { host, layer: store.layer, ledger: noLedger })(
    [fakeJob(retry)],
  )
  return { calls, writes: store.writes }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extractDocument — the happy path still completes', () => {
  it('writes the extracted text and completes the job', async () => {
    const store = fakeStore({
      row: { blobSha: sha, filename: 'terms.txt', mime: 'text/plain' },
      bytes,
    })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([
      {
        op: 'extracted',
        documentId,
        text: 'Series A term sheet. 20% discount.',
      },
    ])
    expect(calls.map((c) => c.call)).toEqual(['complete'])
  })

  it('completes without writing when the document vanished', async () => {
    const store = fakeStore({ row: null })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([])
    expect(calls.map((c) => c.call)).toEqual(['complete'])
  })
})

describe('extractDocument — permanent failures land on the row immediately', () => {
  it('maps a missing blob to unsupported, recorded now', async () => {
    const store = fakeStore({
      row: { blobSha: null, filename: 'terms.txt', mime: 'text/plain' },
    })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([
      {
        op: 'failed',
        documentId,
        status: 'unsupported',
        reason: 'No stored file to extract text from',
      },
    ])
    expect(calls.map((c) => c.call)).toEqual(['failTerminal'])
    const settled = calls[0]
    if (settled.call === 'send') throw new Error('unreachable')
    expect(settled.output.kind).toBe('permanent')
  })

  it('maps a sha mismatch to failed, recorded now', async () => {
    const wrongSha = 'f'.repeat(64)
    const store = fakeStore({
      row: { blobSha: wrongSha, filename: 'terms.txt', mime: 'text/plain' },
      bytes,
    })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([
      {
        op: 'failed',
        documentId,
        status: 'failed',
        reason: `Blob integrity check failed: stored bytes hash ${sha.slice(0, 12)}, expected ${wrongSha.slice(0, 12)}. The storage backend accepted a corrupt upload.`,
      },
    ])
    expect(calls.map((c) => c.call)).toEqual(['failTerminal'])
  })

  it('maps an unsupported mime to unsupported, recorded now', async () => {
    const scanSha = createHash('sha256').update(bytes).digest('hex')
    const store = fakeStore({
      row: { blobSha: scanSha, filename: 'scan.jpg', mime: 'image/jpeg' },
      bytes,
    })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([
      {
        op: 'failed',
        documentId,
        status: 'unsupported',
        reason: 'No text extractor for image/jpeg',
      },
    ])
    expect(calls.map((c) => c.call)).toEqual(['failTerminal'])
  })
})

describe('extractDocument — an unreadable blob is retryable', () => {
  const unreadable = () =>
    fakeStore({
      row: { blobSha: sha, filename: 'terms.txt', mime: 'text/plain' },
      blobError: 'connect ECONNREFUSED 127.0.0.1:9000',
    })
  const reason = `Blob ${sha.slice(0, 12)} unreadable: connect ECONNREFUSED 127.0.0.1:9000`

  it('leaves extraction_status untouched while retries remain', async () => {
    const { calls, writes } = await run(unreadable(), { count: 0, limit: 2 })

    expect(writes).toEqual([])
    expect(calls.map((c) => c.call)).toEqual(['fail'])
    const settled = calls[0]
    if (settled.call === 'send') throw new Error('unreachable')
    expect(settled.output.kind).toBe('retryable')
    expect(settled.output.reason).toBe(reason)
  })

  it('still leaves it untouched on the middle attempt', async () => {
    const { writes } = await run(unreadable(), { count: 1, limit: 2 })
    expect(writes).toEqual([])
  })

  it('writes failed on the final attempt, with the same reason', async () => {
    const { calls, writes } = await run(unreadable(), { count: 2, limit: 2 })

    expect(writes).toEqual([
      { op: 'failed', documentId, status: 'failed', reason },
    ])
    // Still `fail`, not `failTerminal`: the queue has no retries left, so
    // pg-boss lands it in `failed` on its own.
    expect(calls.map((c) => c.call)).toEqual(['fail'])
  })
})

describe('extractDocument — a store that is down is retryable', () => {
  it('does not burn the row when the read itself fails', async () => {
    const store = fakeStore({ row: null, readError: 'terminating connection' })
    const { calls, writes } = await run(store)

    expect(writes).toEqual([])
    expect(calls.map((c) => c.call)).toEqual(['fail'])
    const settled = calls[0]
    if (settled.call === 'send') throw new Error('unreachable')
    expect(settled.output.reason).toContain('document store unavailable')
  })
})
