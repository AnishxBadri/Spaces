import type { ShelfDocument } from '#/lib/documents/shelf'

/** The four extraction states, in the words the Extraction column prints. */
export const DOCUMENT_EXTRACTION_LABELS: Record<
  ShelfDocument['extractionStatus'],
  string
> = {
  pending: 'extracting…',
  done: 'extracted',
  unsupported: 'no text layer',
  failed: 'failed',
}
