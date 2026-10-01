import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import type { QueueClient } from '@spaces/core/queue/sender'
import { workerEnqueue } from './enqueue'

describe('the worker’s Enqueue', () => {
  it('sends through core’s sender, built on the connection string it is given', async () => {
    const sends: Array<[string, Record<string, unknown>, unknown]> = []
    const built: Array<unknown> = []
    const client = (options: unknown): QueueClient => {
      built.push(options)
      return {
        on: () => undefined,
        start: () => Promise.resolve(),
        send: (name, data, sendOptions) => {
          sends.push([name, data, sendOptions])
          return Promise.resolve('job-1')
        },
        findJobs: () => Promise.resolve([]),
      }
    }
    const id = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Enqueue).enqueue(
          QUEUES.embedSource,
          { entityId: 'e-1' },
          { singletonKey: 'k' },
        )
      }).pipe(
        Effect.provide(
          workerEnqueue('postgresql://worker@localhost/x', client),
        ),
      ),
    )
    expect(id).toBe('job-1')
    expect(sends).toEqual([
      [QUEUES.embedSource, { entityId: 'e-1' }, { singletonKey: 'k' }],
    ])
    expect(built).toEqual([
      expect.objectContaining({
        connectionString: 'postgresql://worker@localhost/x',
      }),
    ])
  })

  it('the plugin path imports no #web/lib/queue', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const specifier = /(from|import\()\s*'#web\/lib\/queue'/
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    expect(files).toContain('enqueue.ts')
    for (const f of files)
      expect(readFileSync(`${dir}${f}`, 'utf8')).not.toMatch(specifier)
  })
})
