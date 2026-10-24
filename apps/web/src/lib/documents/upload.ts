/**
 * The **browser lane** of document intake: the browser hashes with
 * WebCrypto, asks for a URL and PUTs the bytes straight at storage, so a
 * large deck never streams through Node. Only the row goes through a server
 * fn. Bytes already on the server go through core's intake; both end at
 * `finalizeDocumentUpload`.
 * - The one browser hasher: never add a second copy of the secure-context
 *   check, the `MAX_UPLOAD_BYTES` guard or the already-stored short circuit.
 * - A client module: imports `@spaces/core/documents` and the server-fns
 *   barrel only — no `node:`, no drizzle, no Effect.
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
 * Where the document is filed: **an array** of targets. A record files
 * through `link(tagged_in)`, a space through `entity_space` (never a link
 * target), and the array files one row in N places without copying. The
 * empty array is unfiled.
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
  /** The PUT's progress, 0 to 1; the PUT goes through XHR when it is given. */
  onProgress?: (fraction: number) => void
  /** Aborts the PUT; the upload rejects with an `AbortError`. */
  signal?: AbortSignal
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
  onProgress,
  signal,
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
    if (onProgress === undefined) {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: uploadHeaders,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) {
        throw new Error(
          (await response.text()) || 'Storage rejected the upload',
        )
      }
    } else {
      await putWithProgress(uploadUrl, file, uploadHeaders, onProgress, signal)
    }
  }
  signal?.throwIfAborted()

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

/**
 * The PUT through XHR, the one browser API that reports upload progress.
 * Same request as the fetch lane: the bytes, the storage headers, nothing else.
 */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(xhr.responseText || 'Storage rejected the upload'))
    }
    xhr.onerror = () => reject(new Error('Storage rejected the upload'))
    xhr.onabort = () =>
      reject(new DOMException('The upload was cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}
