/**
 * How a document mention chip asks for a preview. A document has no page
 * (`recordPath` is null), so the chip dispatches a bubbling CustomEvent and
 * the route that owns the modal listens.
 * - Never mount the dialog inside the chip: BlockNote's ProseMirror tree has
 *   no router or dialog context and re-renders the node mid-open.
 * - The decode is a runtime check, not a cast: anything on the page may fire this name.
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
