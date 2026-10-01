import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { testPorts } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { MESSAGES_URL } from './index.ts'

/**
 * The syncer's `sync` job on the SDK's test Layers (sdk-7b): no database,
 * no network. The snapshot is the job's whole conversation with the host —
 * every port call in order, with what each returned — and the replay shows
 * the lane's contract from the plugin's side: the same Message-ID is the
 * same interaction id.
 */
const page: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/page-1.json', import.meta.url), 'utf8'),
)
const body = () => JSON.parse(JSON.stringify(page))

const run = (ports: ReturnType<typeof testPorts>, cursor: string | null) =>
  Effect.runPromise(
    plugin.jobs.sync({ cursor }).pipe(Effect.provide(ports.layer)),
  )

describe('the syncer sync job, on the test Layers', () => {
  it('resolves participants, logs each message, and returns the next cursor', async () => {
    const ports = testPorts({
      http: [{ url: MESSAGES_URL, response: { body: body() } }],
    })
    const out = await run(ports, null)
    expect(out).toEqual({ nextCursor: 'page-2' })
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Http.request',
      'Identity.resolve',
      'Identity.resolve',
      'Content.logInteraction',
      'Identity.resolve',
      'Identity.resolve',
      'Identity.resolve',
      'Content.logInteraction',
      'Log.info',
    ])
    expect(ports.calls).toMatchSnapshot()
  })

  it('a replayed page is one interaction per Message-ID', async () => {
    const ports = testPorts({
      http: [
        {
          url: `${MESSAGES_URL}?cursor=page-1`,
          response: { body: body() },
          repeat: true,
        },
      ],
    })
    await run(ports, 'page-1')
    await run(ports, 'page-1')
    const ids = ports.content.calls.map((c) => c.output)
    expect(ids).toEqual([
      { interactionId: 'interaction-1' },
      { interactionId: 'interaction-2' },
      { interactionId: 'interaction-1' },
      { interactionId: 'interaction-2' },
    ])
  })

  it('asks for the page after the cursor it was handed', async () => {
    const ports = testPorts({
      http: [
        {
          url: `${MESSAGES_URL}?cursor=page-2`,
          response: { body: { messages: [], nextCursor: null } },
        },
      ],
    })
    expect(await run(ports, 'page-2')).toEqual({ nextCursor: null })
    expect(ports.content.calls).toEqual([])
  })
})
