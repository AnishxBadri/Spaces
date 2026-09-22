import { describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_BYTES, formatBytes } from '@spaces/core/documents'
import type { FileAgainst } from './upload'
import { sha256Hex, uploadDocument } from './upload'

/**
 * The pure half of the browser lane: the two guards that must refuse before
 * anything touches the network, and the digest itself. The server fns are the
 * other half and need a request, so the assertion here is that neither of them
 * is ever reached — `fetch` is stubbed to throw, which is what a guard that
 * ran late would trip.
 */

/** `File` with a size, without allocating the bytes a 250MB one would. */
function stubFile(name: string, size: number): File {
  const file = new File([], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('uploadDocument guards', () => {
  // One element: the array is SPA-113's widening, and a record surface still
  // files in exactly one place.
  const fileAgainst: FileAgainst = [
    { kind: 'record', entityId: '00000000-0000-4000-8000-000000000001' },
  ]

  it('refuses an empty file before any network call', async () => {
    const onPhase = vi.fn()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('network reached')))

    await expect(
      uploadDocument({ file: stubFile('empty.pdf', 0), fileAgainst, onPhase }),
    ).rejects.toThrow('File is empty')

    expect(onPhase).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('refuses a file over the limit, naming the limit', async () => {
    const onPhase = vi.fn()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('network reached')))

    await expect(
      uploadDocument({
        file: stubFile('huge.pdf', MAX_UPLOAD_BYTES + 1),
        fileAgainst,
        onPhase,
      }),
    ).rejects.toThrow(`Larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`)

    expect(onPhase).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('sha256Hex', () => {
  it('is the content address the blob route re-verifies', async () => {
    // The published SHA-256 of "abc".
    await expect(sha256Hex(new File(['abc'], 'abc.txt'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('digests an empty file too — the size guard is what refuses it', async () => {
    await expect(sha256Hex(new File([], 'empty.txt'))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
