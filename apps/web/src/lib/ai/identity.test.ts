import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, count, eq, or } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  duplicateCandidate,
  entity,
  entityAlias,
  link,
  suggestion,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '#/lib/entities/resolve'
import { listInboxProgram } from '#/lib/inbox/queue'
import type { Json } from '#/lib/json'
import {
  SuggestionInvalid,
  acceptProgram,
  acceptRecordProgram,
  proposeProgram,
  rejectProgram,
} from './propose'
import type { Decider } from './propose'

/**
 * SPA-105 — `suggestion(kind: 'identity')`. Accepting walks the claim
 * through `resolveEntity` (attach on an exact email/LinkedIn match, else
 * create and sweep names inline) and links the person `contact_at` the
 * record; rejecting writes nothing. Everything here is the real database —
 * the duplicate pair is read back from `duplicate_candidate` and through the
 * inbox's own list, never mocked. Per-file truncation gives this file a
 * clean database.
 */

const ACCEPTER: Decider = { type: 'user', id: FIXTURE_ACTOR.id }

async function company() {
  const tag = randomUUID().slice(0, 8)
  const c = await resolveEntity({
    kind: 'company',
    name: `Foundry ${tag}`,
    keys: { domain: `foundry-${tag}.example` },
    source: { class: 'manual' },
  })
  return { companyId: c.entityId, tag }
}

const proposeIdentity = (entityId: string, payload: Json) =>
  Effect.runPromise(
    proposeProgram({
      entityId,
      kind: 'identity',
      payload,
      rationale: 'Named in deck.pdf',
      refs: ['doc:deck#0'],
      proposedBy: { type: 'user', id: FIXTURE_ACTOR.id },
    }),
  )

async function tally() {
  const n = async (
    table: typeof entity | typeof entityAlias | typeof link,
  ): Promise<number> =>
    (await db.select({ value: count() }).from(table)).at(0)?.value ?? 0
  return {
    entities: await n(entity),
    aliases: await n(entityAlias),
    links: await n(link),
    pairs:
      (await db.select({ value: count() }).from(duplicateCandidate)).at(0)
        ?.value ?? 0,
  }
}

async function contactLinks(personId: string, recordId: string) {
  return db
    .select()
    .from(link)
    .where(
      and(
        eq(link.fromEntityId, personId),
        eq(link.toEntityId, recordId),
        eq(link.relation, 'contact_at'),
      ),
    )
}

