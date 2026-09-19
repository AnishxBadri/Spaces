import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * What the /dedupe card says about who wrote a record (SPA-118).
 *
 * The render itself is unproven without a browser; the word it prints is
 * this function's return value, and the interesting half is that
 * `integration` never reaches the card. "integration" is a class, not an
 * answer — the reader installed "apollo" and that is the word they know, so
 * the ref is resolved to its capability id here, server side, once.
 */
describe('provenanceOf', () => {
  it('reads the class for a manually-added company', async () => {
    const { provenanceOf } = await import('./shared')
    const { resolveEntity } = await import('../entities/resolve')
    const tag = randomUUID().slice(0, 8)

    const co = await resolveEntity({
      kind: 'company',
      name: `Handmade ${tag}`,
      source: { class: 'manual' },
    })
    const p = await provenanceOf(co.entityId)
    expect(p.sourceClass).toBe('manual')
    expect(p.sourceCapability).toBe(null)
    expect(p.label).toBe('manual')
  })

  it('names the integration, not the word "integration"', async () => {
    const { provenanceOf } = await import('./shared')
    const { resolveEntity } = await import('../entities/resolve')
    const { db } = await import('@spaces/db')
    const { integration } = await import('@spaces/db/schema')
    const tag = randomUUID().slice(0, 8)

    const [inst] = await db
      .insert(integration)
      .values({ capabilityId: 'apollo', version: '1.0.0' })
      .returning({ id: integration.id })

    const co = await resolveEntity({
      kind: 'company',
      name: `Enriched ${tag}`,
      source: { class: 'integration', ref: inst.id },
    })
    const p = await provenanceOf(co.entityId)
    expect(p.sourceClass).toBe('integration')
    expect(p.sourceCapability).toBe('apollo')
    expect(p.label).toBe('apollo')
  })

  it('keeps the seed class legible too', async () => {
    const { provenanceOf } = await import('./shared')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const tag = randomUUID().slice(0, 8)

    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'company',
        canonicalName: `Seeded ${tag}`,
        sourceClass: 'seed',
      })
      .returning({ id: entity.id })
    expect((await provenanceOf(ent.id)).label).toBe('seed')
  })
})
