import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@spaces/core/documents'

/**
 * A file added on the Files page, before anything is stored: one over the
 * limit is refused in its row, and one whose bytes are already here stops
 * at the duplicate check. The server fns are stubs, so the assertion is
 * which of them were reached.
 */

const fns = vi.hoisted(() => ({
  findStoredDocument: vi.fn(),
  prepareDocumentUpload: vi.fn(),
  finalizeDocumentUpload: vi.fn(),
}))
vi.mock('#/lib/server-fns', () => fns)

const { addFile, refusalOf } = await import('./arrivals')

/** `File` with a size, without allocating the bytes a 250MB one would. */
function stubFile(name: string, size: number): File {
  const file = new File([], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset()
})

describe('addFile', () => {
  it('refuses a file over the limit before anything is read or stored', async () => {
    const onProgress = vi.fn()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('network reached')))

    const state = await addFile(
      stubFile('Data room.zip', MAX_UPLOAD_BYTES + 1),
      {
        onProgress,
      },
    )

    expect(state).toEqual({ kind: 'refused', reason: 'larger than 250 MB' })
    expect(refusalOf({ size: MAX_UPLOAD_BYTES })).toBeNull()
    expect(fns.findStoredDocument).not.toHaveBeenCalled()
    expect(fns.prepareDocumentUpload).not.toHaveBeenCalled()
    expect(fns.finalizeDocumentUpload).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('stops at `Already here` when the bytes are, asking by their digest', async () => {
    const existing = {
      id: '00000000-0000-4000-8000-000000000001',
      filename: 'Cap table — Oct.xlsx',
      under: 'Exponent',
    }
    fns.findStoredDocument.mockResolvedValue(existing)

    const state = await addFile(new File(['abc'], 'Cap table — Oct (1).xlsx'), {
      onProgress: vi.fn(),
    })

    expect(state).toEqual({ kind: 'already', existing })
    expect(fns.findStoredDocument).toHaveBeenCalledWith({
      data: {
        // The published SHA-256 of "abc": the content, not the name.
        sha: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
    })
    expect(fns.prepareDocumentUpload).not.toHaveBeenCalled()
    expect(fns.finalizeDocumentUpload).not.toHaveBeenCalled()
  })
})
