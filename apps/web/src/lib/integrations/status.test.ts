import { describe, expect, it } from 'vitest'

/**
 * Today's and Review's plugin lines read the `integration` row as the worker
 * leaves it: enabled, with status `disabled` (the breaker) or `degraded` (the
 * loader). Against this worker's test database, truncated before the file
 * was imported.
 */

async function world() {
  const { Effect } = await import('effect')
  const { db } = await import('@spaces/db')
  const { integration } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const { stoppedPluginsProgram } = await import('./status')

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
  const stopped = () => Effect.runPromise(stoppedPluginsProgram())
  const reset = (id: string) =>
    db
      .update(integration)
      .set({ status: 'enabled', errorCount: 0, lastError: null })
      .where(eq(integration.id, id))
  return { row, stopped, reset }
}

describe('stoppedPluginsProgram', () => {
  it('lists every tripped and degraded plugin and nothing else, and a reset clears it', async () => {
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
    const oldSdk = await w.row({
      capabilityId: 'old-sdk',
      enabled: true,
      status: 'degraded',
      lastError: 'sdk ^0.1 does not include 1.0.0',
    })
    // An operator's off switch, a switched-off degraded row, a running
    // plugin, a channel.
    await w.row({
      capabilityId: 'apollo',
      enabled: false,
      status: 'disabled',
      lastError: null,
    })
    await w.row({
      capabilityId: 'needs-key',
      enabled: false,
      status: 'degraded',
      lastError: 'no credential',
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

    expect(await w.stopped()).toEqual([
      {
        integrationId: flaky,
        pluginId: 'flaky',
        state: 'tripped',
        lastError: '5 failures in an hour',
      },
      {
        integrationId: oldSdk,
        pluginId: 'old-sdk',
        state: 'degraded',
        lastError: 'sdk ^0.1 does not include 1.0.0',
      },
      {
        integrationId: throws,
        pluginId: 'throws',
        state: 'tripped',
        lastError: '5 failures in an hour',
      },
    ])

    await w.reset(throws)
    await w.reset(oldSdk)
    expect((await w.stopped()).map((p) => p.pluginId)).toEqual(['flaky'])
    await w.reset(flaky)
    expect(await w.stopped()).toEqual([])
  })
})
