import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ServerFns from './server-fns'
import { fileInSpaceAction, newSpaceRow, spaceChoices } from './file-in-space'

/**
 * Cmd-K's File in step: the answers' lanes, and the create row that makes
 * a space named by the query and files the record in it. The server fns
 * are stubbed; what they are called with is the assertion.
 */

const calls = vi.hoisted(() => {
  const created: Array<{ name: string; parentId?: string }> = []
  const tagged: Array<{ entityId: string; spaceId: string }> = []
  return { created, tagged }
})

vi.mock('./server-fns', async (original) => ({
  ...(await original<typeof ServerFns>()),
  listSpaces: async () => SPACES,
  createSpace: async ({
    data,
  }: {
    data: { name: string; parentId?: string }
  }) => {
    calls.created.push(data)
    return { id: 'new-space' }
  },
  tagIntoSpace: async ({
    data,
  }: {
    data: { entityId: string; spaceId: string }
  }) => {
    calls.tagged.push(data)
    return { ok: true }
  },
}))

const SPACES = [
  { id: 'prop', name: 'Proptech', parentId: null, companies: 9 },
  { id: 'ops', name: 'Property ops', parentId: 'prop', companies: 4 },
  { id: 'rent', name: 'Rental tech', parentId: 'prop', companies: 12 },
  { id: 'clim', name: 'Climate', parentId: null, companies: 1 },
]

beforeEach(() => {
  calls.created.length = 0
  calls.tagged.length = 0
})

describe('the File in answers', () => {
  it('checks the filed ones with Filed here, prints the rest as a bare count, and names subspaces', () => {
    expect(
      spaceChoices(SPACES, new Set(['ops'])).map((c) => [
        c.label,
        c.meta,
        c.done ?? false,
      ]),
    ).toEqual([
      ['Proptech', '9 · 2 subspaces', false],
      ['Proptech › Property ops', 'Filed here', true],
      ['Proptech › Rental tech', '12', false],
      ['Climate', '1', false],
    ])
  })
})

describe('the create row', () => {
  it('is offered only when no space is named the query exactly, under the best match’s root', () => {
    const shown = spaceChoices(SPACES, new Set()).filter((c) =>
      c.label.includes('Rental'),
    )
    expect(newSpaceRow('rental tech', shown, SPACES)).toBeNull()
    expect(newSpaceRow('Rentals', shown, SPACES)).toMatchObject({
      name: 'Rentals',
      root: { id: 'prop' },
    })
    expect(newSpaceRow('Fintech', [], SPACES)).toEqual({
      name: 'Fintech',
      root: null,
    })
    expect(newSpaceRow('  ', [], SPACES)).toBeNull()
  })

  it('makes the space, files the record in it, and answers it checked', async () => {
    const action = fileInSpaceAction({
      id: 'flent',
      name: 'Flent',
      filedIds: [],
    })
    if (!('step' in action)) throw new Error('File in is a step')
    const { step } = action
    const choices = await step.choices()
    const shown = choices.filter((c) => c.label.startsWith('Proptech'))
    const create = step.create?.('Rentals', shown)
    expect(create).toMatchObject({
      label: 'New space "Rentals"',
      lane: 'Under Proptech',
    })
    const made = await create?.make()
    expect(calls.created).toEqual([{ name: 'Rentals', parentId: 'prop' }])
    expect(calls.tagged).toEqual([{ entityId: 'flent', spaceId: 'new-space' }])
    expect(made).toEqual({
      id: 'new-space',
      label: 'Proptech › Rentals',
      meta: 'Filed here',
      done: true,
    })
    // Named now: a second ask offers no create row.
    expect(step.create?.('rentals', [])).toBeNull()

    const top = step.create?.('Fintech', [])
    expect(top?.lane).toBe('Top level')
    await top?.make()
    expect(calls.created.at(-1)).toEqual({ name: 'Fintech' })
  })
})
