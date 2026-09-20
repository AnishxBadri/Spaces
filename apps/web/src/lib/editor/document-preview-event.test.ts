import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_PREVIEW_EVENT,
  documentPreviewEvent,
  documentPreviewRequest,
} from './document-preview-event'

/**
 * The seam between a mention chip and the page that owns the modal (SPA-27).
 *
 * Worth its own test because both halves are written in files that cannot
 * see each other's types at runtime: the chip builds a DOM event, the route
 * reads one back off a listener whose parameter is a bare `Event`. The decode
 * is the contract, and it is a check rather than a cast — the listener is on
 * `document`, so anything on the page can reach it.
 */

describe('the document preview request', () => {
  it('survives the round trip through a DOM event', () => {
    const detail = { entityId: 'e3f2a0d6', label: 'Series B deck.pdf' }
    const event = documentPreviewEvent(detail)

    expect(event.type).toBe(DOCUMENT_PREVIEW_EVENT)
    // It has to leave the editor's subtree to reach the route's listener.
    expect(event.bubbles).toBe(true)
    expect(documentPreviewRequest(event)).toEqual(detail)
  })

  it('reads nothing off an event that carries nothing', () => {
    expect(documentPreviewRequest(new Event(DOCUMENT_PREVIEW_EVENT))).toBeNull()
    expect(
      documentPreviewRequest(
        new CustomEvent(DOCUMENT_PREVIEW_EVENT, { detail: 'a deck' }),
      ),
    ).toBeNull()
    expect(
      documentPreviewRequest(
        new CustomEvent(DOCUMENT_PREVIEW_EVENT, { detail: { label: 'deck' } }),
      ),
    ).toBeNull()
    // An empty id would open a preview of nothing.
    expect(
      documentPreviewRequest(
        new CustomEvent(DOCUMENT_PREVIEW_EVENT, {
          detail: { entityId: '', label: 'deck' },
        }),
      ),
    ).toBeNull()
  })

  it('tolerates a missing label rather than refusing the request', () => {
    // The label is a cached display string; the id is the authority, and a
    // chip inserted before the label existed must still open its document.
    expect(
      documentPreviewRequest(
        new CustomEvent(DOCUMENT_PREVIEW_EVENT, {
          detail: { entityId: 'e3f2a0d6', label: 7 },
        }),
      ),
    ).toEqual({ entityId: 'e3f2a0d6', label: '' })
  })
})
