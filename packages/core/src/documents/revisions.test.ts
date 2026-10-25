import { describe, expect, it } from 'vitest'
import { revisionLedger } from './revisions'

describe('revisionLedger', () => {
  it('is the document alone, current, before any revision', () => {
    expect(
      revisionLedger({
        createdAt: '2026-10-01T10:00:00.000Z',
        currentRevisionId: '7',
        priors: [],
      }),
    ).toEqual([
      {
        rev: 1,
        revisionId: '7',
        at: '2026-10-01T10:00:00.000Z',
        current: true,
      },
    ])
  })

  it('dates each revision from when the one before it was moved past, newest first', () => {
    expect(
      revisionLedger({
        createdAt: '2026-10-01T10:00:00.000Z',
        currentRevisionId: '9',
        priors: [
          { externalRevisionId: null, at: '2026-10-05T08:00:00.000Z' },
          { externalRevisionId: '8', at: '2026-10-10T14:02:00.000Z' },
        ],
      }),
    ).toEqual([
      {
        rev: 3,
        revisionId: '9',
        at: '2026-10-10T14:02:00.000Z',
        current: true,
      },
      {
        rev: 2,
        revisionId: '8',
        at: '2026-10-05T08:00:00.000Z',
        current: false,
      },
      {
        rev: 1,
        revisionId: null,
        at: '2026-10-01T10:00:00.000Z',
        current: false,
      },
    ])
  })
})
