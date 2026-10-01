import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  duplicateCandidate,
  enrichmentRecord,
  entity,
  entityAlias,
  integration,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Identity, Receipts } from '@spaces/sdk'
import type { IdentityClaim, ReceiptClaim } from '@spaces/sdk'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import { resolveEntity } from '../entities/resolve'
import { IdentityLive } from './identity'
import { ReceiptsLive } from './receipts'

/**
 * Identity and Receipts bound to one integration row (sdk-7a). Every row
 * these ports write must name that row — and nothing a caller passes may
 * change it.
 */

const sent: Array<{ queue: string; data: unknown }> = []
const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data) =>
      Effect.sync(() => {
        sent.push({ queue, data })
        return `job-${sent.length}`
      }),
  }),
)

const boundRow = async (capabilityId = 'apollo') => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const ports = (row: { id: string; capabilityId: string }) =>
  Layer.mergeAll(
    IdentityLive(row).pipe(Layer.provide(EnqueueTest)),
    ReceiptsLive(row),
  )

const run = <TValue>(
  row: { id: string; capabilityId: string },
  program: Effect.Effect<TValue, unknown, Identity | Receipts>,
) => Effect.runPromise(program.pipe(Effect.provide(ports(row))))

const resolve = (claim: IdentityClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Identity).resolve(claim)
  })
const store = (claim: ReceiptClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Receipts).store(claim)
  })

const candidatesBetween = async (a: string, b: string) =>
  (await db.select().from(duplicateCandidate)).filter(
    (c) =>
      (c.entityA === a && c.entityB === b) ||
      (c.entityA === b && c.entityB === a),
  )

describe('Identity.resolve, bound to an integration row', () => {
  it('births the record, its aliases and its activity as the integration', async () => {
    const row = await boundRow()
    const result = await run(
      row,
      resolve({
        kind: 'company',
        keys: { domain: 'https://www.northwind.example/' },
        name: 'Northwind',
      }),
    )
    expect(result.outcome).toBe('created')

    const born = (
      await db.select().from(entity).where(eq(entity.id, result.entityId))
    ).at(0)
    expect(born).toMatchObject({
      sourceClass: 'integration',
      sourceRef: row.id,
    })
    const aliases = await db
      .select()
      .from(entityAlias)
      .where(eq(entityAlias.entityId, result.entityId))
    expect(aliases.length).toBeGreaterThanOrEqual(2)
    for (const a of aliases) {
      expect(a.sourceClass).toBe('integration')
      expect(a.sourceRef).toBe(row.id)
    }

    const acts = await db
      .select()
      .from(activity)
      .where(eq(activity.subjectEntityId, result.entityId))
    expect(acts).toHaveLength(1)
    expect(acts.at(0)).toMatchObject({
      actorId: null,
      verb: 'company.created',
      meta: {
        actorType: 'integration',
        integrationId: row.id,
        capabilityId: 'apollo',
      },
    })
  })

  it('ignores a source a caller tries to smuggle in', async () => {
    const row = await boundRow()
    const other = await boundRow('exa')
    // The claim types carry no source (D52); at runtime an object can carry
    // anything, and the port must not read it.
    const smuggled = {
      kind: 'company' as const,
      keys: { domain: 'smuggle.example' },
      name: 'Smuggle Co',
      source: { class: 'manual' },
      sourceClass: 'manual',
      sourceRef: other.id,
      integrationId: other.id,
    }
    const { entityId } = await run(row, resolve(smuggled))
    const receipt = {
      entityId,
      raw: { ok: true },
      provider: 'not-apollo',
      integrationId: other.id,
    }
    const { receiptId } = await run(row, store(receipt))

    const born = (
      await db.select().from(entity).where(eq(entity.id, entityId))
    ).at(0)
    expect(born).toMatchObject({
      sourceClass: 'integration',
      sourceRef: row.id,
    })
    const stored = (
      await db
        .select()
        .from(enrichmentRecord)
        .where(eq(enrichmentRecord.id, receiptId))
    ).at(0)
    expect(stored).toMatchObject({ integrationId: row.id, provider: 'apollo' })
  })

  it('attaches on a second resolve of the same domain: one entity, one alias, no candidate', async () => {
    const row = await boundRow()
    const claim = {
      kind: 'company' as const,
      keys: { domain: 'twice.example' },
    }
    const first = await run(row, resolve(claim))
    const second = await run(row, resolve({ ...claim, name: 'Twice Inc' }))
    expect(first.outcome).toBe('created')
    expect(second).toEqual({ entityId: first.entityId, outcome: 'attached' })

    const domains = await db
      .select()
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.kind, 'domain'),
          eq(entityAlias.valueNorm, 'twice.example'),
        ),
      )
    expect(domains).toHaveLength(1)
    expect(await db.select().from(duplicateCandidate)).toEqual([])
  })

  it('a key another entity holds becomes a duplicate_candidate, and the existing id comes back', async () => {
    const row = await boundRow()
    // Two records a human made: one holds the domain, the other the LinkedIn.
    const byDomain = await resolveEntity({
      kind: 'company',
      name: 'Stripe',
      keys: { domain: 'stripe.example' },
      source: { class: 'manual' },
    })
    const byLinkedin = await resolveEntity({
      kind: 'company',
      name: 'Stripe Payments',
      keys: { linkedin: 'linkedin.com/company/stripe-example' },
      source: { class: 'manual' },
    })
    const before = (await db.select().from(entity)).length

    const result = await run(
      row,
      resolve({
        kind: 'company',
        keys: {
          domain: 'stripe.example',
          linkedin: 'https://www.linkedin.com/company/stripe-example/',
        },
        name: 'Stripe',
      }),
    )
    expect(result).toEqual({ entityId: byDomain.entityId, outcome: 'attached' })
    expect((await db.select().from(entity)).length).toBe(before)
    expect(
      await candidatesBetween(byDomain.entityId, byLinkedin.entityId),
    ).toHaveLength(1)
  })

  it('addAlias reports each key: added, already its own, or a candidate', async () => {
    const row = await boundRow()
    const held = await resolveEntity({
      kind: 'company',
      name: 'Holder',
      keys: { cin: 'U72900KA2015PTC082988' },
      source: { class: 'manual' },
    })
    const { entityId } = await run(
      row,
      resolve({ kind: 'company', keys: { domain: 'alias.example' } }),
    )
    const result = await run(
      row,
      Effect.gen(function* () {
        return yield* (yield* Identity).addAlias({
          entityId,
          keys: {
            domain: 'alias.example',
            linkedin: 'linkedin.com/company/alias-example',
            cin: 'U72900KA2015PTC082988',
          },
        })
      }),
    )
    expect(result.keys).toEqual([
      { key: 'domain', outcome: 'already_own' },
      { key: 'linkedin', outcome: 'added' },
      { key: 'cin', outcome: 'suggested_duplicate' },
    ])
    expect(await candidatesBetween(entityId, held.entityId)).toHaveLength(1)
    const linkedin = (
      await db
        .select()
        .from(entityAlias)
        .where(
          and(
            eq(entityAlias.entityId, entityId),
            eq(entityAlias.kind, 'linkedin'),
          ),
        )
    ).at(0)
    expect(linkedin).toMatchObject({
      sourceClass: 'integration',
      sourceRef: row.id,
    })
  })
})

