import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { integrationDetailProgram } from '#web/lib/integrations/ledger'
import { JobPermanent, runJob } from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'

/**
 * The plugin page's Recent runs, end to end: `runJob` writes the `job_run`
 * rows (it is their one writer), and the page's read lists that
 * integration's runs only, newest first, a failure with the provider's own
 * error text. No plugin code runs; the jobs are inline JobDefs.
 */

const epoch = new Date(0)

function fakeJob(queue: string): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: queue,
    data: {},
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
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

const silentHost = (): JobHost => {
  const noop = async (_q: string, _id: string, _o: JobOutcome) => undefined
  return {
    complete: noop,
    fail: noop,
    failTerminal: noop,
    send: async () => undefined,
  }
}

const install = async (id: string) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: id,
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest: {
          manifestVersion: 1,
          id,
          version: '0.1.0',
          sdk: '^1.4',
          name: id,
          description: `The ${id} plugin.`,
          roles: ['feeds'],
          settings: {},
          jobs: { poll: { trigger: 'action', uses: ['Http'] } },
        },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

/** Runs one attempt of `plugin.<id>.poll` for the integration through runJob. */
const attempt = (
  pluginId: string,
  integrationId: string,
  outcome: Effect.Effect<string, JobPermanent>,
) => {
  const queue = `plugin.${pluginId}.poll`
  return runJob(
    {
      name: queue,
      schema: z.object({}),
      refs: () => ({ integrationId }),
      run: () => outcome,
    },
    { host: silentHost(), layer: Layer.empty },
  )([fakeJob(queue)])
}

describe('Recent runs on the plugin page', () => {
  it('reads job_run for that integration only, newest first, with the provider error text', async () => {
    const rss = await install('rss')
    const other = await install('other')
    await attempt('rss', rss, Effect.succeed('fetched 3 · written 1'))
    await attempt('other', other, Effect.succeed('not this plugin'))
    await attempt(
      'rss',
      rss,
      Effect.fail(new JobPermanent({ reason: 'feed answered 404 Not Found' })),
    )

    const detail = await Effect.runPromise(integrationDetailProgram(rss))
    expect(detail.runs.map((r) => [r.job, r.status, r.line])).toEqual([
      ['poll', 'failed', 'permanent: feed answered 404 Not Found'],
      ['poll', 'succeeded', 'fetched 3 · written 1'],
    ])
    for (const run of detail.runs) {
      expect(run.ago).toBe('just now')
      expect(run.duration).toMatch(/^\d+(ms|\.\ds)$/)
    }
  })
})
