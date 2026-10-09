import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute } from '@spaces/db/schema'
import type { AttributeOptions } from '../../attributes/registry'
import { objectIdForKindAsync } from './objects'
import { seedSystemAttributes } from './seed'

/** The boot seeder's enrichment-link pass: insert-if-absent, never over the owner. (D76) */

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
