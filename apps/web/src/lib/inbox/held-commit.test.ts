import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HeldDecision } from './held'

/**
 * The undo hold's beacon route: every decision still held when the page
 * went, run as the signed-in user through the programs the server fns run;
 * an anonymous request writes nothing.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const { handleHeldDecisionsRequest } = await import('./held-commit')

const post = (body: unknown) =>
  handleHeldDecisionsRequest(
    new Request('http://localhost/api/held-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

async function setup() {
  const { Effect } = await import('effect')
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  const { proposeProgram } =
    await import('@spaces/core/writes/suggestions/propose')
  const { db } = await import('@spaces/db')
  const { duplicateCandidate } = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!actor) throw new Error('the test seed has no user')
  const tag = randomUUID().slice(0, 8)
  const company = async (name: string) =>
    (
      await resolveEntity({
        kind: 'company',
        name: `${name} ${tag}`,
        source: { class: 'manual' },
      })
    ).entityId
  const a = await company('Held A')
  const b = await company('Held B')
  const proposed = await Effect.runPromise(
    proposeProgram({
      entityId: a,
      kind: 'attribute_patch',
      payload: {
        location: { value: 'Berlin', refs: ['doc:deck#p2'], confidence: 0.6 },
      },
      rationale: 'Read off the deck',
      proposedBy: { type: 'system' },
    }),
  )
  const pair = (
    await db
      .insert(duplicateCandidate)
      .values({
        entityA: a,
        entityB: b,
        score: 0.9,
        reason: { name_similarity: 'true' },
      })
      // The birth may already have paired two names this alike.
      .onConflictDoUpdate({
        target: [duplicateCandidate.entityA, duplicateCandidate.entityB],
        set: { status: 'open' },
      })
      .returning({ id: duplicateCandidate.id })
  ).at(0)
  if (!pair) throw new Error('pair insert returned no row')
  return { actorId: actor.id, suggestionId: proposed.id, pairId: pair.id }
}

async function statuses(suggestionId: string, pairId: string) {
  const { db } = await import('@spaces/db')
  const { duplicateCandidate, suggestion } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const s = (
    await db
      .select({ status: suggestion.status, decidedBy: suggestion.decidedBy })
      .from(suggestion)
      .where(eq(suggestion.id, suggestionId))
  ).at(0)
  const p = (
    await db
      .select({
        status: duplicateCandidate.status,
        resolvedBy: duplicateCandidate.resolvedBy,
      })
      .from(duplicateCandidate)
      .where(eq(duplicateCandidate.id, pairId))
  ).at(0)
  return { suggestion: s, pair: p }
}

describe('POST /api/held-decisions', () => {
  it('refuses an anonymous request and writes nothing', async () => {
    const { suggestionId, pairId } = await setup()
    session.current = null
    const decisions: Array<HeldDecision> = [
      { verb: 'dismiss', id: suggestionId },
      { verb: 'dismiss-duplicate', candidateId: pairId },
    ]
    const response = await post({ decisions })
    expect(response.status).toBe(401)
    expect(await statuses(suggestionId, pairId)).toEqual({
      suggestion: { status: 'open', decidedBy: null },
      pair: { status: 'open', resolvedBy: null },
    })
  })

  it('runs each decision as the signed-in user', async () => {
    const { actorId, suggestionId, pairId } = await setup()
    session.current = { id: actorId, role: 'member' }
    const decisions: Array<HeldDecision> = [
      { verb: 'dismiss', id: suggestionId },
      { verb: 'dismiss-duplicate', candidateId: pairId },
    ]
    const response = await post({ decisions })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      outcomes: [
        { ok: true, already: false },
        { ok: true, already: false },
      ],
    })
    expect(await statuses(suggestionId, pairId)).toEqual({
      suggestion: { status: 'rejected', decidedBy: actorId },
      pair: { status: 'dismissed', resolvedBy: actorId },
    })
  })

  it('reads a decision another hand made first as already decided', async () => {
    const { actorId, suggestionId, pairId } = await setup()
    session.current = { id: actorId, role: 'member' }
    const decisions: Array<HeldDecision> = [
      { verb: 'accept', id: suggestionId },
      { verb: 'dismiss-duplicate', candidateId: pairId },
    ]
    await post({ decisions: [{ verb: 'dismiss', id: suggestionId }] })
    await post({ decisions: [decisions[1]] })
    const response = await post({ decisions })
    expect(await response.json()).toEqual({
      outcomes: [
        { ok: true, already: true },
        { ok: true, already: true },
      ],
    })
    expect((await statuses(suggestionId, pairId)).suggestion?.status).toBe(
      'rejected',
    )
  })

  it('refuses a body that is not a list of decisions', async () => {
    session.current = { id: randomUUID(), role: 'member' }
    expect((await post({ decisions: [{ verb: 'merge' }] })).status).toBe(400)
    expect((await post({})).status).toBe(400)
  })
})
