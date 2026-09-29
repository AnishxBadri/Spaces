import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Condition } from '@spaces/core/views/filter'

/**
 * SPA-96. `/companies` and `/people` take views-3's contract, so the two
 * reads behind them get the same three questions `records.test.ts` asks of
 * `/o/$objectSlug`: does the page boundary hold, does `total` count the
 * matching set rather than the loaded rows, and does a row edited out of the
 * filter actually leave.
 *
 * The third is the one this slice added rather than inherited. A cell edit
 * that makes a record stop matching the active view used to be invisible —
 * the row was already in the browser and the filter ran there — so the grid
 * kept a ghost the count would have disagreed with. The route's refresh
 * re-runs this read with the same conditions; the assertion here is that the
 * read is what drops the row, which is the half a component test could not
 * prove.
 */

async function actorId() {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db.select({ id: user.id }).from(user).limit(1)
  return row.id
}

/** A select attribute on a core object, plus its option ids. */
async function stageAttribute(kind: 'company' | 'person') {
  const { Effect } = await import('effect')
  const { createAttributeProgram } =
    await import('@spaces/core/writes/attributes/create')
  const { objectIdForKind } =
    await import('@spaces/core/writes/attributes/objects')
  const { db } = await import('@spaces/db')
  const { attribute } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')

  const objectId = await Effect.runPromise(objectIdForKind(kind))
  const slug = `screen${randomUUID().slice(0, 6)}`
  await Effect.runPromise(
    createAttributeProgram({
      objectId,
      name: slug,
      type: 'select',
      options: [{ label: 'In' }, { label: 'Out' }],
      createdBy: await actorId(),
    }),
  )
  const def = (
    await db
      .select({ slug: attribute.slug, options: attribute.options })
      .from(attribute)
      .where(eq(attribute.objectId, objectId))
  ).find((d) => d.slug === slug)
  return {
    slug,
    inId: def?.options.options?.[0]?.id ?? 'in',
    outId: def?.options.options?.[1]?.id ?? 'out',
  }
}

/** Twenty-five companies, five of them "In", each with one domain alias. */
async function companies(slug: string, inId: string, outId: string) {
  const { db } = await import('@spaces/db')
  const { company, entity, entityAlias } = await import('@spaces/db/schema')

  const tag = randomUUID().slice(0, 8)
  const rows = await db
    .insert(entity)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        kind: 'company' as const,
        canonicalName: `Acme ${tag} ${String(i).padStart(2, '0')}`,
        values: { [slug]: i < 5 ? inId : outId },
      })),
    )
    .returning({ id: entity.id, name: entity.canonicalName })
  await db.insert(company).values(rows.map((r) => ({ entityId: r.id })))
  await db.insert(entityAlias).values(
    rows.map((r, i) => ({
      entityId: r.id,
      kind: 'domain' as const,
      value: `acme${tag}${i}.com`,
      valueNorm: `acme${tag}${i}.com`,
      isIdentity: true,
    })),
  )
  return { tag, rows }
}

/** Twenty-five people, five of them "In", each with one email alias. */
async function people(slug: string, inId: string, outId: string) {
  const { db } = await import('@spaces/db')
  const { entity, entityAlias, person } = await import('@spaces/db/schema')

  const tag = randomUUID().slice(0, 8)
  const rows = await db
    .insert(entity)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        kind: 'person' as const,
        canonicalName: `Ada ${tag} ${String(i).padStart(2, '0')}`,
        values: { [slug]: i < 5 ? inId : outId },
      })),
    )
    .returning({ id: entity.id, name: entity.canonicalName })
  await db.insert(person).values(rows.map((r) => ({ entityId: r.id })))
  await db.insert(entityAlias).values(
    rows.map((r, i) => ({
      entityId: r.id,
      kind: 'email' as const,
      value: `ada${tag}${i}@example.com`,
      valueNorm: `ada${tag}${i}@example.com`,
      isIdentity: true,
    })),
  )
  return { tag, rows }
}

