import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Decider } from './propose'

/**
 * The suggestion table end to end (SPA-46): propose writes a row and no
 * value; accept writes the value through the one write path with the
 * accepter as actor and the row as the receipt; a payload the registry no
 * longer holds leaves the row open; two racing accepts write once.
 */

async function setup() {
  const { resolveEntity } = await import('#/lib/entities/resolve')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const accepter = (
    await db.select({ id: user.id, name: user.name }).from(user).limit(1)
  ).at(0)
  if (!accepter) throw new Error('the test seed has no user')
  const tag = randomUUID().slice(0, 8)
  const company = await resolveEntity({
    kind: 'company',
    name: `Proposed ${tag}`,
    keys: { domain: `proposed-${tag}.example` },
    source: { class: 'manual' },
  })
  return { accepter, entityId: company.entityId }
}

describe('propose → accept', () => {
  it('writes the value as the accepter, with the suggestion as the receipt', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, acceptProgram } = await import('./propose')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, suggestion } =
      await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          founded_year: { value: 2019, refs: ['doc:deck#p2'], confidence: 0.8 },
          location: {
            value: 'Berlin',
            refs: ['doc:deck#p2', 'doc:deck#p9'],
            confidence: 0.6,
          },
        },
        rationale: 'Read off the deck',
        proposedBy: { type: 'system' },
      }),
    )
    expect(proposed.status).toBe('open')
    // The suggestion's refs are the union of the per-field refs.
    expect(proposed.refs).toEqual(['doc:deck#p2', 'doc:deck#p9'])

    // Proposing wrote nothing to the record.
    const before = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    expect(before?.values.founded_year).toBeUndefined()
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, entityId)),
    ).toEqual([])

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
    )
    expect(accepted.write.changed.sort()).toEqual(['founded_year', 'location'])

    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    expect(after?.values.founded_year).toBe(2019)
    expect(after?.values.location).toBe('Berlin')

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, entityId))
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.actorType).toBe('user')
      expect(e.actorId).toBe(accepter.id)
      expect(e.source).toBe('suggestion')
      expect(e.suggestionId).toBe(proposed.id)
      expect(e.refs).toEqual(['doc:deck#p2', 'doc:deck#p9'])
    }

    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposed.id))
    ).at(0)
    expect(row?.status).toBe('accepted')
    expect(row?.decidedBy).toBe(accepter.id)
    expect(row?.decidedAt).toBeInstanceOf(Date)

    // The record timeline shows the change as the accepter's, not a machine's.
    const timeline = await Effect.runPromise(recordTimelineProgram(entityId))
    const burst = timeline.find((i) => i.type === 'attrs')
    expect(burst).toMatchObject({
      actorType: 'user',
      actorName: accepter.name,
      source: 'suggestion',
    })
  })

  it('leaves the row open and says why when the payload no longer validates', async () => {
    const { Effect } = await import('effect')
    const {
      proposeProgram,
      acceptProgram,
      SuggestionInvalid,
      suggestionMessage,
    } = await import('./propose')
    const { db } = await import('@spaces/db')
    const { attribute, attributeEvent, suggestion } =
      await import('@spaces/db/schema')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')
    const { and, eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          location: { value: 'Lisbon', refs: [], confidence: 0.5 },
        },
        proposedBy: { type: 'user', id: accepter.id },
      }),
    )

    // The registry moves between propose and accept.
    const companyObject = await objectIdForKindAsync('company')
    const where = and(
      eq(attribute.objectId, companyObject),
      eq(attribute.slug, 'location'),
    )
    await db.update(attribute).set({ archived: true }).where(where)
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
        ),
      )
      expect(failure).toBeInstanceOf(SuggestionInvalid)
      // The validator's own `slug: detail`, not a generic sentence.
      expect(suggestionMessage(failure)).toBe('location: Unknown attribute')
    } finally {
      await db.update(attribute).set({ archived: false }).where(where)
    }

    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposed.id))
    ).at(0)
    expect(row?.status).toBe('open')
    expect(row?.decidedBy).toBeNull()
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, entityId)),
    ).toEqual([])
  })

  it('refuses an invalid payload at propose with the validator message', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, suggestionMessage } = await import('./propose')
    const { entityId } = await setup()

    const failure = await Effect.runPromise(
      Effect.flip(
        proposeProgram({
          entityId,
          kind: 'attribute_patch',
          payload: {
            founded_year: { value: 'last year', refs: [], confidence: 1 },
          },
          proposedBy: { type: 'system' },
        }),
      ),
    )
    expect(suggestionMessage(failure)).toMatch(/^founded_year: /)
  })

  it('writes once when two accepts race', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, acceptProgram, SuggestionNotOpen } =
      await import('./propose')
    const { db } = await import('@spaces/db')
    const { attributeEvent } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          description: { value: 'Rockets', refs: ['doc:x'], confidence: 0.9 },
        },
        proposedBy: { type: 'system' },
      }),
    )
    const accept = () =>
      Effect.runPromise(
        Effect.result(
          acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
        ),
      )
    const results = await Promise.all([accept(), accept()])

    const wins = results.filter((r) => r._tag === 'Success')
    const losses = results.flatMap((r) => (r._tag === 'Failure' ? [r] : []))
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(losses[0]?.failure).toBeInstanceOf(SuggestionNotOpen)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, entityId))
    expect(events).toHaveLength(1)
  })

  it('refuses kinds with no accept path, and closes on reject', async () => {
    const { Effect } = await import('effect')
    const {
      proposeProgram,
      acceptProgram,
      rejectProgram,
      UnsupportedSuggestionKind,
      SuggestionNotOpen,
    } = await import('./propose')
    const { accepter, entityId } = await setup()
    const decider: Decider = { type: 'user', id: accepter.id }

    const note = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'note',
        payload: { body: 'Met the founders' },
        proposedBy: { type: 'system' },
      }),
    )
    const refused = await Effect.runPromise(
      Effect.flip(acceptProgram(note.id, decider)),
    )
    expect(refused).toBeInstanceOf(UnsupportedSuggestionKind)

    const rejected = await Effect.runPromise(rejectProgram(note.id, decider))
    expect(rejected.status).toBe('rejected')
    expect(rejected.decidedBy).toBe(accepter.id)

    const again = await Effect.runPromise(
      Effect.flip(acceptProgram(note.id, decider)),
    )
    expect(again).toBeInstanceOf(SuggestionNotOpen)
  })
})
