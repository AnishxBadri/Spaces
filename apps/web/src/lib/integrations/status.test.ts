import { describe, expect, it } from 'vitest'

/**
 * Today's tripped-plugin lines read the `integration` row as the worker's
 * breaker leaves it: enabled, status `disabled`. Against this worker's test
 * database, truncated before the file was imported.
 */

async function world() {
  const { Effect } = await import('effect')
  const { db } = await import('@spaces/db')
  const { integration } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const { trippedPluginsProgram } = await import('./status')

  const row = async (values: {
    capabilityId: string
    enabled: boolean
    status: 'installing' | 'enabled' | 'degraded' | 'disabled'
    lastError: string | null
  }) => {
    const inserted = (
      await db
        .insert(integration)
        .values({ version: '0.1.0', ...values })
        .returning({ id: integration.id })
    ).at(0)
    if (!inserted) throw new Error('no integration row')
    return inserted.id
  }
  const tripped = () => Effect.runPromise(trippedPluginsProgram())
  const reset = (id: string) =>
    db
      .update(integration)
      .set({ status: 'enabled', errorCount: 0, lastError: null })
      .where(eq(integration.id, id))
  return { row, tripped, reset }
}

describe('trippedPluginsProgram', () => {
  it('lists every breaker-tripped plugin and nothing else, and a reset clears it', async () => {
    const w = await world()
    const throws = await w.row({
      capabilityId: 'throws',
      enabled: true,
      status: 'disabled',
      lastError: '5 failures in an hour',
    })
    const flaky = await w.row({
      capabilityId: 'flaky',
      enabled: true,
      status: 'disabled',
      lastError: '5 failures in an hour',
    })
    // An operator's off switch, a degraded load, a running plugin, a channel.
    await w.row({
      capabilityId: 'apollo',
      enabled: false,
      status: 'disabled',
      lastError: null,
    })
    await w.row({
      capabilityId: 'old-sdk',
      enabled: true,
      status: 'degraded',
      lastError: 'sdk ^0.1 does not include 1.0.0',
    })
    await w.row({
      capabilityId: 'echo',
      enabled: true,
      status: 'enabled',
      lastError: null,
    })
    await w.row({
      capabilityId: 'core.mailbox',
      enabled: true,
      status: 'disabled',
      lastError: 'not a plugin',
    })

    expect(await w.tripped()).toEqual([
      {
        integrationId: flaky,
        pluginId: 'flaky',
        lastError: '5 failures in an hour',
      },
      {
        integrationId: throws,
        pluginId: 'throws',
        lastError: '5 failures in an hour',
      },
    ])

    await w.reset(throws)
    expect((await w.tripped()).map((p) => p.pluginId)).toEqual(['flaky'])
    await w.reset(flaky)
    expect(await w.tripped()).toEqual([])
  })
})
