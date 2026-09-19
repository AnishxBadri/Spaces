import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupTestEntities } from './test-helpers'

afterAll(async () => {
  if (!process.env.DATABASE_URL) return
  await cleanupTestEntities([
    '^(Quantum Forge Robotics|Claimant|Holder|OtherCo|FreeMailCo) [0-9a-f]{4,8}( .*)?$',
    '^Orbital [0-9a-f]{6,8}( Inc| Systems)?$',
  ])
})

/**
 * Integration tests — run against the dev database (.env.local). Each run
 * uses unique names/domains so reruns don't collide; rows are left behind
 * in dev, which is acceptable until a test-db harness exists.
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('resolveEntity', () => {
  it('creates, then attaches on the same domain', async () => {
    const { resolveEntity } = await import('./resolve')
    const tag = randomUUID().slice(0, 8)
    const domain = `orbital-${tag}.com`

    const first = await resolveEntity({
      kind: 'company',
      name: `Orbital ${tag} Inc`,
      keys: { domain },
      source: 'manual',
    })
    expect(first.action).toBe('created')

    const second = await resolveEntity({
      kind: 'company',
      name: `Orbital ${tag} Systems`,
      keys: { domain: `www.orbital-${tag}.com` },
      source: 'import',
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
      source: 'manual',
    })
    const b = await resolveEntity({
      kind: 'company',
      name: `OtherCo ${tag}`,
      keys: { domain: 'gmail.com' },
      source: 'manual',
    })
    // Both created — gmail.com was discarded as an identity key.
    expect(a.action).toBe('created')
    expect(b.action).toBe('created')
    expect(a.entityId).not.toBe(b.entityId)
  })

  it('identity collision on addIdentityAlias becomes a suggestion, not an error', async () => {
    const { resolveEntity, addIdentityAlias } = await import('./resolve')
    const { db } = await import('#/db')
    const { duplicateCandidate } = await import('#/db/schema')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const holder = await resolveEntity({
      kind: 'company',
      name: `Holder ${tag}`,
      keys: { domain: `holder-${tag}.com` },
      source: 'manual',
    })
    const claimant = await resolveEntity({
      kind: 'company',
      name: `Claimant ${tag}`,
      source: 'manual',
    })

    const res = await addIdentityAlias(
      claimant.entityId,
      'domain',
      `holder-${tag}.com`,
      'apollo',
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
      source: 'manual',
    })
    const b = await resolveEntity({
      kind: 'person',
      name: `Claimant ${tag}`,
      keys: { email: `info@role-${tag}.com` },
      source: 'manual',
    })
    // Both created — the shared role email was discarded as identity.
    expect(a.action).toBe('created')
    expect(b.action).toBe('created')
    expect(a.entityId).not.toBe(b.entityId)
  })

  it('similar names suggest, never attach', async () => {
    const { resolveEntity } = await import('./resolve')
    const { db } = await import('#/db')
    const { duplicateCandidate } = await import('#/db/schema')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 6)
    const a = await resolveEntity({
      kind: 'company',
      name: `Quantum Forge Robotics ${tag}`,
      source: 'manual',
    })
    const b = await resolveEntity({
      kind: 'company',
      name: `Quantum Forge Robotics ${tag} Pvt Ltd`,
      source: 'import',
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
})
