import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  entity,
  entityAlias,
  entitySpace,
  integration,
  spaceWatch,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import type { DomainEvent } from '@spaces/sdk'
import { readAddRecordPayload } from '@spaces/core/ai/discovery'
import {
  previewResolve,
  resolveEntity,
} from '@spaces/core/writes/entities/resolve'
import type { PreviewResolveInput } from '@spaces/core/writes/entities/resolve'
import { discoverWith } from '@spaces/core/writes/ports/discover'
import { proposeDiscoveryWith } from '@spaces/core/writes/suggestions/propose'
import type { DiscoveryProposeInput } from '@spaces/core/writes/suggestions/propose'
import { createSpaceRow } from '#/lib/server/shared'
import { listInboxProgram } from '#/lib/inbox/queue'
import { acceptProgram, rejectProgram } from './propose'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

const emitted = vi.hoisted((): Array<DomainEvent> => [])
vi.mock('#/lib/events/emit', () => ({
  emitDomainEvent: (event: DomainEvent | null) => {
    if (event !== null) emitted.push(event)
    return Promise.resolve()
  },
}))

/**
 * The two discovery cards a space's watch hands back (D72, D77): one open
 * card per (space, domain), held by the database; a dismissal that makes
 * every later card for the domain a no-op; and the accepts that resolve and
 * file.
 */

const me = FIXTURE_ACTOR.id
const decider = { type: 'user', id: me } as const
let n = 0
const tag = () => `${String(++n)}${Math.random().toString(36).slice(2, 6)}`

/** drizzle wraps the driver error; the SQLSTATE is one or more hops down. */
function pgCodeOf(error: unknown): string | undefined {
  let cursor: unknown = error
  while (cursor instanceof Error) {
    if ('code' in cursor && typeof cursor.code === 'string') return cursor.code
    cursor = cursor.cause
  }
  return undefined
}

const addCard = (spaceId: string, domain: string, extra: object = {}) => ({
  kind: 'add_record' as const,
  payload: {
    spaceId,
    domain,
    name: `Found ${domain}`,
    aliases: [],
    evidence: [{ url: `https://news.example/${domain}`, title: 'A write-up' }],
    subspaceHint: null,
    ...extra,
  },
  proposedBy: { type: 'system' } as const,
})

const propose = (input: DiscoveryProposeInput) =>
  proposeDiscoveryWith(db, input)

/** A watch on the space, from a throwaway integration. */
const aWatch = async (spaceId: string) => {
  const plugin = (
    await db
      .insert(integration)
      .values({ capabilityId: `watch-${tag()}`, version: '0.1.0' })
      .returning({ id: integration.id })
  ).at(0)
  if (!plugin) throw new Error('no integration')
  const watch = (
    await db
      .insert(spaceWatch)
      .values({ spaceId, integrationId: plugin.id, settings: {} })
      .returning({ id: spaceWatch.id })
  ).at(0)
  if (!watch) throw new Error('no watch')
  return watch.id
}

const openCards = (spaceId: string, domain: string) =>
  db
    .select({ id: suggestion.id, status: suggestion.status })
    .from(suggestion)
    .where(
      and(
        sql`${suggestion.payload} ->> 'spaceId' = ${spaceId}`,
        sql`${suggestion.payload} ->> 'domain' = ${domain}`,
      ),
    )

