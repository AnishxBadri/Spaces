import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { SEARCH_URL } from './index.ts'

/**
 * The researcher's `research` job on the SDK's test Layers (sdk-7b): no
 * database, no network. The snapshot is the job's whole conversation with
 * the host — every port call in order, with what each returned — so a
 * change in what it emits is a reviewed diff.
 */
const search: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/search.json', import.meta.url), 'utf8'),
)

const northwind = readEntity({ id: 'entity-0', name: 'Northwind Robotics' })

const run = (ports: ReturnType<typeof testPorts>, entityId = 'entity-0') => {
  const job = plugin.jobs.research
  const research = typeof job === 'function' ? job : job.run
  return Effect.runPromiseExit(
    research({ entityId }).pipe(Effect.provide(ports.layer)),
  )
}

describe('the researcher research job, on the test Layers', () => {
  it('reads, searches, and emits one signal per hit', async () => {
    const ports = testPorts({
      entities: [northwind],
      http: [
        {
          method: 'POST',
          url: SEARCH_URL,
          response: { body: JSON.parse(JSON.stringify(search)) },
        },
      ],
    })
    const exit = await run(ports)
    expect(exit._tag).toBe('Success')
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Http.request',
      'Content.emitSignal',
      'Content.emitSignal',
      'Content.emitSignal',
      'Log.info',
    ])
    expect(ports.calls).toMatchSnapshot()
  })

  it('emits nothing for a record it may not read', async () => {
    const ports = testPorts({ entities: [northwind] })
    const exit = await run(ports, 'entity-elsewhere')
    expect(exit._tag).toBe('Failure')
    expect(ports.content.calls).toEqual([])
  })

  it('a non-200 answer is retryable and emits nothing', async () => {
    const ports = testPorts({
      entities: [northwind],
      http: [{ method: 'POST', url: SEARCH_URL, response: { status: 503 } }],
    })
    const exit = await run(ports)
    expect(JSON.stringify(exit)).toContain('JobRetryable')
    expect(ports.content.calls).toEqual([])
  })
})
