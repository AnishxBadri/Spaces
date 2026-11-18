import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * An edit goes through `updateTerm`'s own validator and patch, then the
 * writer: a field the edit leaves out keeps what is stored, and one it sends
 * empty is saved empty. Imports are dynamic: `@spaces/db` builds its pool
 * from `DATABASE_URL`, which the setup file rewrites per file.
 */

async function deps() {
  const { eq } = await import('drizzle-orm')
  const { db } = await import('@spaces/db')
  const { term } = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const { createTermProgram, updateTermProgram } = await import('./write-term')
  const { input } = await import('#/lib/server/input')
  const { createTermInput, termPatchOf, updateTermInput } =
    await import('./term-input')

  const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!me) throw new Error('the test seed has no user')

  const create = (data: typeof createTermInput.Encoded) => {
    const decoded = input(createTermInput)(data)
    return Effect.runPromise(
      createTermProgram(me.id, {
        name: decoded.name,
        aliases: [...decoded.aliases],
        definitionMd: decoded.definitionMd,
        spaceId: decoded.spaceId ?? null,
      }),
    )
  }
  const update = (data: typeof updateTermInput.Encoded) =>
    Effect.runPromise(
      updateTermProgram(termPatchOf(input(updateTermInput)(data))),
    )

  const termRow = async (id: string) =>
    (
      await db
        .select({
          name: term.name,
          aliases: term.aliases,
          definitionMd: term.definitionMd,
        })
        .from(term)
        .where(eq(term.entityId, id))
    ).at(0)

  return { create, update, termRow }
}

describe('updateTerm input', () => {
  it('keeps the aliases and definition an edit of the name leaves out', async () => {
    const d = await deps()
    const { id } = await d.create({
      name: 'Power Usage Effectiveness',
      aliases: ['PUE'],
      definitionMd: 'Facility power over IT power.',
    })

    await d.update({ id, name: 'Power usage effectiveness' })

    expect(await d.termRow(id)).toEqual({
      name: 'Power usage effectiveness',
      aliases: ['PUE'],
      definitionMd: 'Facility power over IT power.',
    })
  })

  it('saves a definition cleared on purpose as empty', async () => {
    const d = await deps()
    const { id } = await d.create({
      name: 'Capacity factor',
      aliases: ['CF'],
      definitionMd: 'Output over nameplate.',
    })

    await d.update({ id, definitionMd: '' })

    expect(await d.termRow(id)).toEqual({
      name: 'Capacity factor',
      aliases: ['CF'],
      definitionMd: '',
    })
  })

  it('still defaults an absent list and definition to empty on create', async () => {
    const d = await deps()
    const { id } = await d.create({ name: 'Pro-rata' })

    expect(await d.termRow(id)).toEqual({
      name: 'Pro-rata',
      aliases: [],
      definitionMd: '',
    })
  })
})
