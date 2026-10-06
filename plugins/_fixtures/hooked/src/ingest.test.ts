import { Effect } from 'effect'
import { testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.ts'

/** The hooked fixture's `ingest` job on the SDK's test Layers: no database. */

const receivedAt = '2026-10-06T12:00:00.000Z'

const run = (ports: ReturnType<typeof testPorts>, payload: unknown) => {
  const job = plugin.jobs.ingest
  return Effect.runPromiseExit(
    job({ payload: JSON.parse(JSON.stringify(payload)), receivedAt }).pipe(
      Effect.provide(ports.layer),
    ),
  )
}

describe('the hooked ingest job', () => {
  it('emits one call signal on the record the delivery names', async () => {
    const ports = testPorts({})
    const exit = await run(ports, {
      entityId: 'entity-0',
      title: 'Call with Northwind',
    })
    expect(exit._tag).toBe('Success')
    expect(ports.content.calls).toEqual([
      {
        port: 'Content',
        method: 'emitSignal',
        input: {
          _tag: 'signal',
          entityId: 'entity-0',
          kind: 'call',
          title: 'Call with Northwind',
          publishedAt: receivedAt,
        },
        output: { signalId: 'signal-1' },
      },
    ])
  })

  it('a delivery that is not { entityId, title } fails permanently and emits nothing', async () => {
    const ports = testPorts({})
    const exit = await run(ports, 'plain words')
    expect(JSON.stringify(exit)).toContain('JobPermanent')
    expect(ports.content.calls).toEqual([])
  })
})
