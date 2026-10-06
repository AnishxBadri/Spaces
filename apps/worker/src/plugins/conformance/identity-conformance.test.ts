import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { IdentityLive } from '@spaces/core/writes/ports/identity'
import { Identity } from '@spaces/sdk'
import type { AliasClaim, IdentityClaim } from '@spaces/sdk'
import { IdentityTest } from '@spaces/sdk/testing'
import { insertRow, noEnqueue, runOn } from './support'

/**
 * The Identity port's contract, over every implementation: the same keys in
 * any spelling resolve to one entity — `created` once, `attached` after —
 * and an alias is `added`, `already_own`, or a `suggested_duplicate` when
 * another entity holds it; never an error, never a second entity.
 */

type IdentityImplementation = {
  readonly name: string
  readonly make: () => Promise<Layer.Layer<Identity>>
}

const IMPLEMENTATIONS: ReadonlyArray<IdentityImplementation> = [
  {
    name: 'IdentityLive',
    make: async () =>
      IdentityLive(await insertRow()).pipe(Layer.provide(noEnqueue)),
  },
  {
    name: 'IdentityTest',
    make: () => Promise.resolve(IdentityTest().layer),
  },
]

const resolve = (claim: IdentityClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Identity).resolve(claim)
  })

const addAlias = (claim: AliasClaim) =>
  Effect.gen(function* () {
    return (yield* (yield* Identity).addAlias(claim)).keys.map(
      (k) => `${k.key}:${k.outcome}`,
    )
  })

/** Domains no other test in this file uses, so a live run starts from nothing. */
const fresh = () => `co-${randomUUID().slice(0, 8)}.example`

describe.each(IMPLEMENTATIONS)('Identity — $name', (impl) => {
  it('creates once, then attaches the same keys in any spelling', async () => {
    const layer = await impl.make()
    const domain = fresh()
    const first = await runOn(
      layer,
      resolve({ kind: 'company', name: 'Acme', keys: { domain } }),
    )
    const again = await runOn(
      layer,
      resolve({
        kind: 'company',
        name: 'ACME Inc',
        keys: { domain: `https://www.${domain.toUpperCase()}/about` },
      }),
    )
    expect(first.outcome).toBe('created')
    expect(again).toEqual({ entityId: first.entityId, outcome: 'attached' })
  })

  it('adds a new key, knows its own, and flags one held elsewhere as a duplicate', async () => {
    const layer = await impl.make()
    const [own, other, added] = [fresh(), fresh(), fresh()]
    const { entityId } = await runOn(
      layer,
      resolve({ kind: 'company', name: 'Own Co', keys: { domain: own } }),
    )
    await runOn(
      layer,
      resolve({ kind: 'company', name: 'Other Co', keys: { domain: other } }),
    )

    expect(
      await runOn(layer, addAlias({ entityId, keys: { domain: added } })),
    ).toEqual(['domain:added'])
    expect(
      await runOn(layer, addAlias({ entityId, keys: { domain: own } })),
    ).toEqual(['domain:already_own'])
    expect(
      await runOn(layer, addAlias({ entityId, keys: { domain: other } })),
    ).toEqual(['domain:suggested_duplicate'])
  })
})
