import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute } from '@spaces/db/schema'
import type { AttributeOptions } from '../../attributes/registry'
import { objectIdForKindAsync } from './objects'
import { seedSystemAttributes } from './seed'

/** The boot seeder's enrichment-link pass: insert-if-absent, never over the owner. */

const companyAttr = async (slug: string) => {
  const objectId = await objectIdForKindAsync('company')
  const row = (
    await db
      .select({ id: attribute.id, options: attribute.options })
      .from(attribute)
      .where(and(eq(attribute.objectId, objectId), eq(attribute.slug, slug)))
  ).at(0)
  if (!row) throw new Error(`no ${slug}`)
  return row
}

const setOptions = (id: string, options: AttributeOptions) =>
  db.update(attribute).set({ options }).where(eq(attribute.id, id))

describe('seedSystemAttributes, enrichment links', () => {
  it('links a system attribute seeded before the link existed, and keeps an owner’s unlink', async () => {
    const description = await companyAttr('description')
    expect(description.options.enrichmentKey).toBe('company.description')

    await setOptions(description.id, {})
    const location = await companyAttr('location')
    await setOptions(location.id, { enrichmentKey: null })

    await seedSystemAttributes()

    expect((await companyAttr('description')).options.enrichmentKey).toBe(
      'company.description',
    )
    expect((await companyAttr('location')).options.enrichmentKey).toBeNull()
  })
})

const ordered = async (kind: 'company' | 'person' | 'deal') => {
  const objectId = await objectIdForKindAsync(kind)
  return db
    .select({ slug: attribute.slug, sortOrder: attribute.sortOrder })
    .from(attribute)
    .where(eq(attribute.objectId, objectId))
    .orderBy(attribute.sortOrder)
}

describe('seedSystemAttributes, order', () => {
  it('seeds a fresh install with identity and contact first', async () => {
    expect((await ordered('company')).map((r) => r.slug).slice(0, 6)).toEqual([
      'domains',
      'linkedin',
      'funding_stage',
      'business_model',
      'location',
      'founded_year',
    ])
    expect((await ordered('person')).map((r) => r.slug).slice(0, 6)).toEqual([
      'emails',
      'phone',
      'linkedin',
      'twitter',
      'job_title',
      'location',
    ])
    expect((await ordered('deal')).map((r) => r.slug).slice(0, 4)).toEqual([
      'value',
      'close_date',
      'owner',
      'source',
    ])
  })

  it('puts a missing system attribute after everything the object holds, never on a taken order', async () => {
    const objectId = await objectIdForKindAsync('company')
    const before = await ordered('company')
    const top = Math.max(...before.map((r) => r.sortOrder))
    await db
      .delete(attribute)
      .where(
        and(eq(attribute.objectId, objectId), eq(attribute.slug, 'founders')),
      )

    await seedSystemAttributes()

    const after = await ordered('company')
    expect(after.at(-1)).toEqual({ slug: 'founders', sortOrder: top + 10 })
    expect(new Set(after.map((r) => r.sortOrder)).size).toBe(after.length)
  })
})

describe('seedSystemAttributes, long text', () => {
  it('marks the seeded paragraphs long text, on an install seeded without it, and keeps an owner’s switch-off', async () => {
    const description = await companyAttr('description')
    expect(description.options.longText).toBe(true)

    await setOptions(description.id, { enrichmentKey: 'company.description' })
    const location = await companyAttr('location')
    expect(location.options.longText).toBeUndefined()

    await seedSystemAttributes()
    expect((await companyAttr('description')).options.longText).toBe(true)
    expect((await companyAttr('location')).options.longText).toBeUndefined()

    await setOptions(description.id, {
      enrichmentKey: 'company.description',
      longText: false,
    })
    await seedSystemAttributes()
    expect((await companyAttr('description')).options.longText).toBe(false)
  })
})
