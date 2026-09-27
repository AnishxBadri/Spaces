import type { Attachment } from 'mailparser'

/**
 * Which parts of a message are documents (SPA-115, spec
 * `docs/spec-storage-sources.md` §3.1 entry point 6). Pure: mailparser has
 * already decoded every part into a Buffer, and the only question left is
 * which of them a person would call "the attachment".
 *
 * Two kinds of part are not, and both are skipped before a byte reaches the
 * document pipeline:
 *
 * - **An inline image** — `Content-Disposition: inline` whose Content-ID the
 *   HTML body references as `cid:…`. It is part of how the mail renders (a
 *   logo in the header, a chart pasted into the body), not a file somebody
 *   sent. Both halves are required: Apple Mail marks a real PDF attachment
 *   `inline` too, and it has no `cid:` reference, so it is filed.
 * - **A signature image** — any image under `SIGNATURE_IMAGE_FLOOR_BYTES`.
 *   Outlook attaches the logo and the social icons of every signature as
 *   `image001.png` … with `attachment` disposition and often no reference a
 *   client other than Outlook resolves, so the cid rule alone would file a
 *   dozen of them onto every company a founder writes from. The floor is for
 *   images only: a small PDF or CSV is a genuine attachment at any size.
 *
 * Everything else is filed, whatever its type — the classify lane (SPA-62)
 * is what decides what a document *is*, after extraction.
 */

/**
 * Below this, an image is a signature's logo or icon, not a document. Those
 * run 1–12 KB in practice; a screenshot or a scanned page is well above it.
 */
export const SIGNATURE_IMAGE_FLOOR_BYTES = 16 * 1024

/** A part the pipeline will be handed. */
export type MailAttachment = {
  filename: string
  mime: string | null
  content: Buffer
}

export type AttachmentSkipReason = 'inline-image' | 'signature-image'

export type SortedAttachments = {
  file: Array<MailAttachment>
  skipped: Array<{ filename: string; reason: AttachmentSkipReason }>
}

/** Every `cid:` the HTML body points at, lowercased, brackets stripped. */
export function referencedCids(html: string | false): Set<string> {
  const out = new Set<string>()
  if (html === false) return out
  for (const m of html.matchAll(/cid:\s*<?([^"'\s)>]+)>?/gi)) {
    out.add(decodeCid(m[1]).toLowerCase())
  }
  return out
}

function decodeCid(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** The name a part is filed under when its headers gave none. */
function nameOf(part: Attachment, index: number): string {
  const given = part.filename?.trim()
  return given === undefined || given === ''
    ? `attachment-${String(index + 1)}`
    : given
}

export function sortAttachments(
  parts: ReadonlyArray<Attachment>,
  html: string | false,
): SortedAttachments {
  const cids = referencedCids(html)
  const out: SortedAttachments = { file: [], skipped: [] }
  parts.forEach((part, index) => {
    const filename = nameOf(part, index)
    const isImage = part.contentType.toLowerCase().startsWith('image/')
    const cid = part.cid?.toLowerCase()
    if (
      part.contentDisposition === 'inline' &&
      cid !== undefined &&
      cids.has(cid)
    ) {
      out.skipped.push({ filename, reason: 'inline-image' })
    } else if (isImage && part.content.length < SIGNATURE_IMAGE_FLOOR_BYTES) {
      out.skipped.push({ filename, reason: 'signature-image' })
    } else {
      out.file.push({
        filename,
        mime: part.contentType === '' ? null : part.contentType,
        content: part.content,
      })
    }
  })
  return out
}