describe('listCompaniesTable — paged, counted and filtered in SQL', () => {
  it('cuts a page on the shared cursor and counts the whole matching set', async () => {
    const { Effect } = await import('effect')
    const { listCompaniesPageProgram } = await import('./directory')
    const { slug, inId, outId } = await stageAttribute('company')
    const { tag } = await companies(slug, inId, outId)

    const byName = { id: 'name', desc: false }
    const page1 = await Effect.runPromise(
      listCompaniesPageProgram([], { sort: byName, limit: 10, q: tag }),
    )
    expect(page1.rows).toHaveLength(10)
    expect(page1.total).toBe(25)
    expect(page1.nextCursor).not.toBeNull()
    // The side queries ran over the page's ids, and every row still got its
    // own domain rather than a slice of one whole-table map.
    expect(page1.rows.every((r) => r.domains.length === 1)).toBe(true)

    const page2 = await Effect.runPromise(
      listCompaniesPageProgram([], {
        sort: byName,
        limit: 10,
        q: tag,
        cursor: page1.nextCursor,
      }),
    )
    expect(page2.rows).toHaveLength(10)
    const seen = new Set(page1.rows.map((r) => r.id))
    expect(page2.rows.filter((r) => seen.has(r.id))).toEqual([])

    const whole = await Effect.runPromise(
      listCompaniesPageProgram([], { sort: byName, limit: 200, q: tag }),
    )
    expect(whole.rows.slice(10, 20).map((r) => r.id)).toEqual(
      page2.rows.map((r) => r.id),
    )
    expect(whole.nextCursor).toBeNull()

    // `total` is the condition's answer, not the page's length.
    const narrowed: Array<Condition> = [{ slug, op: 'is', value: inId }]
    const some = await Effect.runPromise(
      listCompaniesPageProgram(narrowed, { sort: byName, limit: 2, q: tag }),
    )
    expect(some.rows).toHaveLength(2)
    expect(some.total).toBe(5)
  })

  it('narrows the text box on the name or on a domain, and counts that too', async () => {
    const { Effect } = await import('effect')
    const { listCompaniesPageProgram } = await import('./directory')
    const { slug, inId, outId } = await stageAttribute('company')
    const { tag } = await companies(slug, inId, outId)

    const byDomain = await Effect.runPromise(
      listCompaniesPageProgram([], { q: `acme${tag}7.com`, limit: 50 }),
    )
    expect(byDomain.rows).toHaveLength(1)
    expect(byDomain.total).toBe(1)
    expect(byDomain.rows[0].name).toBe(`Acme ${tag} 07`)

    // `%` is a character the reader typed, not syntax matching every row.
    const literal = await Effect.runPromise(
      listCompaniesPageProgram([], { q: '%', limit: 50 }),
    )
    expect(literal.rows).toEqual([])
    expect(literal.total).toBe(0)
  })

  it('drops a row edited out of the active filter, and the count follows', async () => {
    const { Effect } = await import('effect')
    const { listCompaniesPageProgram } = await import('./directory')
    const { setValues } = await import('@spaces/core/writes/attributes/values')
    const { slug, inId, outId } = await stageAttribute('company')
    const { tag } = await companies(slug, inId, outId)

    const conditions: Array<Condition> = [{ slug, op: 'is', value: inId }]
    const before = await Effect.runPromise(
      listCompaniesPageProgram(conditions, { limit: 50, q: tag }),
    )
    expect(before.rows).toHaveLength(5)
    expect(before.total).toBe(5)

    // The cell edit the grid makes, through the one validated write path.
    const stranded = before.rows[0]
    await setValues({
      entityId: stranded.id,
      patch: { [slug]: outId },
      actor: { type: 'user', id: await actorId() },
    })

    // The refetch the route's `refresh` triggers: same conditions, same key.
    const after = await Effect.runPromise(
      listCompaniesPageProgram(conditions, { limit: 50, q: tag }),
    )
    expect(after.rows.map((r) => r.id)).not.toContain(stranded.id)
    expect(after.rows).toHaveLength(4)
    expect(after.total).toBe(before.total - 1)
  })
})

describe('listPeopleTable — paged, counted and filtered in SQL', () => {
  it('cuts a page on the shared cursor and counts the whole matching set', async () => {
    const { Effect } = await import('effect')
    const { listPeoplePageProgram } = await import('./directory')
    const { slug, inId, outId } = await stageAttribute('person')
    const { tag } = await people(slug, inId, outId)

    const byName = { id: 'name', desc: false }
    const page1 = await Effect.runPromise(
      listPeoplePageProgram([], { sort: byName, limit: 10, q: tag }),
    )
    expect(page1.rows).toHaveLength(10)
    expect(page1.total).toBe(25)
    expect(page1.rows.every((r) => r.emails.length === 1)).toBe(true)

    const page2 = await Effect.runPromise(
      listPeoplePageProgram([], {
        sort: byName,
        limit: 10,
        q: tag,
        cursor: page1.nextCursor,
      }),
    )
    const seen = new Set(page1.rows.map((r) => r.id))
    expect(page2.rows.filter((r) => seen.has(r.id))).toEqual([])

    const last = await Effect.runPromise(
      listPeoplePageProgram([], {
        sort: byName,
        limit: 10,
        q: tag,
        cursor: page2.nextCursor,
      }),
    )
    expect(last.rows).toHaveLength(5)
    expect(last.nextCursor).toBeNull()

    const narrowed: Array<Condition> = [{ slug, op: 'is', value: inId }]
    const some = await Effect.runPromise(
      listPeoplePageProgram(narrowed, { sort: byName, limit: 2, q: tag }),
    )
    expect(some.rows).toHaveLength(2)
    expect(some.total).toBe(5)
  })

  it('narrows the text box on an email, and drops a stranded row on refetch', async () => {
    const { Effect } = await import('effect')
    const { listPeoplePageProgram } = await import('./directory')
    const { setValues } = await import('@spaces/core/writes/attributes/values')
    const { slug, inId, outId } = await stageAttribute('person')
    const { tag } = await people(slug, inId, outId)

    const byEmail = await Effect.runPromise(
      listPeoplePageProgram([], { q: `ada${tag}3@example.com`, limit: 50 }),
    )
    expect(byEmail.rows).toHaveLength(1)
    expect(byEmail.rows[0].name).toBe(`Ada ${tag} 03`)

    const conditions: Array<Condition> = [{ slug, op: 'is', value: inId }]
    const before = await Effect.runPromise(
      listPeoplePageProgram(conditions, { limit: 50, q: tag }),
    )
    expect(before.total).toBe(5)

    const stranded = before.rows[0]
    await setValues({
      entityId: stranded.id,
      patch: { [slug]: outId },
      actor: { type: 'user', id: await actorId() },
    })

    const after = await Effect.runPromise(
      listPeoplePageProgram(conditions, { limit: 50, q: tag }),
    )
    expect(after.rows.map((r) => r.id)).not.toContain(stranded.id)
    expect(after.total).toBe(4)
  })
})
