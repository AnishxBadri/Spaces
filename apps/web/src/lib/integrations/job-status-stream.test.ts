import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobStatusRow } from './job-status'
import type { JobStatusSubscriber } from '#/lib/server/job-status-listener'

/**
 * The record's status stream (D64): `init` from `job_run` on open and on
 * every resync, live `status` events for this record only, and nothing at
 * all for a viewer the record page would refuse.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const { jobStatusStream, handleJobStatusRequest } =
  await import('./job-status-stream')
const { jobStatusListener } = await import('#/lib/server/job-status-listener')

afterAll(async () => {
  await jobStatusListener().shutdown()
})

/** A listener the test drives: it holds the subscribers and says when it listens. */
const fakeListener = () => {
  const subscribers = new Set<JobStatusSubscriber>()
  return {
    subscribers,
    subscribe: (s: JobStatusSubscriber) => {
      subscribers.add(s)
      return () => {
        subscribers.delete(s)
      }
    },
    listening: () => {
      for (const s of subscribers) s.onListening()
    },
    emit: (event: JobStatusEvent) => {
      for (const s of subscribers)
        if (s.entityId === event.entityId) s.onEvent(event)
    },
    close: () => {
      for (const s of subscribers) s.onClose()
    },
  }
}

const row = (
  entityId: string,
  status: JobStatusEvent['status'],
): JobStatusRow => ({
  jobRunId: randomUUID(),
  queue: 'plugin.apollo.enrichCompany',
  integrationId: randomUUID(),
  entityId,
  status,
  startedAt: new Date().toISOString(),
  summary: null,
  error: null,
  closedAgoMs: status === 'running' ? null : 0,
})

/** Reads the stream into frames as they arrive. */
const reader = (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  const frames: Array<string> = []
  let done = false
  void (async () => {
    const r = stream.getReader()
    let buffered = ''
    for (;;) {
      const chunk = await r.read()
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const parts = buffered.split('\n\n')
      buffered = parts.pop() ?? ''
      frames.push(...parts)
    }
    done = true
  })()
  return { frames, isDone: () => done }
}

const until = async (check: () => boolean) => {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 10))
}

const dataOf = (frame: string | undefined): unknown =>
  JSON.parse((frame ?? '').split('\ndata: ').at(1) ?? 'null')

describe('jobStatusStream', () => {
  it('opens with retry, then init once LISTEN is in place, then live events for this record only', async () => {
    const entityId = randomUUID()
    const listener = fakeListener()
    const running = row(entityId, 'running')
    const stream = jobStatusStream(
      entityId,
      { listener, snapshot: async () => [running] },
      new AbortController().signal,
    )
    const read = reader(stream)
    await until(() => read.frames.length === 1)
    expect(read.frames).toEqual(['retry: 2000'])

    listener.listening()
    await until(() => read.frames.length === 2)
    expect(read.frames.at(1)?.startsWith('event: init\n')).toBe(true)
    expect(dataOf(read.frames.at(1))).toEqual({ rows: [running] })

    const closed: JobStatusEvent = {
      ...running,
      status: 'succeeded',
      summary: 'ok',
    }
    listener.emit(closed)
    listener.emit({ ...closed, entityId: randomUUID() })
    await until(() => read.frames.length === 3)
    expect(read.frames.at(2)?.startsWith('event: status\n')).toBe(true)
    expect(dataOf(read.frames.at(2))).toMatchObject({
      jobRunId: running.jobRunId,
      status: 'succeeded',
    })
    listener.close()
    await until(read.isDone)
    expect(read.isDone()).toBe(true)
    expect(listener.subscribers.size).toBe(0)
  })

  it('holds a live event heard before init and writes it after, so the snapshot cannot hide it', async () => {
    const entityId = randomUUID()
    const listener = fakeListener()
    const running = row(entityId, 'running')
    let answer: (rows: Array<JobStatusRow>) => void = () => undefined
    const stream = jobStatusStream(
      entityId,
      {
        listener,
        snapshot: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      },
      new AbortController().signal,
    )
    const read = reader(stream)
    listener.listening()
    listener.emit({ ...running, status: 'failed', error: 'permanent: no' })
    answer([running])
    await until(() => read.frames.length === 3)
    expect(read.frames.map((f) => f.split('\n').at(0))).toEqual([
      'retry: 2000',
      'event: init',
      'event: status',
    ])
  })

  it('resyncs from job_run while a row is running, and only keeps alive otherwise', async () => {
    const entityId = randomUUID()
    const listener = fakeListener()
    const reads: Array<number> = []
    let state: Array<JobStatusRow> = [row(entityId, 'running')]
    const abort = new AbortController()
    const stream = jobStatusStream(
      entityId,
      {
        listener,
        snapshot: async () => {
          reads.push(Date.now())
          return state
        },
        resyncMs: 30,
      },
      abort.signal,
    )
    const read = reader(stream)
    listener.listening()
    await until(() => reads.length >= 3)
    // The worker died: the snapshot now settles the row, and resyncing stops.
    state = [{ ...row(entityId, 'failed'), error: 'worker-lost: gone' }]
    await until(() => read.frames.some((f) => f.includes('worker-lost')))
    const settledAt = reads.length
    await until(() => read.frames.at(-1) === ': keepalive')
    expect(read.frames.at(-1)).toBe(': keepalive')
    expect(reads.length).toBeLessThanOrEqual(settledAt + 1)

    abort.abort()
    await until(read.isDone)
    expect(listener.subscribers.size).toBe(0)
  })

  it('ends a stream whose snapshot fails, so the client reconnects and resyncs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const listener = fakeListener()
    const stream = jobStatusStream(
      randomUUID(),
      {
        listener,
        snapshot: () => Promise.reject(new Error('connection refused')),
      },
      new AbortController().signal,
    )
    const read = reader(stream)
    listener.listening()
    await until(read.isDone)
    expect(read.frames).toEqual(['retry: 2000'])
    vi.restoreAllMocks()
  })
})

describe('the /api/job-status request', () => {
  const company = async () => {
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    return (
      await resolveEntity({
        kind: 'company',
        name: `Stream ${randomUUID().slice(0, 6)}`,
        source: { class: 'manual' },
      })
    ).entityId
  }
  const get = (id: string) =>
    handleJobStatusRequest(
      new Request(`http://localhost/api/job-status/${id}`),
      id,
    )

  it('refuses a request with no session', async () => {
    session.current = null
    expect((await get(await company())).status).toBe(401)
  })

  it('refuses a record the viewer could not open', async () => {
    session.current = { id: randomUUID(), role: 'member' }
    expect((await get(randomUUID())).status).toBe(403)
    expect((await get('not-a-uuid')).status).toBe(403)
  })

  it('streams a readable record as text/event-stream, opening with its job_run state', async () => {
    session.current = { id: randomUUID(), role: 'member' }
    const abort = new AbortController()
    const id = await company()
    const response = await handleJobStatusRequest(
      new Request(`http://localhost/api/job-status/${id}`, {
        signal: abort.signal,
      }),
      id,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    if (response.body === null) throw new Error('no body')
    const read = reader(response.body)
    await until(() => read.frames.length >= 2)
    expect(read.frames.at(0)).toBe('retry: 2000')
    expect(dataOf(read.frames.at(1))).toEqual({ rows: [] })
    abort.abort()
    await until(read.isDone)
    expect(read.isDone()).toBe(true)
  })
})
