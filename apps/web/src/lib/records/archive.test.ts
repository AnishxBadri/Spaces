import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entitySpace, space } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  archiveRecordProgram,
  recordArchiveProgram,
  restoreRecordProgram,
} from '@spaces/core/writes/entities/archive'
import { companyCountProgram } from '#/lib/integrations/setup-status'
import { searchAllProgram } from '#/lib/search/query'
import { getSpaceProgram } from '#/lib/spaces/read'
import { listCompaniesPageProgram } from '#/lib/views/directory'

/**
 * An archived company, as the app reads it: gone from the Companies list,
 * Cmd-K's search, the space page that files it and Today's company count;
 * still read by its own page's archive read; back in all four on Restore.
 */
describe('an archived record across the app', () => {
  it('leaves the lists, search and Today, and comes back on Restore', async () => {
    const tag = randomUUID().slice(0, 8)
    const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (me === undefined) throw new Error('no fixture user')
    const co = await resolveEntity({
      kind: 'company',
      name: `Shelfco ${tag}`,
      keys: { domain: `shelfco-${tag}.com` },
      source: { class: 'manual' },
    })
    const home = (
      await db.select({ id: space.entityId }).from(space).limit(1)
    ).at(0)
    if (home === undefined) throw new Error('no seeded space')
    await db
      .insert(entitySpace)
      .values({ entityId: co.entityId, spaceId: home.id })

    const run = <TValue, TError>(eff: Effect.Effect<TValue, TError>) =>
      Effect.runPromise(eff)
    const seen = async () => ({
      list: (
        await run(listCompaniesPageProgram([], { q: `Shelfco ${tag}` }))
      ).rows.map((r) => r.id),
      search: (
        await run(searchAllProgram({ userId: me.id, q: `Shelfco ${tag}` }))
      ).map((h) => h.id),
      space: (await run(getSpaceProgram(home.id, me.id))).companies.map(
        (c) => c.id,
      ),
      companies: await run(companyCountProgram()),
    })

    const live = await seen()
    expect(live.list).toEqual([co.entityId])
    expect(live.search).toContain(co.entityId)
    expect(live.space).toContain(co.entityId)

    await run(archiveRecordProgram(me.id, co.entityId))
    const gone = await seen()
    expect(gone.list).toEqual([])
    expect(gone.search).not.toContain(co.entityId)
    expect(gone.space).not.toContain(co.entityId)
    expect(gone.companies).toBe(live.companies - 1)
    // Its own page reads the archive; the filing is kept.
    expect(await run(recordArchiveProgram(co.entityId))).not.toBeNull()
    expect(
      await db
        .select({ id: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, co.entityId)),
    ).toHaveLength(1)

    await run(restoreRecordProgram(me.id, co.entityId))
    expect(await seen()).toEqual(live)
  })
})
