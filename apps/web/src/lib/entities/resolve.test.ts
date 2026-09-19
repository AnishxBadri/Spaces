import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Integration tests — run against this worker's test database, which
 * `vitest.setup.ts` truncated and reseeded before this file was imported
 * (SPA-145), never the dev one. The hex tags in the fixture names are kept:
 * they cost nothing and they keep a failure message telling you which run
 * wrote a row.
 */

describe('resolveEntity', () => {
  it('creates, then attaches on the same domain', async () => {
    const { resolveEntity } = await import('./resolve')
    const tag = randomUUID().slice(0, 8)
    const domain = `orbital-${tag}.com`

    const first = await resolveEntity({
      kind: 'company',
      name: `Orbital ${tag} Inc`,
      keys: { domain },
      source: { class: 'manual' },
    })
    expect(first.action).toBe('created')

    const second = await resolveEntity({
      kind: 'company',
      name: `Orbital ${tag} Systems`,
      keys: { domain: `www.orbital-${tag}.com` },
      source: { class: 'import' },
    })
    expect(second.action).toBe('attached')
    expect(second.matchedOn).toBe('domain')
    expect(second.entityId).toBe(first.entityId)
  })

  it('free-mail domain never matches a company', async () => {
    const { resolveEntity } = await import('./resolve')
    const tag = randomUUID().slice(0, 8)
    const a = await resolveEntity({
      kind: 'company',
      name: `FreeMailCo ${tag}`,
      keys: { domain: 'gmail.com' },
      source: { class: 'manual' },
    })
    const b = await resolveEntity({
      kind: 'company',
      name: `OtherCo ${tag}`,
      keys: { domain: 'gmail.com' },
      source: { class: 'manual' },
    })
    // Both created — gmail.com was discarded as an identity key.
    expect(a.action).toBe('created')
    expect(b.action).toBe('created')
    expect(a.entityId).not.toBe(b.entityId)
  })

  it('identity collision on addIdentityAlias becomes a suggestion, not an error', async () => {
    const { resolveEntity, addIdentityAlias } = await import('./resolve')
    const { db } = await import('@spaces/db')
    const { duplicateCandidate } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const holder = await resolveEntity({
      kind: 'company',
      name: `Holder ${tag}`,
      keys: { domain: `holder-${tag}.com` },
      source: { class: 'manual' },
    })
    const claimant = await resolveEntity({
      kind: 'company',
      name: `Claimant ${tag}`,
      source: { class: 'manual' },
    })

    const res = await addIdentityAlias(
      claimant.entityId,
      'domain',
      `holder-${tag}.com`,
      { class: 'import' },
    )
    expect(res.outcome).toBe('suggested_duplicate')

    const [a, b] =
      holder.entityId < claimant.entityId
        ? [holder.entityId, claimant.entityId]
        : [claimant.entityId, holder.entityId]
    const rows = await db
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          eq(duplicateCandidate.entityA, a),
          eq(duplicateCandidate.entityB, b),
        ),
      )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('open')
  })

  it('role emails never become person identity', async () => {
    const { resolveEntity } = await import('./resolve')
    const tag = randomUUID().slice(0, 8)
    const a = await resolveEntity({
      kind: 'person',
      name: `Holder ${tag}`,
      keys: { email: `info@role-${tag}.com` },
      source: { class: 'manual' },
    })
    const b = await resolveEntity({
      kind: 'person',
      name: `Claimant ${tag}`,
      keys: { email: `info@role-${tag}.com` },
      source: { class: 'manual' },
    })
    // Both created — the shared role email was discarded as identity.
    expect(a.action).toBe('created')
    expect(b.action).toBe('created')
    expect(a.entityId).not.toBe(b.entityId)
  })

  it('similar names suggest, never attach', async () => {
    const { resolveEntity } = await import('./resolve')
    const { db } = await import('@spaces/db')
    const { duplicateCandidate } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 6)
    const a = await resolveEntity({
      kind: 'company',
      name: `Quantum Forge Robotics ${tag}`,
      source: { class: 'manual' },
    })
    const b = await resolveEntity({
      kind: 'company',
      name: `Quantum Forge Robotics ${tag} Pvt Ltd`,
      source: { class: 'import' },
    })
    expect(b.action).toBe('created')
    expect(b.entityId).not.toBe(a.entityId)

    const [x, y] =
      a.entityId < b.entityId
        ? [a.entityId, b.entityId]
        : [b.entityId, a.entityId]
    const rows = await db
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          eq(duplicateCandidate.entityA, x),
          eq(duplicateCandidate.entityB, y),
        ),
      )
    expect(rows.length).toBe(1)
    expect(Number(rows[0].score)).toBeGreaterThanOrEqual(0.5)
  })

  it('stamps the provenance pair on the entity and on every alias it writes', async () => {
    const { resolveEntity } = await import('./resolve')
    const { db } = await import('@spaces/db')
    const { entity, entityAlias } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const manual = await resolveEntity({
      kind: 'company',
      name: `Provenance ${tag}`,
      keys: { domain: `provenance-${tag}.com` },
      source: { class: 'manual' },
    })
    const [ent] = await db
      .select({ cls: entity.sourceClass, ref: entity.sourceRef })
      .from(entity)
      .where(eq(entity.id, manual.entityId))
    expect(ent.cls).toBe('manual')
    expect(ent.ref).toBe(null)

    // Two aliases — the identity key and the name — and both carry it.
    // An alias is what actually welds two records together, so an
    // unattributed one is the write worth refusing.
    const aliases = await db
      .select({
        kind: entityAlias.kind,
        cls: entityAlias.sourceClass,
        ref: entityAlias.sourceRef,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, manual.entityId))
    expect(aliases.length).toBe(2)
    expect(aliases.map((a) => a.kind).sort()).toEqual(['domain', 'name'])
    for (const a of aliases) {
      expect(a.cls).toBe('manual')
      expect(a.ref).toBe(null)
    }
  })

  it('an integration source names its integration on the entity and the aliases', async () => {
    const { resolveEntity, addIdentityAlias } = await import('./resolve')
    const { db } = await import('@spaces/db')
    const { entity, entityAlias, integration } =
      await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const [inst] = await db
      .insert(integration)
      .values({ capabilityId: 'apollo', version: '1.0.0' })
      .returning({ id: integration.id })

    const written = await resolveEntity({
      kind: 'company',
      name: `Plugin Co ${tag}`,
      keys: { domain: `pluginco-${tag}.com` },
      source: { class: 'integration', ref: inst.id },
    })
    const [ent] = await db
      .select({ cls: entity.sourceClass, ref: entity.sourceRef })
      .from(entity)
      .where(eq(entity.id, written.entityId))
    expect(ent.cls).toBe('integration')
    expect(ent.ref).toBe(inst.id)

    const aliases = await db
      .select({
        cls: entityAlias.sourceClass,
        ref: entityAlias.sourceRef,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, written.entityId))
    expect(aliases.length).toBe(2)
    for (const a of aliases) {
      expect(a.cls).toBe('integration')
      expect(a.ref).toBe(inst.id)
    }

    // The later enrichment path stamps it too — an alias added after birth
    // is the same kind of claim as one written at birth.
    const added = await addIdentityAlias(
      written.entityId,
      'linkedin',
      `https://www.linkedin.com/company/pluginco-${tag}`,
      { class: 'integration', ref: inst.id },
    )
    expect(added.outcome).toBe('added')
    const [li] = await db
      .select({ cls: entityAlias.sourceClass, ref: entityAlias.sourceRef })
      .from(entityAlias)
      .where(eq(entityAlias.kind, 'linkedin'))
    expect(li.cls).toBe('integration')
    expect(li.ref).toBe(inst.id)
  })
})
