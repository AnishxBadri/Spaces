import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiRoute,
  attribute,
  credential,
  entity,
  link,
  note,
  suggestion,
  workspace,
} from '@spaces/db/schema'
import { readOptionProposals } from '@spaces/core/ai/attribute-ai'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { enqueued } from '#web/test/queue-stub'
import { storeCredential } from '@spaces/core/writes/vault'
import {
  addProposedOptionProgram,
  attributeRunProgram,
  attributeRunStatusProgram,
  cellKey,
  openCellProposalsProgram,
  pressAttributeRunProgram,
  splitClassifyValue,
} from '#web/lib/ai/attribute-run'
import { acceptProgram, rejectProgram } from '#web/lib/ai/propose'
import { setAiRouteProgram } from '#web/lib/ai/route'
import {
  createObjectProgram,
  createRecordProgram,
} from '@spaces/core/writes/attributes/object-registry'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { updateAttributeProgram } from '@spaces/core/writes/attributes/update'
import { JobPermanent } from '../run-job'
import { runAttributeRun } from './attribute-run'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * SPA-72, one AI attribute cell end to end — on a custom "Fund" object, so
 * the affordance is shown to need no AI-specific code per object: the
 * config written through the attribute's own update path, the press, the
 * run through an injected model (`MockLanguageModelV4`, no network), the
 * suggestion with its rationale and refs, the cell's "proposed" state, the
 * registry proposal for an option the attribute lacks, and the decision.
 */

const USER = FIXTURE_ACTOR.id
const DECIDER = { type: 'user', id: USER } as const
const ME = { type: 'user', id: USER } as const

/**
 * A model that answers `answer(refs)`, handed the refs the rendered prompt
 * carried — so an answer can cite what the assembler actually gave it.
 */
function mockModel(answer: (refs: Array<string>) => object) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) => {
      const text = JSON.stringify(options.prompt)
      const refs = [...text.matchAll(/\[([a-z]+:[^\]\s]+)\]/g)].map((m) => m[1])
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer(refs)) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      })
    },
  })
}

async function routeLanes() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-attribute-run',
    meta: {},
    createdBy: USER,
  })
  for (const lane of ['classify', 'synthesize'] as const)
    await Effect.runPromise(
      setAiRouteProgram({
        lane,
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    )
}

const run = (
  entityId: string,
  attributeId: string,
  answer: (refs: Array<string>) => object,
) => {
  const model = mockModel(answer)
  return Effect.runPromise(
    attributeRunProgram({ entityId, attributeId, userId: USER, model }),
  ).then((result) => ({ result, model }))
}

const patchesOf = (entityId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(
        eq(suggestion.entityId, entityId),
        eq(suggestion.kind, 'attribute_patch'),
      ),
    )

async function noteOn(recordId: string, bodyMd: string) {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Call', createdBy: USER })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('insert returned nothing')
  await db.insert(note).values({
    entityId: ent.id,
    title: 'Call',
    bodyMd,
    authorId: USER,
    visibility: 'shared',
  })
  await db.insert(link).values({
    fromEntityId: ent.id,
    toEntityId: recordId,
    relation: 'tagged_in',
    source: 'manual',
  })
}

let fundObject: string
let strategy: string
let whyNow: string
let vintage: string
let fund: string

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
  await db.delete(workspace).where(eq(workspace.id, 1))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const tag = Math.random().toString(36).slice(2, 8)
  fundObject = (
    await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: USER,
      }),
    )
  ).id
  strategy = (
    await Effect.runPromise(
      createAttributeProgram({
        objectId: fundObject,
        name: 'Strategy',
        type: 'select',
        options: [{ label: 'Venture' }, { label: 'Buyout' }],
        createdBy: USER,
      }),
    )
  ).id
  whyNow = (
    await Effect.runPromise(
      createAttributeProgram({
        objectId: fundObject,
        name: 'Why now?',
        type: 'text',
        createdBy: USER,
      }),
    )
  ).id
  vintage = (
    await Effect.runPromise(
      createAttributeProgram({
        objectId: fundObject,
        name: 'Vintage',
        type: 'number',
        createdBy: USER,
      }),
    )
  ).id
  fund = (
    await Effect.runPromise(
      createRecordProgram({
        objectId: fundObject,
        name: `Northwind Fund I ${tag}`,
        actor: ME,
        source: 'manual',
      }),
    )
  ).id
  await noteOn(fund, 'Northwind raises a seed-stage venture fund in 2026.')
})

afterEach(() => {
  vi.restoreAllMocks()
})

const configure = (
  id: string,
  ai: {
    mode: 'classify' | 'summarize' | 'prompt' | 'research'
    prompt: string
  },
) => Effect.runPromise(updateAttributeProgram({ id, config: { ai } }))

