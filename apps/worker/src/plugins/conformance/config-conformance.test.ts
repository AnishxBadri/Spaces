import { Effect } from 'effect'
import type { Layer } from 'effect'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { IntegrationConfig } from '@spaces/db/schema/integrations'
import { ConfigLive } from '@spaces/core/writes/ports/config'
import type { ConfigInvalid } from '@spaces/core/writes/ports/config'
import { Config } from '@spaces/sdk'
import { ConfigTest } from '@spaces/sdk/testing'
import { insertRow, runOn } from './support'

/**
 * The Config port's contract, over every implementation: `get()` is the
 * integration's settings exactly as stored — defaults are the plugin's own
 * `configOf` read, never the port's. (Refusing an invalid row is the live
 * Layer's alone: the in-memory one has no schema to refuse with.)
 */

type ConfigImplementation = {
  readonly name: string
  /** Live may refuse the row (`ConfigInvalid`) when it builds. */
  readonly make: (
    config: IntegrationConfig,
  ) => Promise<Layer.Layer<Config, ConfigInvalid>>
}

/** A plugin's settings with a default, so "as stored" is observable. */
const settings = z.object({
  cacheDays: z.int().min(0).default(90),
  autoEnrich: z.boolean().default(false),
  label: z.string().optional(),
})

const IMPLEMENTATIONS: ReadonlyArray<ConfigImplementation> = [
  {
    name: 'ConfigLive',
    make: async (config) =>
      ConfigLive(await insertRow('conformance', { config }), settings),
  },
  {
    name: 'ConfigTest',
    make: (config) => Promise.resolve(ConfigTest(config).layer),
  },
]

const get = Effect.gen(function* () {
  return yield* (yield* Config).get()
})

describe.each(IMPLEMENTATIONS)('Config — $name', (impl) => {
  it('hands back the stored settings', async () => {
    const stored = { cacheDays: 30, autoEnrich: true, label: 'Team A' }
    expect(await runOn(await impl.make(stored), get)).toEqual(stored)
  })

  it('applies no defaults: an empty row reads as empty', async () => {
    expect(await runOn(await impl.make({}), get)).toEqual({})
  })
})