describe('discovery cards', () => {
  it('holds one open card per (space, domain) in the database', async () => {
    const spaceId = await createSpaceRow(`Rental ${tag()}`, null, me)
    const domain = `rent${tag()}.com`
    const first = await propose(addCard(spaceId, `https://www.${domain}/`))
    if (first.outcome !== 'proposed') throw new Error('expected a new card')
    expect(first.suggestion.entityId).toBeNull()
    // Normalized before it is written: the index compares the bare domain.
    expect(first.suggestion.payload).toMatchObject({ domain })

    const again = await propose(
      addCard(spaceId, domain, {
        evidence: [{ url: `https://blog.example/${domain}` }],
      }),
    )
    expect(again).toMatchObject({
      outcome: 'merged',
      suggestion: { id: first.suggestion.id },
    })
    // The later find's evidence is appended to the open card.
    if (again.outcome !== 'merged') throw new Error('expected a merge')
    expect(readAddRecordPayload(again.suggestion.payload)?.evidence).toEqual([
      {
        url: `https://news.example/https://www.${domain}/`,
        title: 'A write-up',
      },
      { url: `https://blog.example/${domain}` },
    ])

    const raw = await db
      .insert(suggestion)
      .values({
        entityId: null,
        kind: 'add_record',
        payload: { spaceId, domain },
        proposedByType: 'system',
      })
      .then(
        () => null,
        (err: unknown) => pgCodeOf(err),
      )
    expect(raw).toBe('23505')
    expect(await openCards(spaceId, domain)).toHaveLength(1)
  })

  it('refuses a record kind with no record', async () => {
    const raw = await db
      .insert(suggestion)
      .values({
        entityId: null,
        kind: 'note',
        payload: {},
        proposedByType: 'system',
      })
      .then(
        () => null,
        (err: unknown) => pgCodeOf(err),
      )
    expect(raw).toBe('23514')
  })

  it('a dismissal makes the next proposal for the domain a no-op', async () => {
    const spaceId = await createSpaceRow(`Dismissed ${tag()}`, null, me)
    const domain = `nope${tag()}.io`
    const first = await propose(addCard(spaceId, domain))
    if (first.outcome !== 'proposed') throw new Error('expected a new card')

    const rejected = await Effect.runPromise(
      rejectProgram(first.suggestion.id, decider),
    )
    expect(rejected.status).toBe('rejected')
    const dismissals = await db
      .select()
      .from(spaceWatchDismissal)
      .where(eq(spaceWatchDismissal.spaceId, spaceId))
    expect(dismissals).toMatchObject([{ domain, dismissedBy: me }])

    const second = await propose(addCard(spaceId, domain))
    expect(second).toEqual({ outcome: 'dismissed' })
    // Only the rejected first card exists: the second never appeared.
    expect(await openCards(spaceId, domain)).toEqual([
      { id: first.suggestion.id, status: 'rejected' },
    ])

    // Per space: another space still sees the domain.
    const elsewhere = await createSpaceRow(`Elsewhere ${tag()}`, null, me)
    expect((await propose(addCard(elsewhere, domain))).outcome).toBe('proposed')
  })

  it('add_record accepts through resolveEntity, files in the hinted subspace and fires entity.created', async () => {
    const spaceId = await createSpaceRow(`Proptech ${tag()}`, null, me)
    const leaf = `Rental software ${tag()}`
    const subspaceId = await createSpaceRow(leaf, spaceId, me)
    const domain = `lease${tag()}.in`
    const card = await propose(
      addCard(spaceId, domain, {
        aliases: ['Lease Co'],
        subspaceHint: leaf.toLowerCase(),
      }),
    )
    if (card.outcome !== 'proposed') throw new Error('expected a new card')
    emitted.length = 0

    const accepted = await Effect.runPromise(
      acceptProgram(card.suggestion.id, decider),
    )
    if (accepted.kind !== 'add_record') throw new Error('expected add_record')
    expect(accepted.suggestion.status).toBe('accepted')
    expect(accepted.resolved.action).toBe('created')
    expect(accepted.spaceId).toBe(subspaceId)
    expect(accepted.tagged).toBe(true)

    const companyId = accepted.resolved.entityId
    const born = (
      await db.select().from(entity).where(eq(entity.id, companyId))
    ).at(0)
    expect(born).toMatchObject({ kind: 'company', createdBy: me })
    expect(born?.values).toMatchObject({ domains: [domain] })
    const filings = await db
      .select({ spaceId: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, companyId))
    expect(filings).toEqual([{ spaceId: subspaceId }])
    const aliases = await db
      .select({ value: entityAlias.value })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, companyId))
    expect(aliases.map((a) => a.value)).toContain('Lease Co')
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'entity.created',
          entityId: companyId,
        }),
        expect.objectContaining({ name: 'filed', spaceId: subspaceId }),
      ]),
    )
  })

  it('add_record files in the card space when the hint names no subspace', async () => {
    const spaceId = await createSpaceRow(`Climate ${tag()}`, null, me)
    const card = await propose(
      addCard(spaceId, `heat${tag()}.com`, { subspaceHint: 'No such leaf' }),
    )
    if (card.outcome !== 'proposed') throw new Error('expected a new card')
    const accepted = await Effect.runPromise(
      acceptProgram(card.suggestion.id, decider),
    )
    if (accepted.kind !== 'add_record') throw new Error('expected add_record')
    expect(accepted.spaceId).toBe(spaceId)
  })

  it('file_record accepts by filing the held record, and rejects into a dismissal', async () => {
    const spaceId = await createSpaceRow(`Fintech ${tag()}`, null, me)
    const domain = `held${tag()}.com`
    const held = await resolveEntity({
      kind: 'company',
      name: `Held ${domain}`,
      keys: { domain },
      source: { class: 'manual' },
    })
    const fileCard = (d: string, entityId: string) => ({
      kind: 'file_record' as const,
      payload: { spaceId, domain: d, name: 'Held', entityId, evidence: [] },
      proposedBy: { type: 'system' } as const,
    })
    const card = await propose(fileCard(domain, held.entityId))
    if (card.outcome !== 'proposed') throw new Error('expected a new card')
    expect(card.suggestion.entityId).toBe(held.entityId)

    const accepted = await Effect.runPromise(
      acceptProgram(card.suggestion.id, decider),
    )
    expect(accepted).toMatchObject({
      kind: 'file_record',
      entityId: held.entityId,
      spaceId,
      tagged: true,
    })

    const other = await resolveEntity({
      kind: 'company',
      name: 'Other',
      keys: { domain: `other${tag()}.com` },
      source: { class: 'manual' },
    })
    const otherDomain = `other${tag()}.com`
    const second = await propose(fileCard(otherDomain, other.entityId))
    if (second.outcome !== 'proposed') throw new Error('expected a new card')
    await Effect.runPromise(rejectProgram(second.suggestion.id, decider))
    expect(await propose(fileCard(otherDomain, other.entityId))).toEqual({
      outcome: 'dismissed',
    })
  })

  it('Review groups a space’s cards under the space head: its path, the plugin that found them', async () => {
    const parent = `Space tech ${tag()}`
    const parentId = await createSpaceRow(parent, null, me)
    const leaf = `Grouped ${tag()}`
    const spaceId = await createSpaceRow(leaf, parentId, me)
    const plugin = (
      await db
        .insert(integration)
        .values({
          capabilityId: `exa-${tag()}`,
          version: '0.1.0',
          manifest: { name: 'Exa' },
        })
        .returning({ id: integration.id })
    ).at(0)
    if (!plugin) throw new Error('no integration')
    const byPlugin = { type: 'integration', id: plugin.id } as const
    await propose({
      ...addCard(spaceId, `one${tag()}.com`),
      proposedBy: byPlugin,
    })
    await propose({
      ...addCard(spaceId, `two${tag()}.com`),
      proposedBy: byPlugin,
    })
    const rows = await Effect.runPromise(listInboxProgram({ record: spaceId }))
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({
      kind: 'discovery',
      id: spaceId,
      space: { id: spaceId, name: leaf, path: `${parent} / ${leaf}` },
      via: ['Exa'],
    })
    const group = rows.at(0)
    if (group?.kind !== 'discovery') throw new Error('expected a group')
    expect(group.suggestions.map((s) => s.kind)).toEqual([
      'add_record',
      'add_record',
    ])
  })

  it('after a card is accepted the member check answers, after it is dismissed the dismissal does', async () => {
    const spaceId = await createSpaceRow(`Checked ${tag()}`, null, me)
    const watchId = await aWatch(spaceId)
    const preview = vi.fn((input: PreviewResolveInput) => previewResolve(input))
    const find = (domain: string) =>
      discoverWith(
        {
          claim: {
            spaceId,
            name: `Found ${domain}`,
            domain,
            evidence: [{ url: `https://news.example/${domain}` }],
          },
          proposedBy: { type: 'system' },
          watchId,
        },
        { preview },
      )
    const kept = `kept${tag()}.com`
    const card = await find(kept)
    if (card.outcome !== 'proposed') throw new Error('expected a card')
    const accepted = await Effect.runPromise(
      acceptProgram(card.suggestion.id, decider),
    )
    if (accepted.kind !== 'add_record') throw new Error('expected add_record')
    expect(await find(kept)).toEqual({
      outcome: 'member',
      entityId: accepted.resolved.entityId,
    })

    const dropped = `dropped${tag()}.com`
    const second = await find(dropped)
    if (second.outcome !== 'proposed') throw new Error('expected a card')
    await Effect.runPromise(rejectProgram(second.suggestion.id, decider))
    preview.mockClear()
    expect(await find(dropped)).toEqual({ outcome: 'dismissed' })
    expect(preview).not.toHaveBeenCalled()
  })
})

