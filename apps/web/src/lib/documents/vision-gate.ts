/**
 * Whether a Files-tab row offers Read with vision (SPA-94). Client-safe and
 * pure, as `offersReadDeck` is, so the rule is one function the row calls,
 * the enqueue checks again, and a test can hold.
 *
 * - `extraction_status` is `unsupported` — a file with no text layer the
 *   extractor could reach. **Not `failed`**: a failed document's problem is
 *   a corrupt file or a bug, not a missing text layer, and a vision model
 *   would only be paid to read the same broken bytes;
 * - there are stored bytes to send (`blobSha`), and they are a PDF — the
 *   one file part the vision lane sends (`lib/ai/vision.ts`);
 * - `routed` is `isLaneRouted('vision')` at the record's resolved
 *   sensitivity, asked once per tab. Unrouted, the button is hidden.
 */
export function visionReadable(doc: {
  extractionStatus: string
  blobSha: string | null
  filename: string | null
  mime: string | null
}): boolean {
  return (
    doc.extractionStatus === 'unsupported' &&
    doc.blobSha !== null &&
    isPdf(doc.filename, doc.mime)
  )
}

export function offersVision(
  doc: Parameters<typeof visionReadable>[0],
  routed: boolean,
): boolean {
  return routed && visionReadable(doc)
}

function isPdf(filename: string | null, mime: string | null): boolean {
  if (filename?.toLowerCase().endsWith('.pdf') === true) return true
  return mime?.toLowerCase().split(';')[0].trim() === 'application/pdf'
}
