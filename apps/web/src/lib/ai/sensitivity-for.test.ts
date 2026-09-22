import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, entitySpace, space, workspace } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { completeMessage, completeProgram } from './complete'
import { setAiRouteProgram } from './route'
import { sensitivityFor, setEntitySensitiveProgram } from './sensitivity-for'

/**
 * SPA-61. `sensitivityFor` against Postgres, over the resolver's cases with
 * a three-level space tree — Hydrogen › Green hydrogen › Electrolysers —
 * and a company filed at the bottom of it. Then the demo: flag Hydrogen,
 * route extract at a cloud provider, and `complete()` refuses naming the
 * space; route it at Ollama and the same call runs.
 *
 * The binding case is the resolver's alone (`sensitivity.test.ts`):
 * `storage_binding` is storage-8a's table and does not exist yet, so the
 * gatherer passes no binding.
 */

async function mkEntity(
  kind: 'space' | 'company' | 'deal',
  name: string,
): Promise<string> {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('insert returned nothing')
  return row.id
}

async function mkSpace(name: string, path: string, parentId: string | null) {
  const id = await mkEntity('space', name)
  const slug = path.split('.').at(-1) ?? path
  await db.insert(space).values({ entityId: id, parentId, slug, path })
  return id
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId, source: 'manual' })

const flag = (entityId: string, sensitive = true) =>
  Effect.runPromise(setEntitySensitiveProgram(entityId, sensitive))

const read = (entityId: string) => Effect.runPromise(sensitivityFor(entityId))

let root: string
let mid: string
let leaf: string
let other: string
let company: string

beforeEach(async () => {
  // Every test builds its own tree, so only the singleton needs resetting.
  await db.delete(workspace).where(eq(workspace.id, 1))
  const tag = Math.random().toString(36).slice(2, 8)
  root = await mkSpace('Hydrogen', `hy_${tag}`, null)
  mid = await mkSpace('Green hydrogen', `hy_${tag}.green`, root)
  leaf = await mkSpace('Electrolysers', `hy_${tag}.green.elec`, mid)
  other = await mkSpace('Aerospace', `aero_${tag}`, null)
  company = await mkEntity('company', `Electra ${tag}`)
  await file(company, leaf)
})

describe('sensitivityFor', () => {
  it('nothing sensitive', async () => {
    expect(await read(company)).toEqual({ own: false, sensitivity: 'normal' })
  })

  it('own flag', async () => {
    await flag(company)
    expect(await read(company)).toEqual({
      own: true,
      sensitivity: 'sensitive',
      via: { kind: 'own' },
    })
  })

  it('filed space', async () => {
    await flag(leaf)
    expect(await read(company)).toEqual({
      own: false,
      sensitivity: 'sensitive',
      via: { kind: 'space', name: 'Electrolysers' },
    })
  })

  it('ancestor space, three levels up — and inheritance writes no row', async () => {
    await flag(root)
    expect(await read(company)).toEqual({
      own: false,
      sensitivity: 'sensitive',
      via: { kind: 'space', name: 'Hydrogen' },
    })
    // A subspace inherits from its own ancestors too.
    expect(await read(mid)).toMatchObject({
      own: false,
      via: { kind: 'space', name: 'Hydrogen' },
    })
    const stored = await db
      .select({ sensitive: entity.sensitive })
      .from(entity)
      .where(eq(entity.id, company))
    expect(stored).toEqual([{ sensitive: false }])
  })

  it('names the nearest sensitive space when several are', async () => {
    await flag(root)
    await flag(mid)
    expect((await read(company)).sensitivity).toBe('sensitive')
    expect(await read(company)).toMatchObject({
      via: { kind: 'space', name: 'Green hydrogen' },
    })
  })

  it('workspace default', async () => {
    await db.insert(workspace).values({
      id: 1,
      name: 'Fund',
      settings: { base_currency: 'USD', sensitivity_default: 'sensitive' },
    })
    expect(await read(company)).toEqual({
      own: false,
      sensitivity: 'sensitive',
      via: { kind: 'default' },
    })
  })

  it('is a cautious OR: filed in two places, one sensitive, resolves sensitive', async () => {
    await file(company, other)
    await flag(other)
    expect(await read(company)).toMatchObject({
      sensitivity: 'sensitive',
      via: { kind: 'space', name: 'Aerospace' },
    })
  })

  it('a record filed nowhere resolves the workspace default', async () => {
    const loose = await mkEntity('deal', 'Loose deal')
    expect(await read(loose)).toEqual({ own: false, sensitivity: 'normal' })
    await db.insert(workspace).values({
      id: 1,
      name: 'Fund',
      settings: { sensitivity_default: 'sensitive' },
    })
    expect((await read(loose)).sensitivity).toBe('sensitive')
  })

  it('fails SensitivityEntityNotFound for an unknown id', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(sensitivityFor('00000000-0000-4000-8000-000000000000')),
    )
    expect(failure._tag).toBe('SensitivityEntityNotFound')
  })
})

function mockModel() {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Series A' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

describe('complete() over sensitivityFor', () => {
  const route = (provider: 'anthropic' | 'ollama') =>
    Effect.runPromise(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'sensitive',
        provider,
        model: provider === 'ollama' ? 'llama3.1' : 'claude-haiku-4-5',
      }),
    )

  const call = async (subject: string) => {
    const resolved = await read(subject)
    return completeProgram('extract', [], undefined, {
      caller: { type: 'user', id: FIXTURE_ACTOR.id },
      ...resolved,
      budgetChars: 1000,
      task: 'Read the deck.',
      model: mockModel(),
    })
  }

  it('refuses a record under a sensitive space at a cloud provider, naming the space; runs at Ollama', async () => {
    await flag(root)
    await route('anthropic')
    const refused = await Effect.runPromise(Effect.flip(await call(company)))
    expect(refused._tag).toBe('SensitiveRouteRefused')
    expect(completeMessage(refused)).toBe(
      'Sensitive material is not sent to Anthropic (sensitivity inherited from Hydrogen); route the extract lane to a local model',
    )

    await route('ollama')
    const ran = await Effect.runPromise(await call(company))
    expect(ran.target.provider).toBe('ollama')
    expect(ran.output).toEqual({ kind: 'text', text: 'Series A' })
  })

  it('a deal flagged on its own in an unflagged space refuses with no space named', async () => {
    const deal = await mkEntity('deal', 'Flagged deal')
    await file(deal, other)
    await flag(deal)
    await route('anthropic')
    const refused = await Effect.runPromise(Effect.flip(await call(deal)))
    expect(completeMessage(refused)).toBe(
      'Sensitive material is not sent to Anthropic; route the extract lane to a local model',
    )
  })
})