describe('the config — options.ai, the spec’s config.ai', () => {
  it('is written through the attribute’s update path, lane from the mode', async () => {
    await configure(whyNow, {
      mode: 'prompt',
      prompt: 'Why is {{strategy}} the right bet now?',
    })
    const row = (
      await db.select().from(attribute).where(eq(attribute.id, whyNow))
    ).at(0)
    expect(row?.options.ai).toEqual({
      mode: 'prompt',
      prompt: 'Why is {{strategy}} the right bet now?',
      variables: ['strategy'],
      lane: 'synthesize',
    })
  })

  it('refuses a mode the type cannot hold: classify on text, summarize on select', async () => {
    await expect(
      configure(whyNow, { mode: 'classify', prompt: '' }),
    ).rejects.toThrow(/not a mode a text attribute can hold/)
    await expect(
      configure(strategy, { mode: 'summarize', prompt: '' }),
    ).rejects.toThrow(/not a mode a select attribute can hold/)
  })
})

describe('an attribute with no ai config', () => {
  it('has no trigger to press: a press is refused and nothing is queued', async () => {
    await routeLanes()
    const pressed = await Effect.runPromise(
      pressAttributeRunProgram(fund, vintage, USER),
    )
    expect(pressed).toEqual({
      status: 'refused',
      message: 'Vintage is not an AI attribute',
    })
    expect(enqueued).toEqual([])
  })
})

describe('one cell on a custom object', () => {
  it('press → one job keyed on the cell; a second press is already running', async () => {
    await routeLanes()
    await configure(whyNow, { mode: 'prompt', prompt: 'Why now?' })
    expect(
      await Effect.runPromise(pressAttributeRunProgram(fund, whyNow, USER)),
    ).toEqual({ status: 'queued' })
    expect(enqueued).toEqual([
      {
        name: QUEUES.attributeRun,
        data: { entityId: fund, attributeId: whyNow, userId: USER },
        options: { singletonKey: cellKey(fund, whyNow) },
      },
    ])
    expect(
      await Effect.runPromise(pressAttributeRunProgram(fund, whyNow, USER)),
    ).toEqual({ status: 'already-running' })
    expect(
      await Effect.runPromise(attributeRunStatusProgram(fund, whyNow)),
    ).toEqual({ state: 'running' })
  })

  it('an unrouted lane is refused at the button', async () => {
    await configure(whyNow, { mode: 'prompt', prompt: 'Why now?' })
    const pressed = await Effect.runPromise(
      pressAttributeRunProgram(fund, whyNow, USER),
    )
    expect(pressed.status).toBe('refused')
    expect(enqueued).toEqual([])
  })

  it('a run writes one suggestion with rationale and refs; the cell reads proposed; a re-run is refused', async () => {
    await routeLanes()
    await configure(whyNow, {
      mode: 'prompt',
      prompt: 'Why is a {{strategy}} fund raising now?',
    })
    const { result, model } = await run(fund, whyNow, (refs) => ({
      why_now: {
        value: 'Seed valuations have reset after 2025.',
        refs: refs.slice(0, 1),
        confidence: 0.7,
      },
      reason: 'The call note dates the raise.',
    }))
    // The context is the assembler, not the values alone: the note is in it.
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      'seed-stage venture fund',
    )
    // The schema is the registry's, narrowed to the one attribute.
    const format = model.doGenerateCalls[0].responseFormat
    const schema = format?.type === 'json' ? format.schema : undefined
    expect(Object.keys(Reflect.get(schema ?? {}, 'properties') ?? {})).toEqual([
      'why_now',
      'reason',
    ])

    expect(result.skipped).toBeNull()
    expect(result.suggestions).toHaveLength(1)
    const rows = await patchesOf(fund)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.status).toBe('open')
    expect(row.rationale).toContain('The call note dates the raise.')
    expect(row.refs.length).toBeGreaterThan(0)
    expect(row.payload).toMatchObject({
      why_now: { value: 'Seed valuations have reset after 2025.' },
    })
    // A suggestion, never a value.
    const held = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, fund))
    ).at(0)
    expect(held?.values.why_now).toBeUndefined()

    expect(await Effect.runPromise(openCellProposalsProgram([fund]))).toEqual([
      { entityId: fund, slug: 'why_now' },
    ])
    expect(
      await Effect.runPromise(pressAttributeRunProgram(fund, whyNow, USER)),
    ).toEqual({ status: 'already-proposed' })
    const again = await Effect.runPromise(
      Effect.result(
        attributeRunProgram({
          entityId: fund,
          attributeId: whyNow,
          userId: USER,
          model: mockModel(() => ({ reason: 'x' })),
        }),
      ),
    )
    expect(again._tag).toBe('Failure')
    expect(await patchesOf(fund)).toHaveLength(1)

    // A person decides: the value lands, by the accepter, and the cell clears.
    await Effect.runPromise(acceptProgram(row.id, DECIDER))
    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, fund))
    ).at(0)
    expect(after?.values.why_now).toBe('Seed valuations have reset after 2025.')
    expect(await Effect.runPromise(openCellProposalsProgram([fund]))).toEqual(
      [],
    )
  })

  it('no answer writes nothing and does not raise', async () => {
    await routeLanes()
    await configure(whyNow, { mode: 'summarize', prompt: '' })
    const { result } = await run(fund, whyNow, () => ({ reason: 'nothing' }))
    expect(result.suggestions).toEqual([])
    expect(result.skipped).toContain('no answer for Why now?')
    expect(await patchesOf(fund)).toEqual([])
  })
})

