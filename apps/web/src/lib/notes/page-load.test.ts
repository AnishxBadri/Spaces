import { isNotFound } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNotePage } from './page-load'

/**
 * The note page's loader: a note that is not there becomes the route's
 * not-found, and every other failure stays an error for the error screen.
 */

const reads = vi.hoisted(() => ({
  getNote: vi.fn<() => Promise<{ id: string } | null>>(),
  listSpaces: vi.fn(() => Promise.resolve([])),
  listTermsForNote: vi.fn(() => Promise.resolve([])),
}))

vi.mock('#/lib/server-fns', () => reads)

const ID = '7d1c5a3e-2b4f-4c8a-9e6d-0f1a2b3c4d5e'

/** What the loader rejected with, or `null` if it resolved. */
async function rejection(noteId: string): Promise<unknown> {
  try {
    await loadNotePage(noteId)
    return null
  } catch (thrown) {
    return thrown
  }
}

afterEach(() => {
  reads.getNote.mockReset()
})

describe('loadNotePage', () => {
  it('resolves the note with the spaces and terms beside it', async () => {
    reads.getNote.mockResolvedValue({ id: ID })
    await expect(loadNotePage(ID)).resolves.toEqual({
      note: { id: ID },
      allSpaces: [],
      terms: [],
    })
  })

  it('turns a missing note into notFound()', async () => {
    reads.getNote.mockResolvedValue(null)
    expect(isNotFound(await rejection(ID))).toBe(true)
  })

  it('turns an id that is not a uuid into notFound() without a read', async () => {
    expect(isNotFound(await rejection('not-a-note'))).toBe(true)
    expect(reads.getNote).not.toHaveBeenCalled()
  })

  it('lets any other failure through as an error', async () => {
    const failure = new Error('The database did not answer')
    reads.getNote.mockRejectedValue(failure)
    const thrown = await rejection(ID)
    expect(isNotFound(thrown)).toBe(false)
    expect(thrown).toBe(failure)
  })
})
