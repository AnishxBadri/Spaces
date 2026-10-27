import { describe, expect, it, vi } from 'vitest'
import { viewerHeadLine } from './document-preview'

/** The file viewer's head line: the kind in sentence case, and a followed file's provider and revision. */

vi.mock('#/lib/server-fns', () => ({}))

const DECK: Parameters<typeof viewerHeadLine>[0] = {
  id: 'd1',
  filename: 'flent-deck.pdf',
  mime: 'application/pdf',
  sizeBytes: 4_404_019,
  kind: 'deck',
  extractionStatus: 'done',
  extractionError: null,
  blobSha: 'abc',
  url: null,
}

describe('viewerHeadLine', () => {
  it('reads the kind in sentence case, the size and the pages', () => {
    expect(viewerHeadLine(DECK, 'pdf', 14)).toBe('Deck · 4.2 MB · 14 pages')
    expect(viewerHeadLine(DECK, 'pdf', 0)).toBe('Deck · 4.2 MB')
  })

  it('reads a followed file as its type, its provider, its revision and its state', () => {
    expect(
      viewerHeadLine(
        {
          ...DECK,
          filename: 'Flent cap table',
          mime: 'application/vnd.google-apps.spreadsheet',
          kind: 'cap_table',
          externalUrl: 'https://docs.google.com/spreadsheets/d/1aBcD/edit',
          externalStatus: 'linked',
          follow: {
            status: 'active',
            lastSyncedAt: null,
            revisions: 4,
            revisedAt: null,
          },
        },
        null,
        0,
      ),
    ).toBe('Sheet · Drive · rev 4 · following')
  })
})