describe('classify — a new option is a registry proposal', () => {
  it('an off-registry option is never a value and never a silent option; Add option goes through the option-list edit', async () => {
    await routeLanes()
    await configure(strategy, { mode: 'classify', prompt: '' })
    const { result } = await run(fund, strategy, (refs) => ({
      strategy: { value: 'Secondaries', refs, confidence: 0.6 },
      reason: 'It buys LP stakes.',
    }))
    expect(result.proposedOptions).toEqual(['Secondaries'])
    const rows = await patchesOf(fund)
    expect(rows).toHaveLength(1)
    const proposal = rows[0]
    // No value in the patch, the option named in the rationale.
    expect(proposal.payload).toEqual({})
    expect(readOptionProposals(proposal.rationale)).toEqual([
      { slug: 'strategy', name: 'Strategy', label: 'Secondaries' },
    ])
    const before = (
      await db.select().from(attribute).where(eq(attribute.id, strategy))
    ).at(0)
    expect(before?.options.options?.map((o) => o.label)).toEqual([
      'Venture',
      'Buyout',
    ])
    // The cell reads proposed on the registry proposal too.
    expect(await Effect.runPromise(openCellProposalsProgram([fund]))).toEqual([
      { entityId: fund, slug: 'strategy' },
    ])

    const added = await Effect.runPromise(
      addProposedOptionProgram(proposal.id, 'Secondaries', USER),
    )
    expect(added).toEqual({
      attribute: 'Strategy',
      label: 'Secondaries',
      added: true,
    })
    const after = (
      await db.select().from(attribute).where(eq(attribute.id, strategy))
    ).at(0)
    expect(after?.options.options?.map((o) => o.label)).toEqual([
      'Venture',
      'Buyout',
      'Secondaries',
    ])
    const closed = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposal.id))
    ).at(0)
    expect(closed?.status).toBe('accepted')
    expect(closed?.decidedBy).toBe(USER)

    // The cell is free again, and the new option is now vocabulary.
    const second = await run(fund, strategy, (refs) => ({
      strategy: { value: 'secondaries', refs, confidence: 0.8 },
      reason: 'It buys LP stakes.',
    }))
    expect(second.result.proposedOptions).toEqual([])
    expect(second.result.suggestions).toHaveLength(1)
    expect(second.result.suggestions[0].payload).toMatchObject({
      strategy: { value: 'secondaries' },
    })
  })

  it('a rejected option is not proposed again for that cell', async () => {
    await routeLanes()
    await configure(strategy, { mode: 'classify', prompt: '' })
    const first = await run(fund, strategy, () => ({
      newOption: 'Growth',
      reason: 'x',
    }))
    expect(first.result.proposedOptions).toEqual(['Growth'])
    await Effect.runPromise(
      rejectProgram(first.result.suggestions[0].id, DECIDER),
    )
    const second = await run(fund, strategy, () => ({
      newOption: 'growth',
      reason: 'y',
    }))
    expect(second.result.suggestions).toEqual([])
    expect(second.result.skipped).toContain('rejected')
  })

  it('splitClassifyValue is the rule, pure', () => {
    const def = {
      name: 'Stage',
      type: 'multi_select' as const,
      options: {
        options: [
          { id: 'seed', label: 'Seed' },
          { id: 'a', label: 'Series A' },
          { id: 'old', label: 'Old', archived: true },
        ],
      },
    }
    expect(
      splitClassifyValue(def, ['seed', 'Series A', 'old', 'Pre-seed', 'seed']),
    ).toEqual({
      value: ['seed', 'a'],
      wanted: ['Pre-seed'],
      dropped: ['Old is an archived option of Stage'],
    })
    expect(splitClassifyValue({ ...def, type: 'select' }, 'Growth')).toEqual({
      wanted: ['Growth'],
      dropped: [],
    })
    expect(splitClassifyValue({ ...def, type: 'checkbox' }, true)).toEqual({
      value: true,
      wanted: [],
      dropped: [],
    })
  })
})

describe('the job', () => {
  it('a refused run is permanent, with the sentence', async () => {
    await configure(whyNow, { mode: 'prompt', prompt: 'x' })
    const outcome = await Effect.runPromise(
      Effect.result(
        runAttributeRun(
          { entityId: fund, attributeId: whyNow, userId: USER },
          { model: mockModel(() => ({ reason: 'x' })) },
        ),
      ),
    )
    expect(outcome._tag).toBe('Failure')
    if (outcome._tag === 'Failure') {
      expect(outcome.failure).toBeInstanceOf(JobPermanent)
      expect(outcome.failure.reason).toContain('synthesize')
    }
  })
})
