import { readFileSync } from 'node:fs'
import { Cause, Effect, Exit, Layer } from 'effect'
import { z } from 'zod'
import { ContentTest, LogTest } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { toRecordedNote } from './index.ts'

/**
 * Both webhook recorders' deliveries through the SDK testing kit: no
 * database, no network. The recorded notes they become are snapshotted, so
 * a change to the contract shows here first.
 */
const payload = (name: string) =>
  z
    .json()
    .parse(
      JSON.parse(
        readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'),
      ),
    )

const deliver = async (name: string, times = 1) => {
  const content = ContentTest()
  const log = LogTest()
  for (let i = 0; i < times; i++) {
    const exit = await Effect.runPromiseExit(
      plugin.jobs
        .ingest({ payload: payload(name), receivedAt: '2026-10-09T17:00:00Z' })
        .pipe(Effect.provide(Layer.mergeAll(content.layer, log.layer))),
    )
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  }
  return content.calls
}

describe.each(['fathom.json', 'tldv.json'])('a %s delivery', (name) => {
  it('becomes one recorded note under the shared contract', async () => {
    const calls = await deliver(name)
    expect(calls.map((c) => c.method)).toEqual(['logRecordedNote'])
    expect(calls.at(0)?.input).toMatchSnapshot()
  })

  it('replayed, is the same note: the host answers duplicate', async () => {
    const calls = await deliver(name, 2)
    expect(calls.map((c) => c.output)).toEqual([
      { outcome: 'born', interactionId: 'interaction-1' },
      { outcome: 'duplicate', interactionId: 'interaction-1' },
    ])
  })
})

describe('a delivery of neither shape', () => {
  it('is refused, and nothing is handed over', () => {
    expect(toRecordedNote({ hello: 'world' })).toBeNull()
  })
})
