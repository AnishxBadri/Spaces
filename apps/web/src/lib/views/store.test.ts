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
    const target = { surface: 'object' as const, objectId }
    const stranger = {
      id: '00000000-0000-4000-8000-000000000000',
      isAdmin: false,
    }
    const base = {
      ...target,
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
      const forMe = await Effect.runPromise(listViewsProgram(target, me.id))
      expect(forMe.map((v) => v.id)).toEqual(
        expect.arrayContaining([priv.id, shared.id]),
      )
      const forStranger = await Effect.runPromise(
        listViewsProgram(target, stranger.id),
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
        Effect.runPromise(
          deleteViewProgram({ id: shared.id, surface: 'object' }, stranger),
        ),
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
      await Effect.runPromise(
        deleteViewProgram({ id: priv.id, surface: 'object' }, mine),
      )
      await Effect.runPromise(
        deleteViewProgram(
          { id: shared.id, surface: 'object' },
          { ...mine, isAdmin: true },
        ),
      )
    }
  })

  // views-1 (D2): the surface discriminator. An object view keeps its
  // object_id and keeps listing under the object target — which is what
  // /companies, /people, /deals and /o/$objectSlug read on first paint.
  it('lists an object view under its object target only', async () => {
    const { Effect } = await import('effect')
    const { listViewsProgram, saveViewProgram } = await import('./store')
    const { objectIdForKindAsync } = await import('../attributes/objects')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const mine = { id: me.id, isAdmin: false }
    const companies = await objectIdForKindAsync('company')
    const people = await objectIdForKindAsync('person')

    const saved = await Effect.runPromise(
      saveViewProgram(
        {
          surface: 'object',
          objectId: companies,
          name: 'Seed watch',
          filter: [{ slug: 'funding_stage', op: 'is', value: 'seed' }],
          sort: { id: 'name', desc: false },
          columns: { spaces: false },
          extra: {},
          visibility: 'shared',
        },
        mine,
      ),
    )
    expect(saved.surface).toBe('object')
    expect(saved.objectId).toBe(companies)

    const onCompanies = await Effect.runPromise(
      listViewsProgram({ surface: 'object', objectId: companies }, me.id),
    )
    const found = onCompanies.find((v) => v.id === saved.id)
    // First paint reads exactly this row: the filter, sort and columns the
    // page applies before it renders.
    expect(found?.filter).toEqual([
      { slug: 'funding_stage', op: 'is', value: 'seed' },
    ])
    expect(found?.sort).toEqual({ id: 'name', desc: false })
    expect(found?.columns).toEqual({ spaces: false })

    // Not another object's list, and not the document surface.
    const onPeople = await Effect.runPromise(
      listViewsProgram({ surface: 'object', objectId: people }, me.id),
    )
    expect(onPeople.map((v) => v.id)).not.toContain(saved.id)
    const onDocuments = await Effect.runPromise(
      listViewsProgram({ surface: 'document' }, me.id),
    )
    expect(onDocuments.map((v) => v.id)).not.toContain(saved.id)
  })

  it('round-trips a document view with a null object_id', async () => {
    const { Effect } = await import('effect')
    const {
      listViewsProgram,
      saveViewProgram,
      deleteViewProgram,
      ViewForbidden,
      ViewNotFound,
    } = await import('./store')
    const { objectIdForKindAsync } = await import('../attributes/objects')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [me] = await db.select({ id: user.id }).from(user).limit(1)
    const mine = { id: me.id, isAdmin: false }
    const stranger = {
      id: '00000000-0000-4000-8000-000000000000',
      isAdmin: false,
    }
    const documents = { surface: 'document' as const }
    const base = {
      ...documents,
      filter: [{ slug: 'kind', op: 'is' as const, value: 'deck' }],
      sort: { id: 'createdAt', desc: true },
      columns: { size: false },
      extra: {},
    }

    const priv = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Decks (private)', visibility: 'private' },
        mine,
      ),
    )
    const shared = await Effect.runPromise(
      saveViewProgram(
        { ...base, name: 'Decks (shared)', visibility: 'shared' },
        mine,
      ),
    )
    // The CHECK's other half: a document view carries no object row.
    expect(priv.surface).toBe('document')
    expect(priv.objectId).toBeNull()
    expect(shared.objectId).toBeNull()

    // Visibility behaves exactly as on object views.
    const forMe = await Effect.runPromise(listViewsProgram(documents, me.id))
    expect(forMe.map((v) => v.id)).toEqual(
      expect.arrayContaining([priv.id, shared.id]),
    )
    const forStranger = await Effect.runPromise(
      listViewsProgram(documents, stranger.id),
    )
    expect(forStranger.map((v) => v.id)).toContain(shared.id)
    expect(forStranger.map((v) => v.id)).not.toContain(priv.id)

    // And so does the author/admin guard.
    await expect(
      Effect.runPromise(
        saveViewProgram(
          { ...base, id: shared.id, name: 'hijack', visibility: 'shared' },
          stranger,
        ),
      ),
    ).rejects.toThrow(ViewForbidden)
    await expect(
      Effect.runPromise(
        deleteViewProgram({ id: shared.id, surface: 'document' }, stranger),
      ),
    ).rejects.toThrow(ViewForbidden)

    // A surface cannot reach another surface's view by id.
    const companies = await objectIdForKindAsync('company')
    const objectView = await Effect.runPromise(
      saveViewProgram(
        {
          surface: 'object',
          objectId: companies,
          name: 'Seed watch',
          filter: [],
          sort: null,
          columns: {},
          extra: {},
          visibility: 'shared',
        },
        mine,
      ),
    )
    await expect(
      Effect.runPromise(
        deleteViewProgram({ id: objectView.id, surface: 'document' }, mine),
      ),
    ).rejects.toThrow(ViewNotFound)

    const renamed = await Effect.runPromise(
      saveViewProgram(
        {
          ...base,
          id: shared.id,
          name: 'Decks (renamed)',
          visibility: 'shared',
        },
        { ...stranger, isAdmin: true },
      ),
    )
    expect(renamed.name).toBe('Decks (renamed)')
    expect(renamed.objectId).toBeNull()

    await Effect.runPromise(
      deleteViewProgram({ id: priv.id, surface: 'document' }, mine),
    )
    await Effect.runPromise(
      deleteViewProgram(
        { id: shared.id, surface: 'document' },
        { ...mine, isAdmin: true },
      ),
    )
    const left = await Effect.runPromise(listViewsProgram(documents, me.id))
    expect(left.map((v) => v.id)).not.toContain(priv.id)
    expect(left.map((v) => v.id)).not.toContain(shared.id)
  })
})
