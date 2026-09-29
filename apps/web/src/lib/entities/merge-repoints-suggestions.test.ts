import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * `mergeEntities` repoints open suggestions onto the winner (SPA-46). This
 * case lived in `merge.test.ts` until that file moved to @spaces/core with
 * `merge.ts` (SPA-174/175); it drives `proposeProgram`, which is apps/web's
 * AI module, so it stayed behind as its own file.
 */
describe('mergeEntities and open suggestions', () => {
  it("repoints both companies' open suggestions onto the winner (SPA-46)", async () => {
    const { Effect } = await import('effect')
    const { resolveEntity } =
      await import('@spaces/core/writes/entities/resolve')
    const { mergeEntities } = await import('@spaces/core/writes/entities/merge')
    const { proposeProgram } = await import('#/lib/ai/propose')
    const { db } = await import('@spaces/db')
    const { mergeEvent, suggestion } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq, inArray } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const winner = await resolveEntity({
      kind: 'company',
      name: `SuggestCo ${tag}`,
      keys: { domain: `suggest-w-${tag}.example` },
      source: { class: 'manual' },
    })
    const loser = await resolveEntity({
      kind: 'company',
      name: `SuggestCo ${tag} (dup)`,
      keys: { domain: `suggest-l-${tag}.example` },
      source: { class: 'manual' },
    })
    const propose = (entityId: string, location: string) =>
      Effect.runPromise(
        proposeProgram({
          entityId,
          kind: 'attribute_patch',
          payload: {
            location: { value: location, refs: ['doc:d#p1'], confidence: 0.7 },
          },
          proposedBy: { type: 'system' },
        }),
      )
    const onWinner = await propose(winner.entityId, 'Paris')
    const onLoser = await propose(loser.entityId, 'Lyon')

    const { mergeEventId } = await mergeEntities({
      winnerId: winner.entityId,
      loserId: loser.entityId,
      mergedBy: actor.id,
    })

    const rows = await db
      .select()
      .from(suggestion)
      .where(inArray(suggestion.id, [onWinner.id, onLoser.id]))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.entityId).toBe(winner.entityId)
      expect(r.status).toBe('open')
    }

    // The repoint is in the snapshot like every other generic column.
    const [ev] = await db
      .select({ snapshot: mergeEvent.snapshot })
      .from(mergeEvent)
      .where(eq(mergeEvent.id, mergeEventId))
    expect(ev.snapshot).toContainEqual({
      table: 'suggestion',
      action: 'repointed',
      pk: { id: onLoser.id },
      old: { entityId: loser.entityId },
    })
  })
})
