import { describe, expect, it } from 'vitest'

/**
 * The record rail's Waiting group and the inbox it links into: open
 * suggestions on one record counted and titled, rejected ones gone for
 * good, and `listInboxProgram` narrowed to one record across both lanes.
 * The test database is truncated and reseeded before the file, so there is
 * no cleanup here.
 */

async function world() {
  const { Effect } = await import('effect')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const { duplicateCandidate } = await import('@spaces/db/schema')
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  const { proposeProgram } =
    await import('@spaces/core/writes/suggestions/propose')

  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')

  const company = async (name: string, domain: string) =>
    (
      await resolveEntity({
        kind: 'company',
        name,
        keys: { domain },
        source: { class: 'manual' },
      })
    ).entityId
  const acme = await company('Acme Waiting', 'acme-waiting.example')
  const bolt = await company('Bolt Waiting', 'bolt-waiting.example')
  const cask = await company('Cask Waiting', 'cask-waiting.example')
  const idle = await company('Idle Waiting', 'idle-waiting.example')

  const propose = async (
    entityId: string,
    kind: 'attribute_patch' | 'note',
    payload: Parameters<typeof proposeProgram>[0]['payload'],
  ) =>
    (
      await Effect.runPromise(
        proposeProgram({
          entityId,
          kind,
          payload,
          rationale: 'from the deck',
          proposedBy: { type: 'system' },
        }),
      )
    ).id

  const patch = (slug: string, value: string | number) => ({
    [slug]: { value, refs: [], confidence: 0.7 },
  })

  const acmeFounded = await propose(
    acme,
    'attribute_patch',
    patch('founded_year', 2019),
  )
  const acmeLocation = await propose(
    acme,
    'attribute_patch',
    patch('location', 'Lisbon'),
  )
  const acmeNote = await propose(acme, 'note', {
    title: 'Met at demo day',
    markdown: 'Met at demo day.',
    sourceId: acme,
  })
  const boltLocation = await propose(
    bolt,
    'attribute_patch',
    patch('location', 'Rotterdam'),
  )

  // Acme is one side of a pair; Bolt and Cask are the other pair.
  const pair = async (a: string, b: string) => {
    const row = (
      await db
        .insert(duplicateCandidate)
        .values({
          entityA: a,
          entityB: b,
          score: 0.9,
          reason: { name_similarity: 'true' },
        })
        .returning({ id: duplicateCandidate.id })
    ).at(0)
    if (!row) throw new Error('pair insert returned no row')
    return row.id
  }
  const acmePair = await pair(cask, acme)
  const boltPair = await pair(bolt, cask)

  return {
    me: me.id,
    acme,
    bolt,
    idle,
    acmeFounded,
    acmeLocation,
    acmeNote,
    boltLocation,
    acmePair,
    boltPair,
  }
}

let fixture: Awaited<ReturnType<typeof world>> | undefined
const setup = async () => (fixture ??= await world())

describe('listOpenSuggestionTitlesProgram — the rail’s Waiting rows', () => {
  it('counts one record’s open suggestions and titles the newest, a patch by its attribute’s name', async () => {
    const { Effect } = await import('effect')
    const { listOpenSuggestionTitlesProgram } = await import('./queue')
    const f = await setup()

    const acme = await Effect.runPromise(
      listOpenSuggestionTitlesProgram(f.acme),
    )
    expect(acme.count).toBe(3)
    expect(acme.items.map((i) => [i.id, i.title])).toEqual([
      [f.acmeNote, 'Met at demo day'],
      [f.acmeLocation, 'Location'],
      [f.acmeFounded, 'Founded'],
    ])
    expect(
      await Effect.runPromise(listOpenSuggestionTitlesProgram(f.idle)),
    ).toEqual({ count: 0, items: [] })
  })
})

describe('listOpenSuggestionTitlesProgram — what the count leaves out', () => {
  const countOf = async (entityId: string) => {
    const { Effect } = await import('effect')
    const { listOpenSuggestionTitlesProgram } = await import('./queue')
    return (await Effect.runPromise(listOpenSuggestionTitlesProgram(entityId)))
      .count
  }

  it('never counts another record’s suggestions', async () => {
    const f = await setup()
    expect(await countOf(f.bolt)).toBe(1)
  })

  it('never counts a rejected suggestion again', async () => {
    const { Effect } = await import('effect')
    const { rejectProgram } = await import('#/lib/ai/propose')
    const f = await setup()

    await Effect.runPromise(
      rejectProgram(f.acmeNote, { type: 'user', id: f.me }),
    )
    expect(await countOf(f.acme)).toBe(2)
    await Effect.runPromise(
      rejectProgram(f.boltLocation, { type: 'user', id: f.me }),
    )
    expect(await countOf(f.bolt)).toBe(0)
  })
})

describe('listInboxProgram — scoped to one record', () => {
  it('narrows both lanes to the record: its card and every pair it is in', async () => {
    const { Effect } = await import('effect')
    const { listInboxProgram } = await import('./queue')
    const f = await setup()

    const rows = await Effect.runPromise(listInboxProgram({ record: f.acme }))
    const cards = rows.filter((r) => r.kind === 'suggestion')
    const pairs = rows.filter((r) => r.kind === 'duplicate_candidate')

    expect(cards.map((c) => c.id)).toEqual([f.acme])
    expect(cards.flatMap((c) => c.suggestions.map((s) => s.id)).sort()).toEqual(
      [f.acmeFounded, f.acmeLocation].sort(),
    )
    // Acme is side B of its pair — either side scopes it in.
    expect(pairs.map((p) => p.id)).toEqual([f.acmePair])
  })

  it('is the whole queue when unscoped, and empty for a record with nothing open', async () => {
    const { Effect } = await import('effect')
    const { listInboxProgram, inboxScopeRecordProgram } =
      await import('./queue')
    const f = await setup()

    const all = await Effect.runPromise(listInboxProgram())
    expect(all.filter((r) => r.kind === 'duplicate_candidate')).toHaveLength(2)

    expect(
      await Effect.runPromise(listInboxProgram({ record: f.idle })),
    ).toEqual([])
    // The header still names the record an emptied queue is scoped to.
    expect(await Effect.runPromise(inboxScopeRecordProgram(f.idle))).toEqual({
      id: f.idle,
      name: 'Idle Waiting',
    })
  })
})