describe('Receipts.store', () => {
  it('writes one enrichment_record per call, raw intact, credits when given', async () => {
    const row = await boundRow()
    const { entityId } = await run(
      row,
      resolve({ kind: 'company', keys: { domain: 'receipt.example' } }),
    )
    const raw = {
      organization: {
        name: 'Receipt Co',
        founded_year: 2019,
        tags: ['a', 'b'],
      },
      nested: { deep: [1, { x: null }] },
    }
    const a = await run(row, store({ entityId, raw, creditsUsed: 3 }))
    const b = await run(row, store({ entityId, raw: 'plain text' }))
    expect(a.receiptId).not.toBe(b.receiptId)

    const rows = await db
      .select()
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.entityId, entityId))
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(a.receiptId)).toMatchObject({
      raw,
      creditsUsed: 3,
      integrationId: row.id,
      provider: 'apollo',
    })
    expect(byId.get(b.receiptId)).toMatchObject({
      raw: 'plain text',
      creditsUsed: null,
      integrationId: row.id,
    })
  })
})

describe('the queue seam', () => {
  it('sends a handed-back reembed through core’s Enqueue service', async () => {
    sent.length = 0
    await Effect.runPromise(
      enqueueEmbeds([
        { entityId: 'e-1', sourceKind: 'attribute', sourceKey: 'description' },
      ]).pipe(Effect.provide(EnqueueTest)),
    )
    expect(sent).toEqual([
      {
        queue: QUEUES.embedSource,
        data: {
          entityId: 'e-1',
          sourceKind: 'attribute',
          sourceKey: 'description',
        },
      },
    ])
  })

  it('has no #web/lib/queue specifier anywhere under packages/core', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url))
    const files = readdirSync(src, {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(50)
    // An import of it, static or dynamic — prose may name it.
    const specifier = /(from|import\()\s*'#web\/lib\/queue'/
    const offenders = files.filter((f) =>
      specifier.test(readFileSync(`${src}${f}`, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
