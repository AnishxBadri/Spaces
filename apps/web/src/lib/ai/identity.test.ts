import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, count, eq, or } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attributeEvent,
  duplicateCandidate,
  entity,
  entityAlias,
  link,
  suggestion,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
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

/** The record's value at `slug`, read back as the one write path left it. */
async function valueOf(entityId: string, slug: string): Promise<unknown> {
  const row = (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)
  return row?.values[slug]
}

async function eventsOn(entityId: string, slug: string) {
  return db
    .select()
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, entityId),
        eq(attributeEvent.attrSlug, slug),
      ),
    )
}

/**
 * SPA-160 — the field the claim was read off. Accepting writes the resolved
 * person into it, through the one write path, beside the `contact_at` link.
 */
describe('accepting an identity into its field', () => {
  it('sets a company founder into `founders` and writes the contact_at link', async () => {
    const { companyId, tag } = await company()
    const proposed = await proposeIdentity(companyId, {
      name: `Ada Founder ${tag}`,
      role: 'CEO',
      email: `ada-${tag}@foundry.example`,
      attribute: 'founders',
    })
    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    const personId = accepted.resolved.entityId
    expect(accepted.filed).toBe('founders')
    expect(accepted.linked).toBe(true)

    expect(await valueOf(companyId, 'founders')).toEqual([personId])
    expect(await contactLinks(personId, companyId)).toHaveLength(1)

    // Through the one write path: an event with the suggestion as receipt,
    // and the reference materialized as a `references` link.
    const events = await eventsOn(companyId, 'founders')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: 'suggestion',
      suggestionId: proposed.id,
      refs: ['doc:deck#0'],
      actorId: FIXTURE_ACTOR.id,
      to: [personId],
    })
    const refs = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, companyId),
          eq(link.toEntityId, personId),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'founders'),
        ),
      )
    expect(refs).toHaveLength(1)
  })

  it('appends a second founder, leaving the first in place', async () => {
    const { companyId, tag } = await company()
    const first = await proposeIdentity(companyId, {
      name: `First ${tag}`,
      email: `first-${tag}@foundry.example`,
      attribute: 'founders',
    })
    const second = await proposeIdentity(companyId, {
      name: `Second ${tag}`,
      email: `second-${tag}@foundry.example`,
      attribute: 'founders',
    })
    const a = await Effect.runPromise(acceptProgram(first.id, ACCEPTER))
    const b = await Effect.runPromise(acceptProgram(second.id, ACCEPTER))
    if (a.kind !== 'identity' || b.kind !== 'identity')
      throw new Error('not an identity')
    expect(await valueOf(companyId, 'founders')).toEqual([
      a.resolved.entityId,
      b.resolved.entityId,
    ])
  })

  it('holds one entry when two suggestions name one person', async () => {
    const { companyId, tag } = await company()
    const email = `once-${tag}@foundry.example`
    const first = await proposeIdentity(companyId, {
      name: 'Once Founder',
      email,
      attribute: 'founders',
    })
    const second = await proposeIdentity(companyId, {
      name: 'O. Founder',
      email,
      attribute: 'founders',
    })
    const a = await Effect.runPromise(acceptProgram(first.id, ACCEPTER))
    const b = await Effect.runPromise(acceptProgram(second.id, ACCEPTER))
    if (a.kind !== 'identity' || b.kind !== 'identity')
      throw new Error('not an identity')
    expect(b.resolved.entityId).toBe(a.resolved.entityId)
    expect(b.filed).toBe('founders')
    expect(await valueOf(companyId, 'founders')).toEqual([a.resolved.entityId])
    // The second accept wrote nothing: no second event, one link.
    expect(await eventsOn(companyId, 'founders')).toHaveLength(1)
    expect(await contactLinks(a.resolved.entityId, companyId)).toHaveLength(1)
  })

  it('writes a deal-sourced claim into the deal’s `people`', async () => {
    const tag = randomUUID().slice(0, 8)
    const deal = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: `Foundry seed ${tag}` })
        .returning({ id: entity.id })
    ).at(0)
    if (!deal) throw new Error('no deal')
    const proposed = await proposeIdentity(deal.id, {
      name: `Deal Person ${tag}`,
      role: 'CTO',
      attribute: 'people',
    })
    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.filed).toBe('people')
    expect(await valueOf(deal.id, 'people')).toEqual([
      accepted.resolved.entityId,
    ])
    expect(
      await contactLinks(accepted.resolved.entityId, deal.id),
    ).toHaveLength(1)
  })

  it('fills an empty single-valued `referred_by`, and never overwrites a held one', async () => {
    const tag = randomUUID().slice(0, 8)
    const deal = (
      await db
        .insert(entity)
        .values({ kind: 'deal', canonicalName: `Referral ${tag}` })
        .returning({ id: entity.id })
    ).at(0)
    if (!deal) throw new Error('no deal')
    const first = await proposeIdentity(deal.id, {
      name: `Referrer ${tag}`,
      email: `ref-${tag}@example.org`,
      attribute: 'referred_by',
    })
    const other = await proposeIdentity(deal.id, {
      name: `Other ${tag}`,
      email: `other-${tag}@example.org`,
      attribute: 'referred_by',
    })
    const a = await Effect.runPromise(acceptProgram(first.id, ACCEPTER))
    const b = await Effect.runPromise(acceptProgram(other.id, ACCEPTER))
    if (a.kind !== 'identity' || b.kind !== 'identity')
      throw new Error('not an identity')
    expect(a.filed).toBe('referred_by')
    expect(b.filed).toBeNull()
    expect(await valueOf(deal.id, 'referred_by')).toBe(a.resolved.entityId)
    // The second person is still a contact: only the slot stays as it was.
    expect(await contactLinks(b.resolved.entityId, deal.id)).toHaveLength(1)
  })

  it('writes only the link for a row that names no field (proposed before SPA-160)', async () => {
    const { companyId, tag } = await company()
    const proposed = await proposeIdentity(companyId, {
      name: `Legacy ${tag}`,
      email: `legacy-${tag}@foundry.example`,
    })
    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.filed).toBeNull()
    expect(await valueOf(companyId, 'founders')).toBeUndefined()
    expect(
      await contactLinks(accepted.resolved.entityId, companyId),
    ).toHaveLength(1)
  })

  it('skips a field that does not take a person, keeping the link', async () => {
    const { companyId, tag } = await company()
    const proposed = await proposeIdentity(companyId, {
      name: `Misfiled ${tag}`,
      attribute: 'location',
    })
    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, ACCEPTER),
    )
    if (accepted.kind !== 'identity') throw new Error('not an identity')
    expect(accepted.filed).toBeNull()
    expect(await valueOf(companyId, 'location')).toBeUndefined()
    expect(
      await contactLinks(accepted.resolved.entityId, companyId),
    ).toHaveLength(1)
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
