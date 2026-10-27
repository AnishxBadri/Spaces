import type { ShelfDocument } from '#/lib/documents/shelf'

/** The four extraction states, in the words the shelf's exception lane prints. */
export const DOCUMENT_EXTRACTION_LABELS: Record<
  ShelfDocument['extractionStatus'],
  string
> = {
  pending: 'Extracting…',
  done: 'Extracted',
  unsupported: 'No text layer',
  failed: 'Failed',
}
