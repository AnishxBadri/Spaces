import { describe, expect, it } from 'vitest'

/**
 * SPA-98. The inbox's second lane: open suggestions grouped one card per
 * record, sharing the queue with duplicate pairs newest-first, and one
 * `UNION ALL` count over both tables. Integration against this worker's test
 * database, truncated and reseeded before the file was imported (SPA-145) —
 * no cleanup here, and the tests below build on each other's rows.
 */

async function world() {
  const { Effect } = await import('effect')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const { duplicateCandidate, suggestion } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const { resolveEntity } = await import('#/lib/entities/resolve')
  const { proposeProgram } = await import('#/lib/ai/propose')

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
  const acme = await company('Acme Robotics', 'acme-robotics.example')
  const bolt = await company('Bolt Freight', 'bolt-freight.example')
  const cask = await company('Cask Labs', 'cask-labs.example')

  // `created_at` is pinned after each insert so the order under test is the
  // one written here, not a race between microseconds.
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 9, minute))
  const propose = async (
    entityId: string,
    kind: 'attribute_patch' | 'note',
    payload: Parameters<typeof proposeProgram>[0]['payload'],
    minute: number,
    refs?: Array<string>,
  ) => {
    const row = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind,
        payload,
        rationale: `rationale ${minute}`,
        ...(refs ? { refs } : {}),
        proposedBy: { type: 'system' },
      }),
    )
    await db
      .update(suggestion)
      .set({ createdAt: at(minute) })
      .where(eq(suggestion.id, row.id))
    return row.id
  }

  const acmeFounded = await propose(
    acme,
    'attribute_patch',
    {
      founded_year: {
        value: 2019,
        refs: [`attr:${acme}:location`],
        confidence: 0.8,
      },
    },
    1,
  )
  const acmeNote = await propose(
    acme,
    'note',
    { title: 'Met at demo day', markdown: 'Met at demo day.', sourceId: acme },
    5,
    [],
  )
  const boltLocation = await propose(
    bolt,
    'attribute_patch',
    { location: { value: 'Rotterdam', refs: [], confidence: 0.5 } },
    2,
  )
  const pair = (
    await db
      .insert(duplicateCandidate)
      .values({
        entityA: bolt,
        entityB: cask,
        score: 0.9,
        reason: { name_similarity: 'true' },
        createdAt: at(3),
      })
      .returning({ id: duplicateCandidate.id })
  ).at(0)
  if (!pair) throw new Error('pair insert returned no row')

  return {
    me: me.id,
    acme,
    bolt,
    acmeFounded,
    acmeNote,
    boltLocation,
    pairId: pair.id,
  }
}

let fixture: Awaited<ReturnType<typeof world>> | undefined
const setup = async () => (fixture ??= await world())

describe('listInbox — the suggestion lane', () => {
  it('groups every open suggestion on one record into one card, newest first', async () => {
    const { Effect } = await import('effect')
    const { listInboxProgram } = await import('./queue')
    const f = await setup()

    const rows = await Effect.runPromise(listInboxProgram())
    // Newest member first across both lanes: Acme's note (09:05), the
    // pair (09:03), Bolt's patch (09:02).
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ['suggestion', f.acme],
      ['duplicate_candidate', f.pairId],
      ['suggestion', f.bolt],
    ])

    const acme = rows[0]
    if (acme.kind !== 'suggestion')
      throw new Error('expected a suggestion card')
    expect(acme.record).toMatchObject({
      id: f.acme,
      name: 'Acme Robotics',
      kind: 'company',
      objectSlug: 'companies',
    })
    expect(acme.suggestions.map((s) => s.id)).toEqual([
      f.acmeNote,
      f.acmeFounded,
    ])
    expect(acme.latestAt).toBe('2026-09-23T09:05:00.000Z')

    // A kind that is not a patch carries its payload and no fields.
    const [note, founded] = acme.suggestions
    expect(note.kind).toBe('note')
    expect(note.fields).toBeNull()
    expect(note.payload).toEqual({
      title: 'Met at demo day',
      markdown: 'Met at demo day.',
      sourceId: f.acme,
    })

    // A patch carries its fields against the live registry, and its refs
    // as citations resolved through `names.ts`.
    expect(founded.fields).toEqual([
      expect.objectContaining({
        slug: 'founded_year',
        name: 'Founded',
        type: 'number',
        value: 2019,
      }),
    ])
    expect(founded.citations).toEqual([
      {
        ref: `attr:${f.acme}:location`,
        entityId: f.acme,
        label: 'Location on Acme Robotics',
        missing: false,
      },
    ])
    expect(founded.rationale).toBe('rationale 1')
  })
})

