/**
 * The **browser lane** of document intake, and the only one that runs in the
 * page: the browser takes the SHA-256 itself through WebCrypto, asks for a
 * URL, and PUTs the bytes straight at storage, so a 200 MB deck never streams
 * through Node (CONTEXT.md → Storage). Only the row is filed through a server
 * fn.
 *
 * The other lane is `#/lib/documents/intake.ts` (SPA-130): bytes that arrive
 * server-side already — the URL clip's PDF response, a
 * plugin filing a document, the Drive walker — where Node holds the buffer and
 * hashes it itself. Two lanes, one writer: both end at
 * `finalizeDocumentUpload`.
 *
 * So this is the one browser hasher — one grep for the WebCrypto digest call
 * lands here and nowhere else; a second copy is a second place to get the
 * secure-context check, the `MAX_UPLOAD_BYTES` guard or the already-stored
 * short circuit subtly wrong (it was two copies until SPA-71 — the Files tab's
 * and the space Sources drop target's).
 *
 * It is also the only **client** module under `lib/documents/` — its
 * neighbours (`space-sources.ts`, `refile.ts`) are server-side Effect modules.
 * It therefore imports from `@spaces/core/documents` and the server-fns barrel
 * and nothing else: no `node:`, no drizzle, no Effect, and it stays outside
 * `lib/server/`.
 */

import {
  MAX_UPLOAD_BYTES,
  formatBytes,
  guessDocumentKind,
} from '@spaces/core/documents'
import { finalizeDocumentUpload, prepareDocumentUpload } from '#/lib/server-fns'

/** What `finalizeDocumentUpload` validates — the source of truth for both. */
type FinalizeInput = Parameters<typeof finalizeDocumentUpload>[0]['data']

/**
 * Where the document is filed — **an array** of targets since SPA-113. A
 * record files through `link(tagged_in)`, a space through `entity_space`; the
 * union is what stops a space ever being a link target again (SPA-19), and
 * the array is what lets one row be filed in N places without copying (§3.4).
 * Both browser surfaces pass one element; the empty array is the unfiled
 * document the global upload dialog will offer.
 *
 * Read off the server fn rather than re-declared, so the two cannot drift.
 */
export type FileAgainst = FinalizeInput['fileAgainst']

/** The three phases a caller renders as a Pending row. */
export type UploadPhase = 'hashing' | 'uploading' | 'filing'

export type UploadDocumentInput = {
  file: File
  fileAgainst: FileAgainst
  /** Defaults to `guessDocumentKind(file.name)`. */
  kind?: FinalizeInput['kind']
  onPhase: (phase: UploadPhase) => void
}

/**
 * Hash → prepare → PUT → finalize. Returns what `finalizeDocumentUpload`
 * returned, so a caller can tell a fresh filing from a dedupe.
 */
export async function uploadDocument({
  file,
  fileAgainst,
  kind,
  onPhase,
}: UploadDocumentInput): Promise<
  Awaited<ReturnType<typeof finalizeDocumentUpload>>
> {
  if (file.size === 0) throw new Error('File is empty')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit`)
  }

  onPhase('hashing')
  const sha = await sha256Hex(file)

  const { uploadUrl, uploadHeaders } = await prepareDocumentUpload({
    data: { sha, sizeBytes: file.size },
  })

  if (uploadUrl) {
    onPhase('uploading')
    // uploadHeaders carry the S3 checksum condition when that driver is
    // live — the signature breaks without them. Empty for local.
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: uploadHeaders,
    })
    if (!response.ok) {
      throw new Error((await response.text()) || 'Storage rejected the upload')
    }
  }

  onPhase('filing')
  return await finalizeDocumentUpload({
    data: {
      sha,
      filename: file.name,
      mime: file.type || null,
      sizeBytes: file.size,
      kind: kind ?? guessDocumentKind(file.name),
      fileAgainst,
    },
  })
}

/**
 * Keys are content addresses, so the browser has to compute one before it
 * can be handed an upload URL. WebCrypto's digest only exists in a secure
 * context — which the app already requires for its own Secure cookies, so
 * say that plainly instead of failing with "undefined is not a function".
 */
export async function sha256Hex(file: File): Promise<string> {
  // The DOM types promise the subtle interface unconditionally; an insecure
  // context does not, and that's exactly the case worth reporting well.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'Uploads need a secure context — serve the app over HTTPS or on localhost',
    )
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
