import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  JOB_STATUS_CHANNEL,
  encodeJobStatus,
} from '@spaces/core/queue/job-status'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import {
  LISTENER_APPLICATION_NAME,
  makeJobStatusListener,
  pgListenConnection,
} from './job-status-listener'
import type {
  JobStatusListener,
  JobStatusSubscriber,
  ListenConnection,
} from './job-status-listener'

/**
 * Web's one LISTEN client (D64): however many record pages subscribe, one
 * connection; each notification reaches only its record's subscribers; a
 * lost connection reconnects and asks every subscriber to resync; shutdown
 * ends the connection and every stream.
 */

type Fake = {
  readonly connection: ListenConnection
  readonly queries: Array<string>
  ended: boolean
  notify: (channel: string, payload: string) => void
  lose: (error: Error) => void
}

const fakes: Array<Fake> = []

const fakeConnection = (): ListenConnection => {
  const fake: Fake = {
    queries: [],
    ended: false,
    notify: () => undefined,
    lose: () => undefined,
    connection: {
      connect: async () => undefined,
      query: async (text) => {
        fake.queries.push(text)
      },
      end: async () => {
        fake.ended = true
      },
      onNotification: (handler) => {
        fake.notify = handler
      },
      onLost: (handler) => {
        fake.lose = handler
      },
    },
  }
  fakes.push(fake)
  return fake.connection
}

const listeners: Array<JobStatusListener> = []

const newListener = () => {
  const listener = makeJobStatusListener({
    connect: fakeConnection,
    backoff: { initialMs: 10, maxMs: 10 },
    log: () => undefined,
  })
  listeners.push(listener)
  return listener
}

afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.shutdown()
  fakes.splice(0)
})

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (done: () => boolean, timeoutMs = 3000) => {
  const until = Date.now() + timeoutMs
  while (!done() && Date.now() < until) await tick(10)
}

/** A subscriber that records what it is told. */
const recorder = (entityId: string) => {
  const seen: {
    listening: number
    events: Array<JobStatusEvent>
    closed: number
  } = {
    listening: 0,
    events: [],
    closed: 0,
  }
  const subscriber: JobStatusSubscriber = {
    entityId,
    onListening: () => {
      seen.listening += 1
    },
    onEvent: (event) => {
      seen.events.push(event)
    },
    onClose: () => {
      seen.closed += 1
    },
  }
  return { seen, subscriber }
}

const event = (entityId: string, status: JobStatusEvent['status']) => ({
  jobRunId: randomUUID(),
  queue: 'plugin.apollo.enrichCompany',
  integrationId: randomUUID(),
  entityId,
  status,
  startedAt: new Date().toISOString(),
  summary: null,
  error: null,
})

describe('the job_status listener', () => {
  it('opens nothing until the first subscriber, then one connection for all of them', async () => {
    const listener = newListener()
    await tick()
    expect(fakes).toHaveLength(0)

    const a = randomUUID()
    const b = randomUUID()
    const subs = [recorder(a), recorder(a), recorder(b), recorder(b)]
    for (const s of subs) listener.subscribe(s.subscriber)
    await waitFor(() => subs.every((s) => s.seen.listening === 1))

    expect(fakes).toHaveLength(1)
    expect(fakes.at(0)?.queries).toEqual([`LISTEN ${JOB_STATUS_CHANNEL}`])
    expect(subs.map((s) => s.seen.listening)).toEqual([1, 1, 1, 1])
  })

  it("fans a notification out to its record's subscribers only", async () => {
    const listener = newListener()
    const a = randomUUID()
    const b = randomUUID()
    const onA = recorder(a)
    const onB = recorder(b)
    listener.subscribe(onA.subscriber)
    listener.subscribe(onB.subscriber)
    await waitFor(() => onB.seen.listening === 1)

    const fake = fakes.at(0)
    const running = event(a, 'running')
    fake?.notify(JOB_STATUS_CHANNEL, encodeJobStatus(running))
    fake?.notify('plugin_changed', 'apollo')
    fake?.notify(JOB_STATUS_CHANNEL, 'not json')
    expect(onA.seen.events).toEqual([running])
    expect(onB.seen.events).toEqual([])
  })

  it('reconnects a lost connection and asks every subscriber to resync', async () => {
    const listener = newListener()
    const a = recorder(randomUUID())
    listener.subscribe(a.subscriber)
    await waitFor(() => a.seen.listening === 1)

    fakes.at(0)?.lose(new Error('terminating connection'))
    await waitFor(() => a.seen.listening === 2)
    expect(fakes).toHaveLength(2)
    expect(fakes.at(0)?.ended).toBe(true)
    expect(a.seen.listening).toBe(2)
  })

  it('keeps its connection when the last subscriber leaves, and shutdown ends it and every stream', async () => {
    const listener = newListener()
    const a = recorder(randomUUID())
    const b = recorder(randomUUID())
    const leave = listener.subscribe(a.subscriber)
    listener.subscribe(b.subscriber)
    await waitFor(() => b.seen.listening === 1)
    leave()
    await tick()
    expect(fakes.at(0)?.ended).toBe(false)

    await listener.shutdown()
    expect(fakes.at(0)?.ended).toBe(true)
    expect([a.seen.closed, b.seen.closed]).toEqual([0, 1])

    // A subscriber arriving after shutdown is closed, not connected.
    const late = recorder(randomUUID())
    listener.subscribe(late.subscriber)
    await tick()
    expect(late.seen.closed).toBe(1)
    expect(fakes).toHaveLength(1)
  })
})

describe('against Postgres', () => {
  const backends = async () =>
    Number(
      (
        await db.execute<{ n: string }>(
          sql`select count(*)::text as n from pg_stat_activity where application_name = ${LISTENER_APPLICATION_NAME} and datname = current_database()`,
        )
      ).rows.at(0)?.n ?? 0,
    )

  it('holds one backend for many subscribers, hears pg_notify, and leaves none after shutdown', async () => {
    const connectionString = process.env.DATABASE_URL
    if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
    const listener = makeJobStatusListener({
      connect: () => pgListenConnection(connectionString),
      log: () => undefined,
    })
    const entityId = randomUUID()
    const subs = Array.from({ length: 5 }, () => recorder(entityId))
    for (const s of subs) listener.subscribe(s.subscriber)
    await waitFor(() => subs.every((s) => s.seen.listening === 1))
    expect(await backends()).toBe(1)

    const done = event(entityId, 'succeeded')
    await db.execute(
      sql`select pg_notify(${JOB_STATUS_CHANNEL}, ${encodeJobStatus(done)})`,
    )
    await waitFor(() => subs.every((s) => s.seen.events.length === 1))
    expect(subs.map((s) => s.seen.events)).toEqual(subs.map(() => [done]))

    await listener.shutdown()
    await tick(200)
    expect(await backends()).toBe(0)
  })
})