describe('countOpenInbox — one UNION ALL over both tables', () => {
  it('is open suggestions plus open duplicate candidates', async () => {
    const { Effect } = await import('effect')
    const { countOpenInboxProgram } = await import('./queue')
    await setup()

    const counts = await Effect.runPromise(countOpenInboxProgram())
    expect(counts).toEqual({
      open: 4,
      byKind: { suggestion: 3, duplicate_candidate: 1 },
    })
  })
})

describe('reject and accept leave the queue', () => {
  it('never shows a rejected suggestion again, and counts it out', async () => {
    const { Effect } = await import('effect')
    const { listInboxProgram, countOpenInboxProgram } = await import('./queue')
    const { rejectProgram } = await import('#/lib/ai/propose')
    const f = await setup()

    const closed = await Effect.runPromise(
      rejectProgram(f.acmeNote, { type: 'user', id: f.me }),
    )
    expect(closed.status).toBe('rejected')

    const rows = await Effect.runPromise(listInboxProgram())
    const ids = rows.flatMap((r) =>
      r.kind === 'suggestion' ? r.suggestions.map((s) => s.id) : [],
    )
    expect(ids).not.toContain(f.acmeNote)
    // Acme's card now sorts by its remaining member (09:01) — last.
    expect(rows.map((r) => r.id)).toEqual([f.pairId, f.bolt, f.acme])

    const counts = await Effect.runPromise(countOpenInboxProgram())
    expect(counts).toEqual({
      open: 3,
      byKind: { suggestion: 2, duplicate_candidate: 1 },
    })

    // Rejecting again is refused rather than reopening it.
    const again = await Effect.runPromiseExit(
      rejectProgram(f.acmeNote, { type: 'user', id: f.me }),
    )
    expect(again._tag).toBe('Failure')
  })

  it('drops a record’s card once its last suggestion is accepted', async () => {
    const { Effect } = await import('effect')
    const { listInboxProgram, countOpenInboxProgram } = await import('./queue')
    const { acceptProgram } = await import('#/lib/ai/propose')
    const f = await setup()

    const accepted = await Effect.runPromise(
      acceptProgram(f.acmeFounded, { type: 'user', id: f.me }),
    )
    if (accepted.kind !== 'attribute_patch') throw new Error('not a patch')
    expect(accepted.write.changed).toEqual(['founded_year'])

    const rows = await Effect.runPromise(listInboxProgram())
    expect(rows.map((r) => r.id)).toEqual([f.pairId, f.bolt])
    const counts = await Effect.runPromise(countOpenInboxProgram())
    expect(counts.open).toBe(2)
    // The /companies banner reads this lane alone, unchanged.
    expect(counts.byKind.duplicate_candidate).toBe(1)
  })

  it('counts zero in both lanes when nothing is open', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { duplicateCandidate } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { countOpenInboxProgram } = await import('./queue')
    const { rejectProgram } = await import('#/lib/ai/propose')
    const f = await setup()

    await Effect.runPromise(
      rejectProgram(f.boltLocation, { type: 'user', id: f.me }),
    )
    await db
      .update(duplicateCandidate)
      .set({ status: 'dismissed', resolvedBy: f.me, resolvedAt: new Date() })
      .where(eq(duplicateCandidate.id, f.pairId))

    const counts = await Effect.runPromise(countOpenInboxProgram())
    expect(counts).toEqual({
      open: 0,
      byKind: { suggestion: 0, duplicate_candidate: 0 },
    })
  })
})
