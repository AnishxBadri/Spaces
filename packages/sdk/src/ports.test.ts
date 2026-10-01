import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PORT_NAMES } from './contract.ts'
import * as sdk from './index.ts'
import { defineManifest } from './manifest.ts'
import { definePlugin } from './plugin.ts'
import { ConfigTest } from './testing/index.ts'
import { Facts, Identity, PORTS, configOf } from './ports.ts'

describe('the port tags', () => {
  // The keys are how the host's Layer finds the tag a bundle yields — part
  // of the contract. Changing this snapshot is an SDK major.
  it('have stable service keys', () => {
    expect(
      Object.fromEntries(
        Object.entries(PORTS).map(([name, tag]) => [name, tag.key]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "Ai": "spaces/sdk/Ai",
        "Config": "spaces/sdk/Config",
        "Content": "spaces/sdk/Content",
        "Facts": "spaces/sdk/Facts",
        "Http": "spaces/sdk/Http",
        "Identity": "spaces/sdk/Identity",
        "Judgment": "spaces/sdk/Judgment",
        "Log": "spaces/sdk/Log",
        "PluginDb": "spaces/sdk/PluginDb",
        "Read": "spaces/sdk/Read",
        "Receipts": "spaces/sdk/Receipts",
        "Secrets": "spaces/sdk/Secrets",
      }
    `)
  })

  it('cover PORT_NAMES exactly — one tag per name', () => {
    expect(Object.keys(PORTS)).toEqual([...PORT_NAMES])
  })

  it('declare no Clock — plugin code reads time through Effect', () => {
    expect(PORT_NAMES).not.toContain('Clock')
    expect(Object.keys(sdk)).not.toContain('Clock')
  })
})

describe('configOf', () => {
  const manifest = defineManifest({
    manifestVersion: 1,
    id: 'exa',
    version: '1.0.0',
    sdk: '^1.0',
    name: 'Exa',
    description: 'Web research.',
    settings: z.object({ maxResults: z.int().default(5) }),
    jobs: { research: { trigger: 'action', uses: ['Config'] } },
  })

  it('parses the stored config by the manifest settings, defaults applied', async () => {
    const config = await Effect.runPromise(
      configOf(manifest).pipe(Effect.provide(ConfigTest({}).layer)),
    )
    expect(config).toEqual({ maxResults: 5 })
  })

  it('fails permanently on a config that does not parse', async () => {
    const exit = await Effect.runPromiseExit(
      configOf(manifest).pipe(
        Effect.provide(ConfigTest({ maxResults: 'many' }).layer),
      ),
    )
    expect(exit._tag).toBe('Failure')
  })
})

// Checked by `pnpm typecheck`: each expect-error directive fails the gate if
// the line after it ever typechecks.
describe("a job's R is bounded by its uses (D51)", () => {
  const manifest = defineManifest({
    manifestVersion: 1,
    id: 'bounded',
    version: '1.0.0',
    sdk: '^1.0',
    name: 'Bounded',
    description: 'Declares Identity only.',
    settings: z.object({}),
    jobs: { enrich: { trigger: 'action', uses: ['Identity'] } },
  })

  it('accepts a job that yields only what it declared', () => {
    const plugin = definePlugin({
      manifest,
      jobs: {
        enrich: ({ entityId }) =>
          Effect.gen(function* () {
            const identity = yield* Identity
            yield* identity.resolve({
              kind: 'company',
              keys: {},
              name: entityId,
            })
          }),
      },
    })
    expect(Object.keys(plugin.jobs)).toEqual(['enrich'])
  })

  it('refuses a job that yields Facts without listing it', () => {
    const undeclared = () =>
      definePlugin({
        manifest,
        jobs: {
          // @ts-expect-error — Facts is not in this job's uses
          enrich: ({ entityId }) =>
            Effect.gen(function* () {
              const facts = yield* Facts
              yield* facts.fill({ entityId, values: {} })
            }),
        },
      })
    expect(typeof undeclared).toBe('function')
  })
})
