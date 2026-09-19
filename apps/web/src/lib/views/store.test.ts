import { describe, expect, it } from 'vitest'

// The 'view store' half of what used to be views/filter.test.ts. The pure
// condition tests moved to @spaces/core with filter.ts (mono-7); this block
// exercises store.ts against a real database and so stays here, unchanged,
// until mono-8b takes the view store to core as well.

describe('view store', () => {
  it('lists shared + own, guards edits to author or admin', async () => {
    const { Effect } = await import('effect')
    const {
      listViewsProgram,
      saveViewProgram,
      deleteViewProgram,
      ViewForbidden,
    } = await import('./store')
    const { objectIdForKindAsync } = await import('../attributes/objects')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const objectId = await objectIdForKindAsync('company')
    const stranger = {
      id: '00000000-0000-4000-8000-000000000000',
      isAdmin: false,
    }
    const base = {
      objectId,
      filter: [{ slug: 'funding_stage', op: 'is' as const, value: 'seed' }],
      sort: { id: 'name', desc: false },
      columns: { spaces: false },
      extra: {},
    }
    const mine = { id: me.id, isAdmin: false }
    const priv = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Seed watch (private)', visibility: 'private' },
        mine,
      ),
    )
    const shared = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Seed watch (shared)', visibility: 'shared' },
        mine,
      ),
    )
    try {
      const forMe = await Effect.runPromise(listViewsProgram(objectId, me.id))
      expect(forMe.map((v) => v.id)).toEqual(
        expect.arrayContaining([priv.id, shared.id]),
      )
      const forStranger = await Effect.runPromise(
        listViewsProgram(objectId, stranger.id),
      )
      expect(forStranger.map((v) => v.id)).toContain(shared.id)
      expect(forStranger.map((v) => v.id)).not.toContain(priv.id)

      // A stranger can't edit or delete; an admin can.
      await expect(
        Effect.runPromise(
          saveViewProgram(
            { ...base, id: shared.id, name: 'hijack', visibility: 'shared' },
            stranger,
          ),
        ),
      ).rejects.toThrow(ViewForbidden)
      await expect(
        Effect.runPromise(deleteViewProgram(shared.id, stranger)),
      ).rejects.toThrow(ViewForbidden)
      const renamed = await Effect.runPromise(
        saveViewProgram(
          {
            ...base,
            id: shared.id,
            name: 'Seed watch (renamed)',
            visibility: 'shared',
          },
          { ...stranger, isAdmin: true },
        ),
      )
      expect(renamed.name).toBe('Seed watch (renamed)')
      expect(renamed.filter).toEqual(base.filter)
    } finally {
      await Effect.runPromise(deleteViewProgram(priv.id, mine))
      await Effect.runPromise(
        deleteViewProgram(shared.id, { ...mine, isAdmin: true }),
      )
    }
  })
})
