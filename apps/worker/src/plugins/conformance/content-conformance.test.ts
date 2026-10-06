import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { Content } from '@spaces/sdk'
import type { InteractionClaim, SignalClaim } from '@spaces/sdk'
import { ContentTest } from '@spaces/sdk/testing'
import { insertRow, noEnqueue, runOn, seedCompany } from './support'

/**
 * The Content port's contract for interactions and signals, over every
 * implementation: one interaction per `messageId`, a new one for each claim
 * without one, and a new signal per emit. (`fileDocument` goes through the
 * blob store and core's intake; its own suite covers it.)
 */

type ContentImplementation = {
  readonly name: string
  readonly make: () => Promise<{
    readonly layer: Layer.Layer<Content>
    readonly entityId: string
  }>
}

const IMPLEMENTATIONS: ReadonlyArray<ContentImplementation> = [
  {
    name: 'ContentLive',
    make: async () => ({
      layer: ContentLive(await insertRow()).pipe(Layer.provide(noEnqueue)),
      entityId: await seedCompany(
        'Content Co',
        `content-${randomUUID().slice(0, 8)}.example`,
      ),
    }),
  },
  {
    name: 'ContentTest',
    make: () =>
      Promise.resolve({ layer: ContentTest().layer, entityId: 'entity-1' }),
  },
]

const logInteraction = (claim: InteractionClaim) =>
  Effect.gen(function* () {
    return (yield* (yield* Content).logInteraction(claim)).interactionId
  })

const emitSignal = (claim: SignalClaim) =>
  Effect.gen(function* () {
    return (yield* (yield* Content).emitSignal(claim)).signalId
  })

const interaction = (
  entityId: string,
  messageId?: string,
): InteractionClaim => ({
  _tag: 'interaction',
  kind: 'email',
  occurredAt: '2026-09-30T10:00:00Z',
  entityIds: [entityId],
  subject: 'Intro',
  ...(messageId === undefined ? {} : { messageId }),
})

describe.each(IMPLEMENTATIONS)('Content — $name', (impl) => {
  it('logs one interaction per messageId, however often it is claimed', async () => {
    const { layer, entityId } = await impl.make()
    const messageId = `<${randomUUID()}@content.example>`
    const first = await runOn(
      layer,
      logInteraction(interaction(entityId, messageId)),
    )
    const again = await runOn(
      layer,
      logInteraction(interaction(entityId, messageId)),
    )
    expect(again).toBe(first)
  })

  it('logs a new interaction for each claim without a messageId', async () => {
    const { layer, entityId } = await impl.make()
    const a = await runOn(layer, logInteraction(interaction(entityId)))
    const b = await runOn(layer, logInteraction(interaction(entityId)))
    expect(a).not.toBe(b)
  })

  it('emits a new signal each time', async () => {
    const { layer, entityId } = await impl.make()
    const claim: SignalClaim = {
      _tag: 'signal',
      entityId,
      kind: 'funding',
      title: 'Raised a seed round',
      url: 'https://news.example/seed',
    }
    const a = await runOn(layer, emitSignal(claim))
    const b = await runOn(layer, emitSignal(claim))
    expect(a).not.toBe(b)
  })
})
