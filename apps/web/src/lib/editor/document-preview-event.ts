/**
 * How a document mention chip asks for a preview (SPA-27).
 *
 * A document has no page by decision — `recordPath` returns null for it — so
 * the chip opens the preview modal instead of navigating. The chip cannot
 * open it itself: `createReactInlineContentSpec` renders inside BlockNote's
 * ProseMirror tree, which sits under no router and under no dialog context,
 * and mounting a Radix dialog in there is the failure mode this event exists
 * to avoid (the editor re-renders the node on every keystroke near it, which
 * would remount the dialog mid-open).
 *
 * So the chip dispatches and the *page* listens. A bubbling DOM CustomEvent
 * is the seam: it leaves the editor through the ordinary DOM, needs no
 * React context on either side, and the listener is one `useEffect` on the
 * route that already owns the modal.
 *
 * The decode is a runtime check rather than a cast because an `Event` handed
 * to a listener carries no proof of who dispatched it — anything on the page
 * may fire this name.
 */

export const DOCUMENT_PREVIEW_EVENT = 'spaces:preview-document'

/** What the chip knows about the document: its entity id, and its label. */
export type DocumentPreviewRequest = {
  entityId: string
  /** The chip's cached filename — a title to show while the row loads. */
  label: string
}

export function documentPreviewEvent(
  detail: DocumentPreviewRequest,
): CustomEvent<DocumentPreviewRequest> {
  return new CustomEvent(DOCUMENT_PREVIEW_EVENT, {
    detail,
    // Out of the editor's subtree and up to the document, where the route
    // listens; `composed` so a future shadow root does not swallow it.
    bubbles: true,
    composed: true,
  })
}

/** The request carried by an event, or null if this one carries none. */
export function documentPreviewRequest(
  event: Event,
): DocumentPreviewRequest | null {
  if (!('detail' in event)) return null
  const detail: unknown = event.detail
  if (detail === null || typeof detail !== 'object') return null
  if (!('entityId' in detail) || !('label' in detail)) return null
  const { entityId, label } = detail
  if (typeof entityId !== 'string' || !entityId) return null
  return { entityId, label: typeof label === 'string' ? label : '' }
}
