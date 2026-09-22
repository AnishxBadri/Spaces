import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const ASOF = '2026-09-10T00:00:00Z'

/**
 * `recordContextProgram` is exactly what `getRecordContext` runs once it has
 * the session user and the clock (`lib/server/context.ts`), so the server
 * fn's privacy guarantee is asserted here, without a request: a teammate's
 * private note reaches its author and nobody else, and every item leaves
 * with a human citation.
 */
describe('recordContextProgram', () => {
  const tag = randomUUID().slice(0, 8)

  it('returns ranked, cited items and hides a private note from the other user', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity, link, note } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const { resolveEntity } = await import('#/lib/entities/resolve')
    const { recordContextProgram } = await import('./record')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [teammate] = await db
      .insert(user)
      .values({
        id: `rc-teammate-${tag}`,
        name: `Teammate ${tag}`,
        email: `rc-teammate-${tag}@example.test`,
      })
      .returning({ id: user.id })

    const co = await resolveEntity({
      kind: 'company',
      name: `RcCo ${tag}`,
      keys: { domain: `rcco-${tag}.com` },
      source: { class: 'manual' },
    })
    await db
      .update(entity)
      .set({ values: { funding_stage: 'seed' } })
      .where(eq(entity.id, co.entityId))

    const mkNote = async (
      title: string,
      authorId: string,
      visibility: 'shared' | 'private',
    ) => {
      const [e] = await db
        .insert(entity)
        .values({ kind: 'note', canonicalName: title })
        .returning({ id: entity.id })
      await db.insert(note).values({
        entityId: e.id,
        title,
        bodyMd: `${title} body`,
        kind: 'note',
        authorId,
        visibility,
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      })
      await db.insert(link).values({
        fromEntityId: e.id,
        toEntityId: co.entityId,
        relation: 'mentions',
        source: 'manual',
      })
      return e.id
    }
    const shared = await mkNote('Call notes', me.id, 'shared')
    const priv = await mkNote('Private doubts', teammate.id, 'private')

    const run = (userId: string) =>
      Effect.runPromise(
        recordContextProgram({
          entityId: co.entityId,
          user: { id: userId },
          asOf: ASOF,
          budgetChars: 8000,
        }),
      )

    const mine = await run(me.id)
    const refs = mine.items.map((i) => i.ref)
    expect(mine.seed.id).toBe(co.entityId)
    expect(refs).toContain(`note:${shared}`)
    expect(refs).not.toContain(`note:${priv}`)
    expect(mine.items.every((i) => !i.text.includes('Private doubts'))).toBe(
      true,
    )

    const theirs = await run(teammate.id)
    expect(theirs.items.map((i) => i.ref)).toContain(`note:${priv}`)

    // every item carries a citation a person can read, and its age
    const noteItem = mine.items.find((i) => i.ref === `note:${shared}`)
    expect(noteItem?.cite).toBe('Call notes')
    expect(noteItem?.sinceMs).toBe(9 * 86_400_000)
    const stage = mine.items.find(
      (i) => i.ref === `attr:${co.entityId}:funding_stage`,
    )
    expect(stage?.cite).toBe(`Funding stage on RcCo ${tag}`)
    expect(stage?.sinceMs).toBeNull()

    // deterministic on (data, asOf, user)
    expect(await run(me.id)).toEqual(mine)
  })

  it('returns no items for a bare record, which the section reads as "nothing yet"', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { recordContextProgram } = await import('./record')

    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const [bare] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Bare ${tag}` })
      .returning({ id: entity.id })

    const out = await Effect.runPromise(
      recordContextProgram({
        entityId: bare.id,
        user: { id: me.id },
        asOf: ASOF,
        budgetChars: 8000,
      }),
    )
    expect(out.items).toEqual([])
  })

  it('rejects an unknown record with ContextEntityNotFound', async () => {
    const { Effect, Exit } = await import('effect')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const { recordContextProgram } = await import('./record')
    const [me] = await db.select({ id: user.id }).from(user).limit(1)

    const exit = await Effect.runPromiseExit(
      recordContextProgram({
        entityId: randomUUID(),
        user: { id: me.id },
        asOf: ASOF,
        budgetChars: 8000,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('ContextEntityNotFound')
  })
})
