import { describe, expect, it } from 'vitest'
import { offersVision } from './vision-gate'

/** SPA-94: which Files-tab rows offer Read with vision. */

const scan = {
  extractionStatus: 'unsupported',
  blobSha: 'abc123',
  filename: 'Acme deck (scanned).pdf',
  mime: 'application/pdf',
}

describe('offersVision', () => {
  it('is offered on a stored PDF at unsupported with the vision lane routed', () => {
    expect(offersVision(scan, true)).toBe(true)
    // A PDF by its type alone, whatever it is called.
    expect(offersVision({ ...scan, filename: 'IMG_0412' }, true)).toBe(true)
  })

  it('is hidden with the vision lane unrouted', () => {
    expect(offersVision(scan, false)).toBe(false)
  })

  it('is absent on a failed document — its problem is not a missing text layer', () => {
    expect(offersVision({ ...scan, extractionStatus: 'failed' }, true)).toBe(
      false,
    )
  })

  it('is absent on every other status', () => {
    for (const extractionStatus of ['pending', 'done'])
      expect(offersVision({ ...scan, extractionStatus }, true)).toBe(false)
  })

  it('is absent with no stored bytes, or bytes that are not a PDF', () => {
    expect(offersVision({ ...scan, blobSha: null }, true)).toBe(false)
    expect(
      offersVision(
        { ...scan, filename: 'whiteboard.jpg', mime: 'image/jpeg' },
        true,
      ),
    ).toBe(false)
  })
})