describe('accepting an identity', () => {
  it('attaches a founder whose email matches an existing person, creating no entity', async () => {
    const { companyId, tag } = await company()
    const known = await resolveEntity({
      kind: 'person',
      name: `Ada Lovelace ${tag}`,
      keys: { email: `ada-${tag}@analytical.example` },
      source: { class: 'manual' },
    })
    const proposed = await proposeIdentity(companyId, {
      name: `A. Lovelace ${tag}`,
      role: 'CEO',
      email: `ADA-${tag}@analytical.example`,
    })
    const before = await tally()

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.resolved).toMatchObject({
      entityId: known.entityId,
      action: 'attached',
      matchedOn: 'email',
    })
    expect(accepted.suggestion.status).toBe('accepted')
    expect(accepted.suggestion.decidedBy).toBe(FIXTURE_ACTOR.id)

    const after = await tally()
    expect(after.entities).toBe(before.entities)
    // The one link, and the deck's spelling kept as a name alias.
    expect(after.links).toBe(before.links + 1)
    const links = await contactLinks(known.entityId, companyId)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      source: 'extracted',
      createdBy: FIXTURE_ACTOR.id,
    })
  })

  it('attaches on a LinkedIn match the same way', async () => {
    const { companyId, tag } = await company()
    const known = await resolveEntity({
      kind: 'person',
      name: `Linus ${tag}`,
      keys: { linkedin: `https://www.linkedin.com/in/linus-${tag}` },
      source: { class: 'manual' },
    })
    const proposed = await proposeIdentity(companyId, {
      name: `Linus T ${tag}`,
      linkedin: `linkedin.com/in/linus-${tag}/`,
    })
    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.resolved).toMatchObject({
      entityId: known.entityId,
      action: 'attached',
      matchedOn: 'linkedin',
    })
  })

  it('creates a near-identical name with no keys as a new person, and files the pair in the inbox', async () => {
    const { companyId } = await company()
    // A name only this test uses, so the sweep's pair is this pair.
    const held = await resolveEntity({
      kind: 'person',
      name: 'Grace Hopperton',
      source: { class: 'manual' },
    })
    const proposed = await proposeIdentity(companyId, {
      name: 'Grace Hoperton',
      role: 'CTO',
    })
    const before = await tally()

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.resolved.action).toBe('created')
    const personId = accepted.resolved.entityId
    expect(personId).not.toBe(held.entityId)
    expect((await tally()).entities).toBe(before.entities + 1)

    // The birth: `import`, created by the accepter — never a machine.
    const born = (
      await db.select().from(entity).where(eq(entity.id, personId))
    ).at(0)
    expect(born).toMatchObject({
      kind: 'person',
      canonicalName: 'Grace Hoperton',
      sourceClass: 'import',
      sourceRef: null,
      createdBy: FIXTURE_ACTOR.id,
    })
    expect(born?.values.job_title).toBe('CTO')

    // The inline trigram sweep's pair, in the table…
    const pairs = await db
      .select()
      .from(duplicateCandidate)
      .where(
        or(
          and(
            eq(duplicateCandidate.entityA, personId),
            eq(duplicateCandidate.entityB, held.entityId),
          ),
          and(
            eq(duplicateCandidate.entityA, held.entityId),
            eq(duplicateCandidate.entityB, personId),
          ),
        ),
      )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].status).toBe('open')

    // …and in the same queue the identity was accepted from.
    const inbox = await Effect.runPromise(listInboxProgram())
    const pair = inbox.find(
      (r) => r.kind === 'duplicate_candidate' && r.id === pairs[0].id,
    )
    expect(pair).toBeDefined()
    if (pair?.kind !== 'duplicate_candidate') throw new Error('no pair row')
    expect([pair.a.id, pair.b.id].sort()).toEqual(
      [personId, held.entityId].sort(),
    )
    // The accepted identity itself has left the queue.
    const cards = inbox.filter((r) => r.kind === 'suggestion')
    expect(
      cards.some((c) => c.suggestions.some((s) => s.id === proposed.id)),
    ).toBe(false)

    // The contact link, marked as extracted.
    const links = await contactLinks(personId, companyId)
    expect(links).toHaveLength(1)
    expect(links[0].source).toBe('extracted')
  })

  it('writes the contact_at link once, even when the person is already a contact', async () => {
    const { companyId, tag } = await company()
    const email = `twice-${tag}@example.org`
    const first = await proposeIdentity(companyId, { name: 'Twice', email })
    const second = await proposeIdentity(companyId, { name: 'Twice', email })
    const a = await Effect.runPromise(acceptProgram(first.id, ACCEPTER))
    const b = await Effect.runPromise(acceptProgram(second.id, ACCEPTER))
    if (a.kind !== 'identity' || b.kind !== 'identity')
      throw new Error('not an identity')
    expect(a.linked).toBe(true)
    expect(b.linked).toBe(false)
    expect(b.resolved).toMatchObject({
      entityId: a.resolved.entityId,
      action: 'attached',
    })
    expect(await contactLinks(a.resolved.entityId, companyId)).toHaveLength(1)
  })

  it('refuses a fields subset — an identity is accepted whole — and leaves the row open', async () => {
    const { companyId } = await company()
    const proposed = await proposeIdentity(companyId, { name: 'Whole Only' })
    const before = await tally()
    const refused = await Effect.runPromise(
      Effect.flip(acceptProgram(proposed.id, ACCEPTER, ['name'])),
    )
    expect(refused).toBeInstanceOf(SuggestionInvalid)
    expect(await tally()).toEqual(before)
    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposed.id))
    ).at(0)
    expect(row?.status).toBe('open')
  })

  it('is one item of Accept all, accepted whole', async () => {
    const { companyId } = await company()
    const proposed = await proposeIdentity(companyId, { name: 'Bulk Person' })
    const outcomes = await Effect.runPromise(
      acceptRecordProgram({ entityId: companyId, actorId: FIXTURE_ACTOR.id }),
    )
    expect(outcomes).toEqual([{ suggestionId: proposed.id, ok: true }])
  })

  it('refuses a payload that is not an identity at propose', async () => {
    const { companyId } = await company()
    const refused = await Effect.runPromise(
      Effect.flip(
        proposeProgram({
          entityId: companyId,
          kind: 'identity',
          payload: { name: '', title: 'CEO' },
          proposedBy: { type: 'system' },
        }),
      ),
    )
    expect(refused).toBeInstanceOf(SuggestionInvalid)
  })
})

describe('rejecting an identity', () => {
  it('creates nothing at all — no entity, no alias, no link', async () => {
    const { companyId } = await company()
    await resolveEntity({
      kind: 'person',
      name: 'Katherine Johnsen',
      source: { class: 'manual' },
    })
    const proposed = await proposeIdentity(companyId, {
      name: 'Katherine Johnson',
      email: 'kj@nasa.example',
    })
    const before = await tally()
    const rejected = await Effect.runPromise(
      rejectProgram(proposed.id, ACCEPTER),
    )
    expect(rejected.status).toBe('rejected')
    expect(await tally()).toEqual(before)
  })
})
