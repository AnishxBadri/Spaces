import { Effect } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { JobPermanent, PORT_NAMES } from './contract.ts'
import type {
  AliasClaim,
  AttributeProposal,
  ContentClaim,
  DocumentBytes,
  DocumentClaim,
  FactClaim,
  FilingTarget,
  IdentityClaim,
  IdentityKeys,
  InteractionClaim,
  JudgmentClaim,
  NoteProposal,
  ReceiptClaim,
  Ref,
  SignalClaim,
} from './contract.ts'
import { defineManifest } from './manifest.ts'
import { definePlugin } from './plugin.ts'

/** Every key of every member of a union. */
type KeysOf<T> = T extends unknown ? keyof T : never
type Provenance =
  'source' | 'actor' | 'actorType' | 'integrationId' | 'sourceRef'

describe('claims carry no provenance (D52)', () => {
  it('no claim type, nor any object nested in one, has a provenance key', () => {
    expectTypeOf<
      Extract<KeysOf<IdentityClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<IdentityKeys>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<AliasClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<FactClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<ReceiptClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<ContentClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<DocumentClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<DocumentBytes>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<FilingTarget>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<InteractionClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<SignalClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<JudgmentClaim>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<NoteProposal>, Provenance>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Extract<KeysOf<AttributeProposal>, Provenance>
    >().toEqualTypeOf<never>()
  })

  it('refuses a provenance field on a claim literal', () => {
    const smuggled: IdentityClaim = {
      kind: 'company',
      keys: { domain: 'stripe.com' },
      // @ts-expect-error — provenance is the port's, not the claim's
      sourceRef: '00000000-0000-0000-0000-000000000000',
    }
    expect(smuggled.kind).toBe('company')
  })
})

describe('content claims', () => {
  it('are told apart by _tag, so an interaction carrying document fields fails', () => {
    const interaction: InteractionClaim = {
      _tag: 'interaction',
      kind: 'meeting',
      occurredAt: '2026-09-30T10:00:00Z',
      entityIds: ['e1'],
    }
    const confused: ContentClaim = {
      _tag: 'interaction',
      kind: 'email',
      occurredAt: '2026-09-30T10:00:00Z',
      entityIds: ['e1'],
      // @ts-expect-error — `fileAgainst` is a document's field
      fileAgainst: [{ kind: 'record', entityId: 'e1' }],
    }
    expect([interaction._tag, confused._tag]).toEqual([
      'interaction',
      'interaction',
    ])
  })

  it('an interaction names at least one entity', () => {
    const none: InteractionClaim = {
      _tag: 'interaction',
      kind: 'call',
      occurredAt: '2026-09-30T10:00:00Z',
      // @ts-expect-error — an interaction with no entity has nowhere to live
      entityIds: [],
    }
    expect(none.kind).toBe('call')
  })
})

describe('refs are the D4 grammar', () => {
  it('accepts grammar refs and refuses a bare URL', () => {
    const refs: ReadonlyArray<Ref> = [
      'event:3f0c',
      'doc:e1#0',
      'attr:e1:funding_stage',
      'interaction:9a',
    ]
    // @ts-expect-error — a URL is not a ref; cite the signal it was emitted as
    const url: Ref = 'https://example.com/post'
    expect([refs.length, url]).toEqual([4, 'https://example.com/post'])
  })
})

describe('PORT_NAMES', () => {
  it('is the spec §4 table minus Clock', () => {
    expect(PORT_NAMES).toEqual([
      'Identity',
      'Facts',
      'Content',
      'Judgment',
      'Receipts',
      'Ai',
      'Read',
      'Secrets',
      'Config',
      'PluginDb',
      'Http',
      'Log',
    ])
  })
})

// The jobs below are checked by `pnpm typecheck`: each expect-error
// directive fails the gate if the line after it ever typechecks.
describe('definePlugin types each job by its trigger', () => {
  const manifest = defineManifest({
    manifestVersion: 1,
    id: 'triggers',
    version: '1.0.0',
    sdk: '^1.0',
    name: 'Triggers',
    description: 'One job per trigger.',
    settings: z.object({}),
    jobs: {
      enrich: { trigger: 'action', uses: ['Identity'] },
      sync: { trigger: 'schedule', uses: ['Http'], schedule: '*/15 * * * *' },
      onCreate: { trigger: 'event', uses: ['Facts'], on: ['entity.created'] },
      push: { trigger: 'webhook', uses: ['Content'] },
      importCsv: { trigger: 'file', uses: ['Identity'] },
    },
    ingress: { signature: 'hmac-sha256' },
  })

  const good = {
    enrich: {
      run: ({ entityId }: { entityId: string }) =>
        entityId
          ? Effect.void
          : Effect.fail(new JobPermanent({ reason: 'no id' })),
      cost: ({ entityIds }: { entityIds: ReadonlyArray<string> }) => ({
        credits: entityIds.length,
      }),
    },
    sync: ({ cursor }: { cursor: string | null }) =>
      Effect.succeed({ nextCursor: cursor }),
    onCreate: ({ event }: { event: { entityId: string } }) =>
      event.entityId ? Effect.void : Effect.void,
    push: ({ payload }: { payload: unknown }) =>
      payload === null ? Effect.void : Effect.void,
    importCsv: ({ filename }: { filename: string }) =>
      filename ? Effect.void : Effect.void,
  }

  it('accepts one well-shaped job per trigger', () => {
    const plugin = definePlugin({ manifest, jobs: good })
    expect(Object.keys(plugin.jobs).sort()).toEqual([
      'enrich',
      'importCsv',
      'onCreate',
      'push',
      'sync',
    ])
  })

  it('refuses a schedule job that returns no cursor', () => {
    const bad = () =>
      definePlugin({
        manifest,
        jobs: {
          ...good,
          // @ts-expect-error — a schedule job hands back { nextCursor }
          sync: () => Effect.void,
        },
      })
    expect(typeof bad).toBe('function')
  })

  it("refuses a webhook job shaped { verify, handle } — verification is core's", () => {
    const bad = () =>
      definePlugin({
        manifest,
        jobs: {
          ...good,
          // @ts-expect-error — a webhook job is a plain function of the stored payload
          push: { verify: () => true, handle: () => Effect.void },
        },
      })
    expect(typeof bad).toBe('function')
  })

  it('refuses an action job reading input.cursor', () => {
    const bad = () =>
      definePlugin({
        manifest,
        jobs: {
          ...good,
          enrich: (input) =>
            // @ts-expect-error — an action job is handed { entityId }, not a cursor
            input.cursor ? Effect.void : Effect.void,
        },
      })
    expect(typeof bad).toBe('function')
  })

  it('allows cost on action jobs only, returning { credits }', () => {
    const onSchedule = () =>
      definePlugin({
        manifest,
        jobs: {
          ...good,
          // @ts-expect-error — cost is an action job's hook (D53)
          sync: { run: good.sync, cost: () => ({ credits: 1 }) },
        },
      })
    const wrongShape = () =>
      definePlugin({
        manifest,
        jobs: {
          ...good,
          // @ts-expect-error — cost returns { credits: number }, not a number
          enrich: { run: good.enrich.run, cost: () => 3 },
        },
      })
    expect([typeof onSchedule, typeof wrongShape]).toEqual([
      'function',
      'function',
    ])
  })
})
