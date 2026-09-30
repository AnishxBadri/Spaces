import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { PROVIDER_URL } from './index.ts'

/**
 * The echo `enrich` job end to end on the SDK's test Layers (sdk-5): no
 * database, no network — CI runs this file with DATABASE_URL unset. The
 * recorder shows exactly which port calls the job made, in order, including
 * the fill against the id `Identity.resolve` minted.
 */
const organization: unknown = JSON.parse(
  readFileSync(
    new URL('../fixtures/organization.json', import.meta.url),
    'utf8',
  ),
)

const url = `${PROVIDER_URL}?domain=northwind-robotics.example`

const run = (ports: ReturnType<typeof testPorts>) => {
  const job = plugin.jobs.enrich
  if (typeof job === 'function') throw new Error('enrich declares cost')
  return Effect.runPromiseExit(
    job.run({ entityId: 'entity-0' }).pipe(Effect.provide(ports.layer)),
  )
}

describe('the echo enrich job, on the test Layers', () => {
  it('reads, fetches, resolves, stores the receipt, then fills the resolved id', async () => {
    const ports = testPorts({
      entities: [
        readEntity({
          id: 'entity-0',
          name: 'Northwind',
          keys: {
            domain: ['northwind-robotics.example'],
            email: [],
            linkedin: [],
            cin: [],
          },
        }),
      ],
      http: [
        { url, response: { body: JSON.parse(JSON.stringify(organization)) } },
      ],
    })
    const exit = await run(ports)
    expect(exit._tag).toBe('Success')

    const trace = ports.calls.map((c) => `${c.port}.${c.method}`)
    console.info(`[echo.enrich] port calls:\n  ${trace.join('\n  ')}`)
    expect(trace).toEqual([
      'Read.entity',
      'Http.request',
      'Identity.resolve',
      'Receipts.store',
      'Facts.fill',
      'Log.info',
    ])

    const minted = ports.identity.calls[0]?.output
    expect(minted).toEqual({ entityId: 'entity-1', outcome: 'created' })
    expect(ports.facts.calls[0]?.input).toMatchObject({
      entityId: 'entity-1',
      receiptId: 'receipt-1',
    })
    expect(ports.facts.values.get('entity-1')).toEqual({
      description:
        'Warehouse picking robots that learn a new SKU from one demonstration.',
      founded_year: 2019,
      location: 'Pune, India',
    })
    expect(ports.http.calls[0]?.input).toEqual({
      method: 'GET',
      url,
      headers: { accept: 'application/json' },
    })
  })

  it('returns a human value as a conflict and still fills the rest', async () => {
    const ports = testPorts({
      known: { 'entity-5': { domain: 'northwind-robotics.example' } },
      human: { 'entity-5': { founded_year: 2018 } },
      entities: [
        readEntity({
          id: 'entity-0',
          name: 'Northwind',
          keys: {
            domain: ['northwind-robotics.example'],
            email: [],
            linkedin: [],
            cin: [],
          },
        }),
      ],
      http: [
        { url, response: { body: JSON.parse(JSON.stringify(organization)) } },
      ],
    })
    expect((await run(ports))._tag).toBe('Success')
    expect(ports.identity.calls[0]?.output).toEqual({
      entityId: 'entity-5',
      outcome: 'attached',
    })
    expect(ports.facts.calls[0]?.output).toEqual({
      conflicts: [{ slug: 'founded_year', existing: 2018, proposed: 2019 }],
    })
    expect(ports.log.lines.at(0)?.fields).toEqual({
      entityId: 'entity-5',
      receiptId: 'receipt-1',
      conflicts: ['founded_year'],
    })
  })

  it('fails permanently for a record with no domain, having called nothing else', async () => {
    const ports = testPorts({
      entities: [readEntity({ id: 'entity-0', name: 'No domain' })],
    })
    const exit = await run(ports)
    expect(exit._tag).toBe('Failure')
    expect(ports.calls.map((c) => c.method)).toEqual(['entity'])
  })

  it('surfaces a provider throttle as JobRateLimited', async () => {
    const ports = testPorts({
      entities: [
        readEntity({
          id: 'entity-0',
          name: 'Northwind',
          keys: {
            domain: ['northwind-robotics.example'],
            email: [],
            linkedin: [],
            cin: [],
          },
        }),
      ],
      http: [
        { url, response: { status: 429, headers: { 'retry-after': '5' } } },
      ],
    })
    const exit = await run(ports)
    expect(JSON.stringify(exit)).toContain('JobRateLimited')
    expect(ports.calls.map((c) => c.method)).toEqual(['entity', 'request'])
  })
})
