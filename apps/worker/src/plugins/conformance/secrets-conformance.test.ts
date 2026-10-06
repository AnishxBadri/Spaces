import { Context, Effect, Layer, Option, Redacted } from 'effect'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { storeCredential } from '@spaces/core/writes/vault'
import { Secrets } from '@spaces/sdk'
import { SecretsTest } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { grantLayer } from '../grant'
import { exitOn, failureOf, insertRow, noEnqueue, runOn } from './support'

/**
 * The Secrets port's contract, over every implementation: the bound key
 * comes back redacted, no key is a permanent failure, and an OAuth token is
 * `NotConnected` until a connection exists. The live entry is the grant's
 * Secrets over a vault credential, exactly what a job is handed.
 */

type SecretsImplementation = {
  readonly name: string
  /** The port for an integration keyed with `secret`, or with none. */
  readonly make: (secret: string | null) => Promise<Layer.Layer<Secrets>>
}

const IMPLEMENTATIONS: ReadonlyArray<SecretsImplementation> = [
  {
    name: 'SecretsLive (the grant, over the vault)',
    make: async (secret) => {
      const credentialId =
        secret === null
          ? null
          : (
              await storeCredential({
                scope: 'workspace',
                provider: 'conformance',
                kind: 'enrichment',
                secret,
                createdBy: FIXTURE_ACTOR.id,
              })
            ).id
      const row = await insertRow(
        'conformance',
        credentialId === null ? {} : { credentialId },
      )
      const context = await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            grantLayer(row, ['Secrets'], {
              settings: z.object({}),
              enqueue: noEnqueue,
            }),
          ),
        ),
      )
      return Layer.succeed(
        Secrets,
        Option.getOrThrow(Context.getOption(context, Secrets)),
      )
    },
  },
  {
    name: 'SecretsTest',
    make: (secret) =>
      Promise.resolve(SecretsTest(secret === null ? {} : { secret }).layer),
  },
]

const get = Effect.gen(function* () {
  return yield* (yield* Secrets).get()
})

const accessToken = Effect.gen(function* () {
  return yield* (yield* Secrets).accessToken()
})

describe.each(IMPLEMENTATIONS)('Secrets — $name', (impl) => {
  it('hands back the bound key, redacted', async () => {
    const key = await runOn(await impl.make('sk-conformance-0123456789'), get)
    expect(Redacted.value(key)).toBe('sk-conformance-0123456789')
    expect(String(key)).not.toContain('0123456789')
  })

  it('fails permanently when no key is bound', async () => {
    const failure = failureOf(await exitOn(await impl.make(null), get))
    expect(failure?._tag).toBe('JobPermanent')
  })

  it('has no OAuth token without a connection', async () => {
    const failure = failureOf(
      await exitOn(await impl.make('sk-conformance-0123456789'), accessToken),
    )
    expect(failure?._tag).toBe('NotConnected')
  })
})
