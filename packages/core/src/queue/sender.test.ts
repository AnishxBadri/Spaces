import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConstructorOptions } from 'pg-boss'
import { createSender, senderOptions } from './sender'
import { QUEUES } from './names'
import type { QueueClient } from './sender'

/**
 * Two properties, both of which the web app depends on and neither of which
 * is visible from a call site: the sender never does housekeeping, and a
 * sender that cannot reach Postgres still returns to its caller.
 *
 * No database here — mono-7's contract is that this package's suite runs with
 * DATABASE_URL unset. The failure case gets a connection string pointing at a
 * closed port, which is a real pg-boss failure with no server involved.
 */

const CLOSED_PORT = 'postgres://nobody:nothing@127.0.0.1:1/nowhere'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A client that records what it was constructed with and never connects. */
function recorder(): {
  options: Array<ConstructorOptions>
  factory: (options: ConstructorOptions) => QueueClient
  sent: Array<{ name: string; data: Record<string, unknown> }>
} {
  const options: Array<ConstructorOptions> = []
  const sent: Array<{ name: string; data: Record<string, unknown> }> = []
  return {
    options,
    sent,
    factory: (o) => {
      options.push(o)
      return {
        on: () => undefined,
        start: () => Promise.resolve(undefined),
        send: (name, data) => {
          sent.push({ name, data })
          return Promise.resolve('job-1')
        },
      }
    },
  }
}

describe('the queue sender', () => {
  it('constructs pg-boss with supervise, schedule and migrate off', async () => {
    const spy = recorder()
    const sender = createSender({
      connectionString: CLOSED_PORT,
      client: spy.factory,
    })

    await sender.enqueue(QUEUES.extractDocument, { documentId: 'd1' })

    expect(spy.options).toHaveLength(1)
    const [passed] = spy.options
    expect(passed).toMatchObject({
      connectionString: CLOSED_PORT,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      migrate: false,
    })
  })

  it('exposes those options directly', () => {
    expect(senderOptions('postgres://x/y')).toEqual({
      connectionString: 'postgres://x/y',
      schema: 'pgboss',
      supervise: false,
      schedule: false,
      migrate: false,
    })
  })

  it('starts once and reuses the connection', async () => {
    const spy = recorder()
    const sender = createSender({
      connectionString: CLOSED_PORT,
      client: spy.factory,
    })

    expect(await sender.enqueue(QUEUES.extractDocument, { a: 1 })).toBe('job-1')
    expect(await sender.enqueue(QUEUES.embedDocument, { b: 2 })).toBe('job-1')

    expect(spy.options).toHaveLength(1)
    expect(spy.sent.map((s) => s.name)).toEqual([
      'document.extract',
      'document.embed',
    ])
  })

  it('does not cache a failed connection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let attempts = 0
    const sender = createSender({
      connectionString: CLOSED_PORT,
      client: () => ({
        on: () => undefined,
        start: () => {
          attempts += 1
          return attempts === 1
            ? Promise.reject(new Error('connection refused'))
            : Promise.resolve(undefined)
        },
        send: () => Promise.resolve('job-2'),
      }),
    })

    expect(await sender.enqueue(QUEUES.extractDocument, {})).toBeNull()
    expect(await sender.enqueue(QUEUES.extractDocument, {})).toBe('job-2')
    expect(attempts).toBe(2)
  })

  it('fails non-fatally against a closed port', async () => {
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const sender = createSender({ connectionString: CLOSED_PORT })

    // The whole point: a resolved value, not a rejection. An `await` that
    // throws here would be a 500 on an upload the user already completed.
    await expect(
      sender.enqueue(QUEUES.extractDocument, { documentId: 'd1' }),
    ).resolves.toBeNull()

    const lines = logged.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].startsWith('[queue] could not enqueue'),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0][0]).toBe('[queue] could not enqueue document.extract')
  }, 20000)
})