describe('space_watch', () => {
  it('refuses the same lens twice, whatever order its settings were written in', async () => {
    const spaceId = await createSpaceRow(`Watched ${tag()}`, null, me)
    const row = (
      await db
        .insert(integration)
        .values({ capabilityId: `exa-${tag()}`, version: '0.1.0' })
        .returning({ id: integration.id })
    ).at(0)
    if (!row) throw new Error('integration insert returned nothing')
    await db.insert(spaceWatch).values({
      spaceId,
      integrationId: row.id,
      settings: { criteria: 'Rental software', cap: 25 },
      createdBy: me,
    })
    const again = await db
      .insert(spaceWatch)
      .values({
        spaceId,
        integrationId: row.id,
        settings: { cap: 25, criteria: 'Rental software' },
      })
      .then(
        () => null,
        (err: unknown) => pgCodeOf(err),
      )
    expect(again).toBe('23505')
    // A different lens on the same space and engine is a second watch.
    await db.insert(spaceWatch).values({
      spaceId,
      integrationId: row.id,
      settings: { criteria: 'Rental software', cap: 50 },
      cadenceMinutes: null,
    })
    const watches = await db
      .select({ hash: spaceWatch.settingsHash })
      .from(spaceWatch)
      .where(eq(spaceWatch.spaceId, spaceId))
    expect(new Set(watches.map((w) => w.hash)).size).toBe(2)
  })
})
